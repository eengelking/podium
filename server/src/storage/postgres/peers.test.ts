// The peer service over the PostgreSQL storage (#822): the read-then-write sequences that were atomic under the SQLite lock must stay so
// with every call awaited, in and out of a transaction. The reporter lookup is a hand-written one.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { peerStoreOver } from './peers.js';
import { fakeReporters } from './peerTesting.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';
import type { PeerStoreApi } from '../types.js';
import type { Actor, MessageTrail, Refusal, RightsTrail, SendOutcome } from '../../fleet/peerTypes.js';
import type { Report } from '../../fleet/protocol.js';

const T0 = 1_800_000_000_000;
const ED: Actor = { name: 'ed', admin: false };

interface World {
  peers: PeerStoreApi;
  trails: MessageTrail[];
  keys: { a: string; b: string };
  tick: (ms?: number) => number;
}

const report = (name: string, machine: string, status = 'waiting'): Report =>
  ({ session: { name, status, waitReason: status === 'waiting' ? 'input' : null, peers: true, repoName: null, projectRoot: '~/dev' }, machine: { name: machine, os: 'macOS' } }) as unknown as Report;

const sent = (r: SendOutcome | Refusal): SendOutcome => {
  if (!r.ok) throw new Error(`refused: ${r.status} ${r.error}`);
  return r;
};

