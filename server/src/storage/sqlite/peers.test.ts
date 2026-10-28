// The peer service over the SQLite storage (#313 stage 4b): the read-then-write sequences that were atomic while the
// calls were synchronous must stay so with every call awaited, in and out of a transaction.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openSqliteStorage, type SqliteStorage } from './index.js';
import { session } from '../contract.js';
import type { PeerStoreApi } from '../types.js';
import type { Actor, MessageTrail, Refusal, SendOutcome } from '../../fleet/peerTypes.js';
import type { Report } from '../../fleet/protocol.js';

const T0 = 1_800_000_000_000;
const ED: Actor = { name: 'ed', admin: false };

interface World {
  storage: SqliteStorage;
  peers: PeerStoreApi;
  trails: MessageTrail[];
  keys: { a: string; b: string };
  tick: (ms?: number) => number;
}

const open: SqliteStorage[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const seen = (machineId: string) => ({
  kind: 'mod' as const, machineId, machineName: `box-${machineId}`, source: '10.0.0.1', owner: 'ed', credential: 'person' as const,
  version: '1.4.0', engineVersion: null, sessionId: `s-${machineId}`, os: 'macOS', peers: true,
});

const report = (name: string, machine: string, status = 'waiting'): Report =>
  ({ session: { name, status, waitReason: status === 'waiting' ? 'input' : null, peers: true, repoName: null, projectRoot: '~/dev' }, machine: { name: machine, os: 'macOS' } }) as unknown as Report;

/** Two of Ed's reporters, each with a live orchestrator waiting for its person (idle), and a right to send from a to b of `ab` (and b to a of `ba`). */
async function world(ab: 'ask' | 'send' = 'ask', ba: 'ask' | 'send' | 'none' = 'send', storage: SqliteStorage = openSqliteStorage(':memory:')): Promise<World> {
  open.push(storage);
  let now = T0;
  const peers = storage.peers({ now: () => now, flagOn: () => true, startedAt: T0 });
  const trails: MessageTrail[] = [];
  peers.onMessage = (t) => void trails.push(t);
  const a = await storage.reporters.record(seen('a'), T0);
  const b = await storage.reporters.record(seen('b'), T0);
  await storage.fleet.upsertSession(session({ id: 'sa', owner: 'ed' }));
  await storage.fleet.upsertSession(session({ id: 'sb', owner: 'ed' }));
  await peers.note('sa', a, 'ed', report('alpha', 'box-a'));
  await peers.note('sb', b, 'ed', report('beta', 'box-b'));
  await peers.rights.setRight('ed', a, b, ab, ED);
  if (ba !== 'none') await peers.rights.setRight('ed', b, a, ba, ED);
  return { storage, peers, trails, keys: { a, b }, tick: (ms = 1) => (now += ms) };
}

const sent = (r: SendOutcome | Refusal): SendOutcome => {
  if (!r.ok) throw new Error(`refused: ${r.status} ${r.error}`);
  return r;
};

const rows = (w: World, sql: string, ...args: (string | number)[]) => w.storage.sqliteHandle.prepare(sql).all(...args) as Record<string, unknown>[];

describe('peer store: approve is one step', () => {
  it('delivers a message once when the owner answers twice at the same time', async () => {
    const w = await world('ask');
    const out = sent(await w.peers.messages.send('sa', 'beta@box-b', 'hello'));
    expect(out.state).toBe('approval');
    const [x, y] = await Promise.all([
      w.peers.answer(out.requestId!, 'ed', 'deliver', ED),
      w.peers.answer(out.requestId!, 'ed', 'deliver', ED),
    ]);
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
    expect(rows(w, 'SELECT state, why FROM peer_messages')).toEqual([{ state: 'dropped', why: 'link-removed' }]);
    expect(rows(w, 'SELECT closed_at FROM peer_requests WHERE kind = ?', 'message').every((r) => r.closed_at !== null)).toBe(true);
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
    expect(rows(w, 'SELECT COUNT(*) AS n FROM peer_messages')).toEqual([{ n: 3 }]);
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
    const tx = w.storage.tx(async () => {
      await w.storage.people.log('kind', 'inside', 'src', T0, 'ed');
      await gate;
      throw new Error('abandoned');
    });
    const failed = tx.catch((e: Error) => e.message);
    const send = w.peers.messages.send('sa', 'beta@box-b', 'kept');
    await new Promise((r) => setTimeout(r, 20));
    try {
      // Not yet stored: the send is queued behind the transaction, not running inside it.
      expect(rows(w, 'SELECT COUNT(*) AS n FROM peer_messages')).toEqual([{ n: 0 }]);
    } finally {
      release();
    }
    expect(await failed).toBe('abandoned');
    expect((await send).ok).toBe(true);
    expect(rows(w, 'SELECT text FROM peer_messages')).toEqual([{ text: 'kept' }]);
    expect(rows(w, 'SELECT COUNT(*) AS n FROM admin_log')).toEqual([{ n: 0 }]);
  });
});

describe('peer store: ended and deleted sessions', () => {
  it('leaves no held message and no open request when the receiver ends while a send is made, either way round', async () => {
    for (const sendFirst of [true, false]) {
      const w = await world('ask');
      const send = () => w.peers.messages.send('sa', 'beta@box-b', 'hello');
      const end = () => w.peers.ended('sb');
      await Promise.all(sendFirst ? [send(), end()] : [end(), send()]);
      expect(rows(w, "SELECT id FROM peer_messages WHERE state IN ('approval', 'ready', 'handed', 'queued')")).toEqual([]);
      expect(rows(w, 'SELECT id FROM peer_requests WHERE closed_at IS NULL')).toEqual([]);
      await w.storage.close();
      open.pop();
    }
  });

  it('removes every message of a deleted session and closes the requests that waited on them', async () => {
    const w = await world('ask');
    const out = sent(await w.peers.messages.send('sa', 'beta@box-b', 'hello'));
    await Promise.all([w.peers.deleted(['sb']), w.peers.messages.send('sa', 'beta@box-b', 'later')]);
    expect(rows(w, 'SELECT id FROM peer_messages')).toEqual([]);
    expect(rows(w, 'SELECT id FROM peer_requests WHERE closed_at IS NULL')).toEqual([]);
    expect((await w.peers.answer(out.requestId!, 'ed', 'deliver', ED)).ok).toBe(false);
  });

  it('forgets a session that reports done, and drops what waited for it', async () => {
    const w = await world('ask');
    sent(await w.peers.messages.send('sa', 'beta@box-b', 'hello'));
    await w.peers.note('sb', w.keys.b, 'ed', report('beta', 'box-b', 'done'));
    expect(w.peers.messages.live('sb')).toBeNull();
    expect(rows(w, 'SELECT state, why FROM peer_messages')).toEqual([{ state: 'dropped', why: 'receiver-ended' }]);
  });

  it('retention does not cut a send in two', async () => {
    const w = await world('send', 'send');
    sent(await w.peers.messages.send('sa', 'beta@box-b', 'old'));
    w.tick(40 * 86_400_000);
    await w.peers.settings.set({ retainDays: 30 });
    const [swept, fresh] = await Promise.all([w.peers.retain(), w.peers.messages.send('sa', 'beta@box-b', 'new')]);
    expect(swept.messages).toBe(1);
    expect(fresh.ok).toBe(true);
    expect(rows(w, 'SELECT text FROM peer_messages')).toEqual([{ text: 'new' }]);
  });

  it('drops every held message when the flag goes off, and nothing else', async () => {
    const w = await world('ask');
    sent(await w.peers.messages.send('sa', 'beta@box-b', 'hello'));
    await w.peers.dropAll();
    expect(rows(w, 'SELECT state, why FROM peer_messages')).toEqual([{ state: 'dropped', why: 'messaging-off' }]);
    expect(rows(w, 'SELECT COUNT(*) AS n FROM peer_rights')).toEqual([{ n: 2 }]);
  });
});

describe('peer store: the Admin settings', () => {
  it('reads what was just written, and keeps it across a restart', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'podium-peers-')), 'p.sqlite');
    try {
      const first = openSqliteStorage(file);
      const peers = first.peers({ now: () => T0, flagOn: () => true, startedAt: T0 });
      const [wrote, read] = await Promise.all([peers.settings.set({ perMinute: 2, retainDays: 7 }), peers.settings.get()]);
      expect(wrote.ok).toBe(true);
      expect(read).toMatchObject({ perMinute: 2, retainDays: 7 });
      expect(await peers.settings.retainMs()).toBe(7 * 86_400_000);
      await first.close();
      const again = openSqliteStorage(file);
      expect(await again.peers({ now: () => T0, flagOn: () => true, startedAt: T0 }).settings.limits()).toEqual({ roundTrips: 10, perMinute: 2, maxChars: 20_000 });
      await again.close();
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
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
  const breakSecondDirection = (w: World) =>
    w.storage.sqliteHandle.exec(`CREATE TRIGGER stop_b BEFORE INSERT ON peer_rights WHEN NEW.from_key = '${w.keys.b}' BEGIN SELECT RAISE(ABORT, 'boom'); END`);

  it('rolls back only its own part when it fails inside a transaction that goes on to commit', async () => {
    const w = await world('send', 'none');
    breakSecondDirection(w);
    const inner = await w.storage.tx(async () => {
      await w.storage.people.log('kind', 'before', 'src', T0, 'ed');
      const failed = await w.peers.rights.pauseLink('ed', w.keys.a, w.keys.b, true, ED).catch((e: Error) => e.message);
      await w.storage.people.log('kind', 'after', 'src', T0, 'ed');
      return failed;
    });
    expect(inner).toContain('boom');
    // The first direction written before the failure is gone; the outer transaction's two rows stand.
    expect(rows(w, 'SELECT paused FROM peer_rights')).toEqual([{ paused: 0 }]);
    expect(rows(w, 'SELECT detail FROM admin_log ORDER BY id').map((r) => r.detail)).toEqual(['before', 'after']);
  });

  it('is undone with the transaction around it when that rolls back', async () => {
    const w = await world('send', 'send');
    await expect(
      w.storage.tx(async () => {
        await w.peers.rights.pauseLink('ed', w.keys.a, w.keys.b, true, ED);
        throw new Error('abandoned');
      }),
    ).rejects.toThrow('abandoned');
    expect(rows(w, 'SELECT paused FROM peer_rights')).toEqual([{ paused: 0 }, { paused: 0 }]);
  });

  it('runs a step started inside a transaction on the transaction, in the order it was asked', async () => {
    const w = await world('send', 'send');
    await w.storage.tx(async () => {
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
    const admin = await w.peers.adminView(w.keys.a);
    expect(admin?.peers).toHaveLength(2);
    expect(admin?.requests).toHaveLength(1);
    expect(await w.peers.adminView('nope')).toBeNull();
  });

  it('answers a reply for a reporter on the admin secret with nothing', async () => {
    const w = await world('ask');
    expect(await w.peers.replyFor('sb', false)).toEqual({ peers: false, peerDeliveries: [], peerRequests: [] });
    expect(await w.peers.replyFor('unknown', true)).toEqual({ peers: false, peerDeliveries: [], peerRequests: [] });
  });

  it('tells a trail handler machine names at once, from inside the step', async () => {
    const w = await world('send', 'none');
    const seenNames: string[] = [];
    w.peers.onRights = (t, machine) => void (t.kind === 'paused' && seenNames.push(machine(t.a), machine('nope')));
    await w.peers.rights.pauseLink('ed', w.keys.a, w.keys.b, true, ED);
    expect(seenNames).toEqual(['box-a', 'nope']);
    expect(w.peers.onRights).toBeTypeOf('function');
    w.peers.withSource = (_s, fn) => fn();
    expect(w.peers.flagOn()).toBe(true);
  });
});