describe.skipIf(!TEST_PG)('postgres peer store', () => {
  let td: TestDatabase;
  let db: PgDb;
  beforeAll(async () => {
    td = await createTestDatabase();
    db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 4, name: 'test' });
    await migrate(db, MAIN_SCHEMA, MAIN_STEPS);
  });
  afterAll(async () => {
    await db.close();
    await td.drop();
  });
  afterEach(async () => {
    await db.drain();
  });

  const rows = (sql: string, ...args: (string | number)[]) => db.all<Record<string, unknown>>(sql, args);

  const session = (id: string) =>
    db.run(`INSERT INTO sessions (id, name, status, started_at, last_seen_at, cwd, owner) VALUES (?, ?, 'waiting', ?, ?, '~/dev', 'ed')`, [id, id, T0, T0]);

  /** Two of Ed's reporters, each with a live orchestrator waiting for its person (idle), and a right to send from a to b of `ab` (and b to a of `ba`). */
  async function world(ab: 'ask' | 'send' = 'ask', ba: 'ask' | 'send' | 'none' = 'send'): Promise<World> {
    await db.exec('TRUNCATE peer_messages, peer_requests, peer_rights, peer_owner_settings, settings, admin_log, sessions CASCADE');
    let now = T0;
    const fake = fakeReporters(T0);
    for (const k of ['a', 'b']) fake.reps.set(k, { key: k, machine: `box-${k}`, owner: 'ed', adminSecret: false, os: 'macOS', peers: true, version: '1.4.0' });
    const peers = peerStoreOver(db, fake.lookup, { now: () => now, flagOn: () => true, startedAt: T0 });
    const trails: MessageTrail[] = [];
    peers.onMessage = (t) => void trails.push(t);
    await session('sa');
    await session('sb');
    await peers.note('sa', 'a', 'ed', report('alpha', 'box-a'));
    await peers.note('sb', 'b', 'ed', report('beta', 'box-b'));
    await peers.rights.setRight('ed', 'a', 'b', ab, ED);
    if (ba !== 'none') await peers.rights.setRight('ed', 'b', 'a', ba, ED);
    return { peers, trails, keys: { a: 'a', b: 'b' }, tick: (ms = 1) => (now += ms) };
  }

  describe('peer store: approve is one step', () => {
    it('delivers a message once when the owner answers twice at the same time', async () => {
      const w = await world('ask');
      const out = sent(await w.peers.messages.send('sa', 'beta@box-b', 'hello'));
      expect(out.state).toBe('approval');
      const [x, y] = await Promise.all([w.peers.answer(out.requestId!, 'ed', 'deliver', ED), w.peers.answer(out.requestId!, 'ed', 'deliver', ED)]);
      expect([x.ok, y.ok].sort()).toEqual([false, true]);
      const refused = (x.ok ? y : x) as Refusal;
      expect(refused.status).toBe(410);
      expect(w.trails.filter((t) => t.kind === 'approved')).toHaveLength(1);
      const reply = await w.peers.replyFor('sb', true);
      expect(reply.peerDeliveries.filter((d) => d.kind === 'message')).toHaveLength(1);
      // Once the receiver says it took the message, a later poll finds nothing left to hand over.
      const id = reply.peerDeliveries[0]!.id;
      expect(await w.peers.messages.result('sb', id, 'took')).toBe('new');
      expect((await w.peers.replyFor('sb', true)).peerDeliveries.filter((d) => d.kind === 'message')).toHaveLength(0);
    });

    it.each([
      ['the answer first', true],
      ['the removal first', false],
    ])('never delivers after the link is removed (%s)', async (_name, answerFirst) => {
      const w = await world('ask');
      const out = sent(await w.peers.messages.send('sa', 'beta@box-b', 'secret plan'));
      const answer = () => w.peers.answer(out.requestId!, 'ed', 'deliver', ED);
      const remove = () => w.peers.removeLink('ed', w.keys.a, w.keys.b, ED);
      await Promise.all(answerFirst ? [answer(), remove()] : [remove(), answer()]);
      const reply = await w.peers.replyFor('sb', true);
      expect(reply.peerDeliveries.filter((d) => d.kind === 'message')).toHaveLength(0);
      expect(await rows('SELECT state, why FROM peer_messages')).toEqual([{ state: 'dropped', why: 'link-removed' }]);
      expect((await rows('SELECT closed_at FROM peer_requests WHERE kind = ?', 'message')).every((r) => r.closed_at !== null)).toBe(true);
    });

    it('holds a delivered message back when the link is paused at the same time', async () => {
      const w = await world('ask');
      const out = sent(await w.peers.messages.send('sa', 'beta@box-b', 'hello'));
      await Promise.all([w.peers.answer(out.requestId!, 'ed', 'deliver', ED), w.peers.rights.pauseLink('ed', w.keys.a, w.keys.b, true, ED)]);
      expect((await w.peers.replyFor('sb', true)).peerDeliveries.filter((d) => d.kind === 'message')).toHaveLength(0);
      await w.peers.rights.pauseLink('ed', w.keys.a, w.keys.b, false, ED);
      expect((await w.peers.replyFor('sb', true)).peerDeliveries.filter((d) => d.kind === 'message')).toHaveLength(1);
    });

    it('says in the same step whether the link was paused when the message was delivered', async () => {
      const w = await world('ask');
      const out = sent(await w.peers.messages.send('sa', 'beta@box-b', 'hello'));
      await w.peers.rights.pauseLink('ed', w.keys.a, w.keys.b, true, ED);
      const done = await w.peers.answerPaused(out.requestId!, 'ed', 'deliver', ED);
      expect(done.out.ok).toBe(true);
      expect(done.paused).toBe(true);
      expect((await w.peers.answerPaused(out.requestId!, 'ed', 'deliver', ED)).paused).toBe(false);
    });
  });

  describe('peer store: sends and the rate limit', () => {
    it('lets through exactly the per-minute limit when many sends start at once', async () => {
      const w = await world('send', 'send');
      expect((await w.peers.settings.set({ perMinute: 3 })).ok).toBe(true);
      const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => w.peers.messages.send('sa', 'beta@box-b', `m${i}`)));
      expect(outs.filter((o) => o.ok)).toHaveLength(3);
      expect(outs.filter((o) => !o.ok).map((o) => (o as Refusal).status)).toEqual([429, 429, 429, 429, 429]);
      expect(await rows('SELECT COUNT(*) AS n FROM peer_messages')).toEqual([{ n: 3 }]);
    });

    it('numbers the messages in the order they were sent, so a tie on the second keeps its order', async () => {
      const w = await world('send', 'send');
      await w.peers.settings.set({ perMinute: 20 });
      await Promise.all(Array.from({ length: 6 }, (_, i) => w.peers.messages.send('sa', 'beta@box-b', `m${i}`)));
      const seqs = (await rows('SELECT seq FROM peer_messages ORDER BY seq')).map((r) => r.seq);
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
      expect((await w.peers.messages.conversation('sa', 'sb')).map((m) => m.text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
    });

    it('counts round trips in step with the sends that cause them', async () => {
      const w = await world('send', 'send');
      await w.peers.settings.set({ roundTrips: 1 });
      const outs = await Promise.all([w.peers.messages.send('sa', 'beta@box-b', '1'), w.peers.messages.send('sb', 'alpha@box-a', '2'), w.peers.messages.send('sa', 'beta@box-b', '3')]);
      // The third send comes after one change of direction and one more: it is held for approval rather than delivered.
      expect(outs.map((o) => (o as SendOutcome).state)).toEqual(['sent', 'sent', 'approval']);
    });

    it('waits for an open transaction, and keeps a send made meanwhile when that transaction rolls back', async () => {
      const w = await world('send', 'send');
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const tx = db.tx(async () => {
        await db.run("INSERT INTO admin_log (t, kind, detail, source, actor) VALUES (?, 'kind', 'inside', 'src', 'ed')", [T0]);
        await gate;
        throw new Error('abandoned');
      });
      const failed = tx.catch((e: Error) => e.message);
      const send = w.peers.messages.send('sa', 'beta@box-b', 'kept');
      await new Promise((r) => setTimeout(r, 50));
      try {
        // Not yet stored: the send is queued behind the transaction, not running inside it.
        expect(await rows('SELECT COUNT(*) AS n FROM peer_messages')).toEqual([{ n: 0 }]);
      } finally {
        release();
      }
      expect(await failed).toBe('abandoned');
      expect((await send).ok).toBe(true);
      expect(await rows('SELECT text FROM peer_messages')).toEqual([{ text: 'kept' }]);
      expect(await rows('SELECT COUNT(*) AS n FROM admin_log')).toEqual([{ n: 0 }]);
    });
  });

  describe('peer store: ended and deleted sessions', () => {
    it('leaves no held message and no open request when the receiver ends while a send is made, either way round', async () => {
      for (const sendFirst of [true, false]) {
        const w = await world('ask');
        const send = () => w.peers.messages.send('sa', 'beta@box-b', 'hello');
        const end = () => w.peers.ended('sb');
        await Promise.all(sendFirst ? [send(), end()] : [end(), send()]);
        expect(await rows("SELECT id FROM peer_messages WHERE state IN ('approval', 'ready', 'handed', 'queued')")).toEqual([]);
        expect(await rows('SELECT id FROM peer_requests WHERE closed_at IS NULL')).toEqual([]);
      }
    });

    it('removes every message of a deleted session and closes the requests that waited on them', async () => {
      const w = await world('ask');
      const out = sent(await w.peers.messages.send('sa', 'beta@box-b', 'hello'));
      await Promise.all([w.peers.deleted(['sb']), w.peers.messages.send('sa', 'beta@box-b', 'later')]);
      expect(await rows('SELECT id FROM peer_messages')).toEqual([]);
      expect(await rows('SELECT id FROM peer_requests WHERE closed_at IS NULL')).toEqual([]);
      expect((await w.peers.answer(out.requestId!, 'ed', 'deliver', ED)).ok).toBe(false);
      await w.peers.deleted([]);
    });

    it('forgets a session that reports done, and drops what waited for it', async () => {
      const w = await world('ask');
      sent(await w.peers.messages.send('sa', 'beta@box-b', 'hello'));
      await w.peers.note('sb', w.keys.b, 'ed', report('beta', 'box-b', 'done'));
      expect(w.peers.messages.live('sb')).toBeNull();
      expect(await rows('SELECT state, why FROM peer_messages')).toEqual([{ state: 'dropped', why: 'receiver-ended' }]);
    });

    it('retention does not cut a send in two, and sweeps the messages of a session the server no longer holds', async () => {
      const w = await world('send', 'send');
      sent(await w.peers.messages.send('sa', 'beta@box-b', 'old'));
      w.tick(40 * 86_400_000);
      await w.peers.settings.set({ retainDays: 30 });
      const [swept, fresh] = await Promise.all([w.peers.retain(), w.peers.messages.send('sa', 'beta@box-b', 'new')]);
      expect(swept.messages).toBe(1);
      expect(fresh.ok).toBe(true);
      expect(await rows('SELECT text FROM peer_messages')).toEqual([{ text: 'new' }]);
      await db.run("DELETE FROM sessions WHERE id = 'sb'");
      expect((await w.peers.retain()).messages).toBe(1);
      expect(await rows('SELECT text FROM peer_messages')).toEqual([]);
    });

    it('drops every held message when the flag goes off, and nothing else', async () => {
      const w = await world('ask');
      sent(await w.peers.messages.send('sa', 'beta@box-b', 'hello'));
      await w.peers.dropAll();
      expect(await rows('SELECT state, why FROM peer_messages')).toEqual([{ state: 'dropped', why: 'messaging-off' }]);
      expect(await rows('SELECT COUNT(*) AS n FROM peer_rights')).toEqual([{ n: 2 }]);
    });
  });

  describe('peer store: the Admin settings', () => {
    it('reads what was just written, and keeps it for a second store over the same database', async () => {
      const w = await world();
      const [wrote, read] = await Promise.all([w.peers.settings.set({ perMinute: 2, retainDays: 7 }), w.peers.settings.get()]);
      expect(wrote.ok).toBe(true);
      expect(read).toMatchObject({ perMinute: 2, retainDays: 7 });
      expect(await w.peers.settings.retainMs()).toBe(7 * 86_400_000);
      const again = peerStoreOver(db, fakeReporters(T0).lookup, { now: () => T0, flagOn: () => true, startedAt: T0 });
      expect(await again.settings.limits()).toEqual({ roundTrips: 10, perMinute: 2, maxChars: 20_000 });
    });

    it('leaves the settings as they were when a write is refused', async () => {
      const w = await world();
      await w.peers.settings.set({ perMinute: 4 });
      expect(await w.peers.settings.set({ perMinute: 5, maxChars: 0 })).toEqual({ ok: false, error: 'Longest message must be a whole number from 1 to 20000' });
      expect(await w.peers.settings.set({})).toEqual({ ok: false, error: 'nothing to change' });
      expect((await w.peers.settings.get()).perMinute).toBe(4);
    });

    it('checks an owner default against the limits as they are when it is written', async () => {
      const w = await world();
      await w.peers.settings.set({ perMinute: 2 });
      const [over, fine] = await Promise.all([w.peers.setDefaults('ed', { limits: { perMinute: 5 } }, ED), w.peers.setDefaults('ed', { limits: { perMinute: 1 } }, ED)]);
      expect(over.ok).toBe(false);
      expect(fine.ok).toBe(true);
    });
  });

  describe('peer store: the rights step inside a transaction', () => {
    const breakSecondDirection = async (w: World) => {
      await db.exec(`CREATE OR REPLACE FUNCTION peer_stop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.from_key = '${w.keys.b}' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`);
      await db.exec('DROP TRIGGER IF EXISTS stop_b ON peer_rights');
      await db.exec('CREATE TRIGGER stop_b BEFORE INSERT OR UPDATE ON peer_rights FOR EACH ROW EXECUTE FUNCTION peer_stop()');
    };
    const clearTrigger = () => db.exec('DROP TRIGGER IF EXISTS stop_b ON peer_rights');

    it('rolls back only its own part when it fails inside a transaction that goes on to commit', async () => {
      const w = await world('send', 'none');
      await breakSecondDirection(w);
      try {
        const inner = await db.tx(async () => {
          await db.run("INSERT INTO admin_log (t, kind, detail, source, actor) VALUES (?, 'kind', 'before', 'src', 'ed')", [T0]);
          const failed = await w.peers.rights.pauseLink('ed', w.keys.a, w.keys.b, true, ED).catch((e: Error) => e.message);
          await db.run("INSERT INTO admin_log (t, kind, detail, source, actor) VALUES (?, 'kind', 'after', 'src', 'ed')", [T0]);
          return failed;
        });
        expect(inner).toContain('boom');
        // The first direction written before the failure is gone; the outer transaction's two rows stand.
        expect(await rows('SELECT paused FROM peer_rights')).toEqual([{ paused: 0 }]);
        expect((await rows('SELECT detail FROM admin_log ORDER BY id')).map((r) => r.detail)).toEqual(['before', 'after']);
      } finally {
        await clearTrigger();
      }
    });

    it('is undone with the transaction around it when that rolls back', async () => {
      const w = await world('send', 'send');
      await expect(
        db.tx(async () => {
          await w.peers.rights.pauseLink('ed', w.keys.a, w.keys.b, true, ED);
          throw new Error('abandoned');
        }),
      ).rejects.toThrow('abandoned');
      expect(await rows('SELECT paused FROM peer_rights ORDER BY from_key')).toEqual([{ paused: 0 }, { paused: 0 }]);
    });

    it('runs a step started inside a transaction on the transaction, in the order it was asked', async () => {
      const w = await world('send', 'send');
      await db.tx(async () => {
        await w.peers.rights.pauseLink('ed', w.keys.a, w.keys.b, true, ED);
        expect((await w.peers.rights.effective(w.keys.a, w.keys.b)).paused).toBe(true);
      });
      expect((await w.peers.rights.effective(w.keys.a, w.keys.b)).paused).toBe(true);
    });
  });

  describe('peer store: views', () => {
    it('gives the owner view and the admin view from one step each', async () => {
      const w = await world('ask');
      sent(await w.peers.messages.send('sa', 'beta@box-b', 'hello'));
      const view = await w.peers.ownerView('ed', T0 + 1);
      expect(view.reporters.map((r) => r.key).sort()).toEqual([w.keys.a, w.keys.b].sort());
      expect(view.limits.server.perMinute).toBe(6);
      expect(view.requests).toHaveLength(1);
      expect(view.requests[0]).toMatchObject({ kind: 'message', text: 'hello', from: { machine: 'box-a', name: 'alpha' }, to: { machine: 'box-b', name: 'beta' } });
      const admin = await w.peers.adminView(w.keys.a);
      expect(admin?.peers).toHaveLength(2);
      expect(admin?.requests).toHaveLength(1);
      expect(admin?.effective.map((e) => `${e.from}>${e.to}:${e.level}`)).toEqual(['a>a:none', 'a>b:ask', 'b>a:send']);
      expect(admin?.trust).toBe(false);
      expect(await w.peers.adminView('nope')).toBeNull();
    });

    it('answers a reply with nothing when the gate is off or the session is unknown', async () => {
      const w = await world('ask');
      expect(await w.peers.replyFor('sb', false)).toEqual({ peers: false, peerDeliveries: [], peerRequests: [] });
      expect(await w.peers.replyFor('unknown', true)).toEqual({ peers: false, peerDeliveries: [], peerRequests: [] });
    });

    it('hands the requests an orchestrator waits on to its reply, with the machines by name', async () => {
      const w = await world('ask');
      sent(await w.peers.messages.send('sa', 'beta@box-b', 'hello'));
      const reply = await w.peers.replyFor('sa', true);
      expect(reply.peers).toBe(true);
      expect(reply.peerRequests).toHaveLength(1);
    });

    it('tells a trail handler machine names at once, from inside the step', async () => {
      const w = await world('send', 'none');
      const seenNames: string[] = [];
      w.peers.onRights = (t, machine) => void (t.kind === 'paused' && seenNames.push(machine(t.a), machine('nope')));
      await w.peers.rights.pauseLink('ed', w.keys.a, w.keys.b, true, ED);
      expect(seenNames).toEqual(['box-a', 'nope']);
      expect(w.peers.onRights).toBeTypeOf('function');
      expect(w.peers.onMessage).toBeTypeOf('function');
      w.peers.withSource = (_s, fn) => fn();
      expect(w.peers.withSource('x', () => 5)).toBe(5);
      expect(w.peers.flagOn()).toBe(true);
    });

    it('tells a message trail handler machine names too', async () => {
      const w = await world('send', 'send');
      const names: string[] = [];
      w.peers.onMessage = (t, machine) => void names.push(machine(t.message.fromKey), machine(t.message.toKey));
      sent(await w.peers.messages.send('sa', 'beta@box-b', 'hi'));
      expect(names).toEqual(['box-a', 'box-b']);
    });

    it('tells the orchestrator that asked for access what the owner answered, as a notice', async () => {
      const w = await world('send', 'none');
      const asked = await w.peers.rights.requestAccess({ owner: 'ed', fromKey: 'b', toKey: 'a', right: 'see', reason: 'to look', by: 'beta', fromSession: 'sb' });
      if (!asked.ok || asked.state !== 'asked') throw new Error('not asked');
      expect((await w.peers.answer(asked.request.id, 'ed', 'allow', ED)).ok).toBe(true);
      const second = await w.peers.rights.requestAccess({ owner: 'ed', fromKey: 'b', toKey: 'a', right: 'send', reason: 'to send', by: 'beta', fromSession: 'sb' });
      if (!second.ok || second.state !== 'asked') throw new Error('not asked');
      expect((await w.peers.answer(second.request.id, 'ed', 'decline', ED)).ok).toBe(true);
      const texts = (await w.peers.replyFor('sb', true)).peerDeliveries.map((d) => d.text);
      expect(texts).toEqual([
        'ed allowed your request for access to box-a: can see. Run podium_peers to see what you can reach now.',
        'ed declined your request for access to box-a.',
      ]);
    });

    it('runs with the default handlers when the routes set none', async () => {
      const w = await world('send', 'send');
      const bare = peerStoreOver(db, fakeReporters(T0).lookup, { now: () => T0, flagOn: () => false, startedAt: T0 });
      expect(bare.flagOn()).toBe(false);
      await bare.rights.pauseLink(null, 'a', 'b', true, ED);
      expect(w.peers.withSource('src', () => 1)).toBe(1);
    });

    it('lists the conversations and reads one through the store', async () => {
      const w = await world('send', 'send');
      sent(await w.peers.messages.send('sa', 'beta@box-b', 'hi'));
      expect(await w.peers.messages.list('sa')).toMatchObject({ peers: [{ address: 'beta@box-b' }], leftOut: [] });
      expect(await w.peers.messages.conversations({})).toHaveLength(1);
      const trails: RightsTrail[] = [];
      w.peers.onRights = (t) => void trails.push(t);
      await w.peers.setDefaults('ed', { trust: true }, ED);
      expect(trails).toEqual([{ kind: 'defaults', owner: 'ed', actor: ED }]);
    });
  });
});
