// Orchestrator messaging (#347, #412) on PostgreSQL (#822): the message store, against a fake rights view and a fake reporter lookup.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { PgPeerMessages, type PgPeerRightsView } from './peerMessages.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';
import { MAX_NOTICES } from '../sqlite/peerMessages.js';
import { linkKey, type LiveOrchestrator, type MessageTrail, type PeerRequestRow, type ReporterRef, type SendOutcome, type Refusal } from '../../fleet/peerTypes.js';
import { PEER_LIMITS, type PeerLevel } from '../../fleet/protocol.js';
import type { AsyncPeerReporterLookup } from '../types.js';

const T0 = 1_800_000_000_000;
const ID = /^dlv_[0-9a-f]{24}$/;

function reporter(key: string, machine: string, extra: Partial<ReporterRef> = {}): ReporterRef {
  return { key, machine, owner: 'Ed', adminSecret: false, os: null, peers: true, version: '1.2.0', ...extra };
}

const REPORTERS: ReporterRef[] = [
  reporter('r-mbp', 'ed-mbp', { os: 'macOS 26.1' }),
  reporter('r-ci', 'ci-runner-01', { os: 'Ubuntu 24.04' }),
  reporter('r-pi', 'build-pi'),
  reporter('r-win', 'win-lab', { peers: false }),
  reporter('r-old', 'old-box', { peers: null }),
  reporter('r-hid', 'hidden-box'),
  reporter('r-idle', 'idle-box'),
  reporter('r-adm', 'admin-box', { adminSecret: true }),
  reporter('r-ann', 'ann-box', { owner: 'Ann' }),
];

function orch(sessionId: string, reporterKey: string, name: string, machine: string, extra: Partial<LiveOrchestrator> = {}): LiveOrchestrator {
  return { sessionId, reporterKey, owner: 'Ed', name, machine, os: null, project: '~/dev/podium', status: 'running', waitReason: null, peers: true, ...extra };
}

const MBP = orch('s-mbp', 'r-mbp', 'claude-dashboard', 'ed-mbp');
const CI = orch('s-ci', 'r-ci', 'Tester', 'ci-runner-01', { status: 'waiting', waitReason: 'input', os: 'Ubuntu 24.04' });
const PI = orch('s-pi', 'r-pi', 'arm64-check', 'build-pi');

const ok = (r: SendOutcome | Refusal): SendOutcome => {
  if (!r.ok) throw new Error(`refused: ${r.status} ${r.error}`);
  return r;
};

const lookupOf = (reps: Map<string, ReporterRef>, list: ReporterRef[]): AsyncPeerReporterLookup =>
  ({
    startedAt: T0,
    get: async (k: string) => reps.get(k) ?? null,
    ofOwner: async (o: string) => list.filter((r) => r.owner?.toLowerCase() === o.toLowerCase()),
  }) as AsyncPeerReporterLookup;

describe.skipIf(!TEST_PG)('postgres peer messages', () => {
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

  /** A store with Ed's three orchestrators live, and rights both ways between ed-mbp and ci-runner-01, with approval to build-pi. */
  async function setup() {
    await db.exec('TRUNCATE peer_messages, peer_requests');
    let now = T0;
    const levels = new Map<string, PeerLevel>();
    const paused = new Set<string>();
    const limits = { roundTrips: 10, perMinute: 6, maxChars: 20_000 };
    const opened: Parameters<PgPeerRightsView['openMessageRequest']>[0][] = [];
    const closed: [string, string][] = [];
    const rights: PgPeerRightsView = {
      effective: async (f, t) => ({ level: levels.get(`${f}>${t}`) ?? 'none', paused: paused.has(linkKey(f, t)) }),
      limits: async () => limits,
      openMessageRequest: async (input) => {
        opened.push(input);
        return { id: `req_${opened.length}` } as PeerRequestRow;
      },
      closeMessageRequest: async (id, outcome) => {
        closed.push([id, outcome]);
      },
    };
    const reps = new Map(REPORTERS.map((r) => [r.key, r]));
    const trails: MessageTrail[] = [];
    const s = new PgPeerMessages(db, rights, lookupOf(reps, REPORTERS), () => now, (t) => void trails.push(t));
    const set = (f: string, t: string, l: PeerLevel) => levels.set(`${f}>${t}`, l);
    set('r-mbp', 'r-ci', 'send');
    set('r-ci', 'r-mbp', 'send');
    set('r-mbp', 'r-pi', 'ask');
    for (const o of [MBP, CI, PI]) await s.note(o);
    return {
      s,
      db,
      set,
      pause: (a: string, b: string) => paused.add(linkKey(a, b)),
      limits,
      opened,
      closed,
      trails,
      tick: (ms = 1) => (now += ms),
      count: async () => (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM peer_messages'))!.n,
      stateOf: async (id: string) => (await db.get<{ state: string; why: string | null; approved: number; handed: number }>('SELECT state, why, approved, handed FROM peer_messages WHERE id = ?', [id]))!,
    };
  }

  describe('PeerMessages: defaults', () => {
    it('runs on the wall clock with no trail', async () => {
      await db.exec('TRUNCATE peer_messages, peer_requests');
      const rights: PgPeerRightsView = {
        effective: async () => ({ level: 'send', paused: false }),
        limits: async () => ({ roundTrips: 10, perMinute: 6, maxChars: 100 }),
        openMessageRequest: async () => ({ id: 'req' }) as PeerRequestRow,
        closeMessageRequest: async () => {},
      };
      const s = new PgPeerMessages(db, rights, lookupOf(new Map(REPORTERS.map((r) => [r.key, r])), []));
      await s.note(MBP);
      await s.note(CI);
      const before = Date.now();
      const r = ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'hi'));
      expect((await s.conversation('s-mbp', 's-ci'))[0].sentAt).toBeGreaterThanOrEqual(before);
      expect(r.state).toBe('sent');
    });
  });

  describe('PeerMessages: the live directory', () => {
    it('notes an orchestrator, and forgets it when it reports done', async () => {
      const { s } = await setup();
      expect(s.live('s-ci')).toEqual(CI);
      expect(s.live('s-none')).toBeNull();
      await s.note({ ...CI, status: 'done' });
      expect(s.live('s-ci')).toBeNull();
    });
  });

  describe('PeerMessages: sending', () => {
    it('sends to an idle orchestrator: stored ready, state sent, trailed', async () => {
      const { s, trails, stateOf } = await setup();
      const r = ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'Please run the systemd unit tests'));
      expect(r.id).toMatch(ID);
      expect(r).toMatchObject({ state: 'sent', paused: false, approvalWhy: null, requestId: null, to: { name: 'Tester', machine: 'ci-runner-01' }, roundTrips: { used: 0, cap: 10 } });
      expect(await stateOf(r.id)).toEqual({ state: 'ready', why: null, approved: 0, handed: 0 });
      expect(trails).toHaveLength(1);
      expect(trails[0]).toMatchObject({ kind: 'sent', state: 'sent', approvalWhy: null, message: { id: r.id, owner: 'Ed', link: linkKey('r-mbp', 'r-ci'), fromName: 'claude-dashboard', toName: 'Tester', sentAt: T0 } });
    });

    it('says turn when the receiver is working or at a permission prompt', async () => {
      const { s, set } = await setup();
      set('r-ci', 'r-pi', 'send');
      expect(ok(await s.send('s-ci', 'arm64-check@build-pi', 'hi')).state).toBe('turn');
      await s.note({ ...CI, waitReason: 'permission' });
      expect(ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'hi')).state).toBe('turn');
    });

    it('resolves the address case-insensitively, trimmed, split at the last @', async () => {
      const { s } = await setup();
      await s.note(orch('s-at', 'r-ci', 'me@work', 'ci-runner-01'));
      expect(ok(await s.send('s-mbp', '  tester @ CI-RUNNER-01 ', 'hi')).to).toEqual({ name: 'Tester', machine: 'ci-runner-01' });
      expect(ok(await s.send('s-mbp', 'me@work@ci-runner-01', 'hi')).to).toEqual({ name: 'me@work', machine: 'ci-runner-01' });
    });

    it('refuses an orchestrator the sender cannot find with one 404 that does not say why', async () => {
      const { s, count } = await setup();
      await s.note(orch('s-hid', 'r-hid', 'Hidden', 'hidden-box'));
      await s.note(orch('s-off', 'r-ci', 'Off', 'ci-runner-01', { peers: false }));
      await s.note(orch('s-old', 'r-ci', 'Old', 'ci-runner-01', { peers: undefined }));
      await s.note(orch('s-adm', 'r-adm', 'Adm', 'admin-box'));
      await s.note(orch('s-gone', 'r-missing', 'Gone', 'nowhere'));
      for (const to of ['Nobody@ed-mbp', 'build-pi-2', 'Hidden@hidden-box', 'Off@ci-runner-01', 'Old@ci-runner-01', 'Adm@admin-box', 'Gone@nowhere']) {
        expect(await s.send('s-mbp', to, 'hi')).toEqual({ ok: false, status: 404, error: `You cannot see an orchestrator called ${to}. Run podium_peers for the list.` });
      }
      expect(await count()).toBe(0);
    });

    it("never finds another owner's orchestrator, whatever the rights say, and stores nothing", async () => {
      const { s, set, count } = await setup();
      await s.note(orch('s-ann', 'r-ann', 'Helper', 'ann-box', { owner: 'Ann' }));
      set('r-mbp', 'r-ann', 'send');
      expect(await s.send('s-mbp', 'Helper@ann-box', 'hi')).toMatchObject({ ok: false, status: 404 });
      expect(await count()).toBe(0);
    });

    it('refuses two orchestrators of one name with a 409, and the sender itself with a 422', async () => {
      const { s, count } = await setup();
      await s.note(orch('s-ci2', 'r-ci', 'tester', 'ci-runner-01'));
      const two = await s.send('s-mbp', 'Tester@ci-runner-01', 'hi') as Refusal;
      expect(two.status).toBe(409);
      expect(two.error).toContain('There are 2 orchestrators called Tester@ci-runner-01');
      expect(two.error).toContain('Tester@ci-runner-01#s-ci');
      expect(await s.send('s-mbp', 'claude-dashboard@ed-mbp', 'hi')).toMatchObject({ ok: false, status: 422 });
      expect(await count()).toBe(0);
    });

    it('tells same-named orchestrators apart by id: lists each id, flags the duplicates, and sends to exactly the one named (#500)', async () => {
      const { s, count } = await setup();
      await s.note(orch('abcd1234-0000', 'r-ci', 'Tester', 'ci-runner-01'));
      await s.note(orch('ef567890-0000', 'r-ci', 'Tester', 'ci-runner-01'));
      const twins = (await s.list('s-mbp')).peers.filter((p) => p.name === 'Tester');
      expect(twins.map((p) => [p.id, p.duplicate])).toEqual([
        ['abcd1234', true],
        ['ef567890', true],
        ['s-ci', true],
      ]);
      const sent = ok(await s.send('s-mbp', 'Tester@ci-runner-01#ef567890', 'hi'));
      expect(await s.deliveriesFor('abcd1234-0000', true)).toEqual([]);
      expect(await s.deliveriesFor('s-ci', true)).toEqual([]);
      expect((await s.deliveriesFor('ef567890-0000', true)).map((d) => d.id)).toEqual([sent.id]);
      expect(await count()).toBe(1);
    });

    it('refuses a bare duplicated address with the ids to use, and an id that matches nobody, or two, with the same 404/409 (#500)', async () => {
      const { s, count } = await setup();
      await s.note(orch('abcd1234-0000', 'r-ci', 'Tester', 'ci-runner-01'));
      await s.note(orch('abcd9999-0000', 'r-ci', 'Tester', 'ci-runner-01'));
      const bare = await s.send('s-mbp', 'Tester@ci-runner-01', 'hi') as Refusal;
      expect(bare.status).toBe(409);
      expect(bare.error).toContain('Tester@ci-runner-01#abcd1234');
      expect(bare.error).toContain('Tester@ci-runner-01#abcd9999');
      expect(bare.error).toContain('Tester@ci-runner-01#s-ci');
      expect(await s.send('s-mbp', 'Tester@ci-runner-01#ffff', 'hi')).toMatchObject({ ok: false, status: 404 });
      expect(await s.send('s-mbp', 'Tester@ci-runner-01#abcd', 'hi')).toMatchObject({ ok: false, status: 409 });
      expect(await s.send('s-mbp', 'Tester@ci-runner-01#', 'hi')).toMatchObject({ ok: false, status: 409 });
      expect(await s.send('s-mbp', 'claude-dashboard@ed-mbp#s-mbp', 'hi')).toMatchObject({ ok: false, status: 422 });
      expect(await count()).toBe(0);
    });

    it('still finds a machine whose own name holds a # (#500)', async () => {
      const { s } = await setup();
      await s.note(orch('s-hash', 'r-ci', 'Odd', 'lab#2'));
      expect(ok(await s.send('s-mbp', 'Odd@lab#2', 'hi')).to).toEqual({ name: 'Odd', machine: 'lab#2' });
    });

    it('carries the sender\'s id in a delivery, so the receiver can answer the right session (#500)', async () => {
      const { s } = await setup();
      await s.note(orch('abcd1234-0000', 'r-mbp', 'claude-dashboard', 'ed-mbp'));
      ok(await s.send('abcd1234-0000', 'Tester@ci-runner-01', 'hi'));
      expect((await s.deliveriesFor('s-ci', true))[0]?.from).toEqual({ name: 'claude-dashboard', machine: 'ed-mbp', owner: 'Ed', id: 'abcd1234' });
    });

    it('refuses a sender that is not live, has messaging off, is too old, or is on the admin secret', async () => {
      const { s, count } = await setup();
      await s.note(orch('s-off', 'r-mbp', 'off', 'ed-mbp', { peers: false }));
      await s.note(orch('s-old', 'r-mbp', 'old', 'ed-mbp', { peers: undefined }));
      await s.note(orch('s-adm', 'r-adm', 'adm', 'admin-box'));
      for (const sid of ['s-none', 's-off', 's-old', 's-adm']) expect(await s.send(sid, 'Tester@ci-runner-01', 'hi')).toMatchObject({ ok: false, status: 403 });
      expect(await count()).toBe(0);
    });

    it('cleans the text, refuses it empty, and refuses (never cuts) it over the limit', async () => {
      const { s, db, limits, count } = await setup();
      const r = ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'line\u0007one\nline\ttwo'));
      expect((await db.get<{ text: string }>('SELECT text FROM peer_messages WHERE id = ?', [r.id]))!.text).toBe('line one\nline\ttwo');
      expect(await s.send('s-mbp', 'Tester@ci-runner-01', ' \u0000\n ')).toMatchObject({ ok: false, status: 400 });
      expect(await s.send('s-mbp', 'Tester@ci-runner-01', 'x'.repeat(25_000))).toEqual({
        ok: false,
        status: 422,
        error: 'The message is 25,000 characters, over the limit of 20,000 on this link. Send a shorter one, or a file path instead of the file.',
      });
      limits.maxChars = 5;
      expect(ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'x'.repeat(5))).state).toBe('sent');
      expect(await s.send('s-mbp', 'Tester@ci-runner-01', 'x'.repeat(6))).toMatchObject({ ok: false, status: 422 });
      expect(await count()).toBe(2);
    });

    it('refuses a right to see only with a 403 that says to ask for access', async () => {
      const { s, set, count } = await setup();
      set('r-ci', 'r-pi', 'see');
      const r = await s.send('s-ci', 'arm64-check@build-pi', 'hi') as Refusal;
      expect(r.status).toBe(403);
      expect(r.error).toBe('ci-runner-01 can see build-pi but has no right to send there. Ask Ed for one with podium_request_access.');
      expect(await count()).toBe(0);
    });

    it('holds a message on a link with approval and opens its request', async () => {
      const { s, opened, stateOf } = await setup();
      const r = ok(await s.send('s-mbp', 'arm64-check@build-pi', 'Also run npm run test:mod there'));
      expect(r).toMatchObject({ state: 'approval', approvalWhy: 'link', requestId: 'req_1' });
      expect(opened).toEqual([{ owner: 'Ed', fromKey: 'r-mbp', toKey: 'r-pi', by: 'claude-dashboard', fromSession: 's-mbp', messageId: r.id }]);
      expect((await stateOf(r.id)).state).toBe('approval');
    });

    it('says when the link is paused', async () => {
      const { s, pause } = await setup();
      pause('r-ci', 'r-mbp');
      expect(ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'hi')).paused).toBe(true);
    });

    it('refuses over the per-minute rate on the link, counting both directions, and takes it again a minute on', async () => {
      const { s, limits, tick, count } = await setup();
      limits.perMinute = 2;
      ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'one'));
      tick(1000);
      ok(await s.send('s-ci', 'claude-dashboard@ed-mbp', 'two'));
      tick(1000);
      const r = await s.send('s-mbp', 'Tester@ci-runner-01', 'three') as Refusal;
      expect(r.status).toBe(429);
      expect(r.error).toContain('Wait a minute');
      expect(await count()).toBe(2);
      tick(59_000);
      expect(ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'three')).state).toBe('sent');
    });

    it('holds the next message once the round-trip cap is reached, and counts from an approved one', async () => {
      const { s, limits, tick, trails } = await setup();
      limits.roundTrips = 2;
      const back = async (from: string, to: string) => {
        tick();
        return ok(await s.send(from, to, 'msg'));
      };
      expect((await back('s-mbp', 'Tester@ci-runner-01')).roundTrips).toEqual({ used: 0, cap: 2 });
      expect((await back('s-ci', 'claude-dashboard@ed-mbp')).roundTrips.used).toBe(1);
      expect((await back('s-mbp', 'Tester@ci-runner-01')).roundTrips.used).toBe(1);
      expect((await back('s-ci', 'claude-dashboard@ed-mbp')).roundTrips.used).toBe(2);
      const held = await back('s-mbp', 'Tester@ci-runner-01');
      expect(held).toMatchObject({ state: 'approval', approvalWhy: 'round-trips', requestId: 'req_1', roundTrips: { used: 2, cap: 2 } });
      expect(trails.at(-1)).toMatchObject({ kind: 'sent', state: 'approval', approvalWhy: 'round-trips' });
      expect(await s.approve(held.id, { name: 'Ed', admin: false })).toBe(true);
      const next = await back('s-ci', 'claude-dashboard@ed-mbp');
      expect(next).toMatchObject({ state: 'turn', approvalWhy: null, roundTrips: { used: 1, cap: 2 } });
    });
  });

  describe('PeerMessages: delivery and results', () => {
    it('hands messages over only while idle, oldest first with notices, and marks them handed', async () => {
      const { s, tick, stateOf } = await setup();
      const a = ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'first'));
      tick();
      s.notice('s-ci', 'A notice');
      tick();
      const b = ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'second'));
      expect(await s.deliveriesFor('s-ci', false)).toEqual([{ id: expect.stringMatching(ID), kind: 'notice', at: T0 + 1, from: null, text: 'A notice' }]);
      expect((await stateOf(a.id)).state).toBe('ready');
      const d = await s.deliveriesFor('s-ci', true);
      expect(d.map((x) => x.kind)).toEqual(['message', 'notice', 'message']);
      expect(d[0]).toEqual({ id: a.id, kind: 'message', at: T0, from: { name: 'claude-dashboard', machine: 'ed-mbp', owner: 'Ed', id: 's-mbp' }, text: 'first' });
      expect(await stateOf(a.id)).toMatchObject({ state: 'handed', handed: 1 });
      expect(await stateOf(b.id)).toMatchObject({ state: 'handed', handed: 1 });
      // No result yet: handed again.
      expect((await s.deliveriesFor('s-ci', true)).filter((x) => x.kind === 'message').map((x) => x.id)).toEqual([a.id, b.id]);
    });

    it('holds messages on a paused link and those waiting for approval', async () => {
      const { s, pause } = await setup();
      ok(await s.send('s-mbp', 'arm64-check@build-pi', 'needs approval'));
      expect(await s.deliveriesFor('s-pi', true)).toEqual([]);
      ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'paused'));
      pause('r-mbp', 'r-ci');
      expect(await s.deliveriesFor('s-ci', true)).toEqual([]);
    });

    it(`hands over at most ${PEER_LIMITS.deliveries} at once`, async () => {
      const { s, limits, tick } = await setup();
      limits.perMinute = 60;
      for (let i = 0; i < 25; i++) {
        tick();
        ok(await s.send('s-mbp', 'Tester@ci-runner-01', `m${i}`));
      }
      const d = await s.deliveriesFor('s-ci', true);
      expect(d).toHaveLength(PEER_LIMITS.deliveries);
      expect(d[0].text).toBe('m0');
    });

    it('records took, queued and refused, says repeat once, and unknown for the rest', async () => {
      const { s, trails, closed, stateOf } = await setup();
      const a = ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'a'));
      const b = ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'b'));
      const c = ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'c'));
      await s.deliveriesFor('s-ci', true);
      trails.length = 0;

      expect(await s.result('s-mbp', a.id, 'took')).toBe('unknown');
      expect(await s.result('s-ci', 'dlv_nope', 'took')).toBe('unknown');

      expect(await s.result('s-ci', a.id, 'took')).toBe('new');
      expect((await stateOf(a.id)).state).toBe('delivered');
      expect(await s.result('s-ci', a.id, 'took')).toBe('repeat');
      expect(await s.result('s-ci', a.id, 'queued')).toBe('unknown');

      expect(await s.result('s-ci', b.id, 'queued')).toBe('new');
      expect(await s.result('s-ci', b.id, 'queued')).toBe('repeat');
      expect((await stateOf(b.id)).state).toBe('queued');
      expect(await s.result('s-ci', b.id, 'took')).toBe('new');
      expect((await stateOf(b.id)).state).toBe('delivered');

      expect(await s.result('s-ci', c.id, 'refused')).toBe('new');
      expect(await stateOf(c.id)).toMatchObject({ state: 'dropped', why: 'refused' });
      expect(await s.result('s-ci', c.id, 'refused')).toBe('repeat');
      expect(await s.result('s-ci', c.id, 'took')).toBe('unknown');
      expect(closed).toEqual([[c.id, 'dropped']]);

      expect(trails.map((t) => t.kind)).toEqual(['delivered', 'delivered', 'dropped']);
      expect(trails[2]).toMatchObject({ kind: 'dropped', why: 'refused' });
      expect((await s.deliveriesFor('s-mbp', false)).map((d) => d.text)).toEqual(["Your message to Tester on ci-runner-01 was not delivered: Tester's session did not take it. It stays in Podium > Traffic."]);
    });

    it('takes no result for a message still waiting for approval', async () => {
      const { s } = await setup();
      const r = ok(await s.send('s-mbp', 'arm64-check@build-pi', 'x'));
      expect(await s.result('s-pi', r.id, 'took')).toBe('unknown');
    });

    it("removes a notice on its result, and says unknown for a gone one", async () => {
      const { s } = await setup();
      s.notice('s-ci', 'hello');
      const [n] = await s.deliveriesFor('s-ci', false);
      expect(await s.result('s-ci', n.id, 'took')).toBe('new');
      expect(await s.result('s-ci', n.id, 'took')).toBe('unknown');
      expect(await s.deliveriesFor('s-ci', false)).toEqual([]);
    });
  });

  describe('PeerMessages: approval', () => {
    it('approves a held message once: ready, approved, trailed', async () => {
      const { s, trails, stateOf } = await setup();
      const r = ok(await s.send('s-mbp', 'arm64-check@build-pi', 'x'));
      const actor = { name: 'Ed', admin: false };
      expect(await s.approve(r.id, actor)).toBe(true);
      expect(await stateOf(r.id)).toMatchObject({ state: 'ready', approved: 1 });
      expect(trails.at(-1)).toMatchObject({ kind: 'approved', actor, message: { id: r.id, state: 'ready', approved: true } });
      expect(await s.approve(r.id, actor)).toBe(false);
      expect(await s.approve('dlv_nope', actor)).toBe(false);
      expect(await s.decline(r.id, actor)).toBe(false);
    });

    it('declines a held message and tells its sender', async () => {
      const { s, trails, stateOf } = await setup();
      const r = ok(await s.send('s-mbp', 'arm64-check@build-pi', 'x'));
      const actor = { name: 'Ed', admin: false };
      expect(await s.decline(r.id, actor)).toBe(true);
      expect((await stateOf(r.id)).state).toBe('declined');
      expect(trails.at(-1)).toMatchObject({ kind: 'declined', actor });
      expect((await s.deliveriesFor('s-mbp', false)).map((d) => d.text)).toEqual(['Your message to arm64-check on build-pi was declined by Ed. It stays in Podium > Traffic.']);
      expect(await s.decline(r.id, actor)).toBe(false);
    });
  });

  describe('PeerMessages: notices', () => {
    it(`keeps at most ${MAX_NOTICES} per orchestrator, and none for one that is not live`, async () => {
      const { s, tick } = await setup();
      for (let i = 0; i < MAX_NOTICES + 3; i++) {
        tick();
        s.notice('s-ci', `n${i}`);
      }
      const d = await s.deliveriesFor('s-ci', false);
      expect(d).toHaveLength(MAX_NOTICES);
      expect(d[0].text).toBe('n3');
      s.notice('s-none', 'lost');
      expect(await s.deliveriesFor('s-none', false)).toEqual([]);
    });
  });

  describe('PeerMessages: drops', () => {
    it('drops the held messages to an orchestrator that ended, tells their senders, and keeps what it sent', async () => {
      const { s, set, trails, closed, stateOf } = await setup();
      set('r-ci', 'r-pi', 'send');
      const toCi = ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'x'));
      const fromCi = ok(await s.send('s-ci', 'arm64-check@build-pi', 'y'));
      await s.note({ ...CI, status: 'done' });
      expect(await stateOf(toCi.id)).toMatchObject({ state: 'dropped', why: 'receiver-ended' });
      expect((await stateOf(fromCi.id)).state).toBe('ready');
      expect(closed).toEqual([[toCi.id, 'dropped']]);
      expect(trails.at(-1)).toMatchObject({ kind: 'dropped', why: 'receiver-ended' });
      expect((await s.deliveriesFor('s-mbp', false)).map((d) => d.text)).toEqual(['Your message to Tester on ci-runner-01 was not delivered: Tester ended first. It stays in Podium > Traffic.']);
      expect(s.live('s-ci')).toBeNull();
    });

    it('drops held messages to or from deleted sessions, then deletes all their messages, telling only live senders', async () => {
      const { s, set, tick, stateOf, count } = await setup();
      set('r-ci', 'r-pi', 'send');
      const done = ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'old'));
      await s.deliveriesFor('s-ci', true);
      await s.result('s-ci', done.id, 'took');
      tick();
      ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'held to ci'));
      ok(await s.send('s-ci', 'arm64-check@build-pi', 'held from ci'));
      const kept = ok(await s.send('s-mbp', 'arm64-check@build-pi', 'other'));
      await s.deleted(['s-ci']);
      expect(await count()).toBe(1);
      expect((await stateOf(kept.id)).state).toBe('approval');
      expect(s.live('s-ci')).toBeNull();
      expect((await s.deliveriesFor('s-mbp', false)).map((d) => d.text)).toEqual(["Your message to Tester on ci-runner-01 was not delivered: Tester's session was deleted in Podium. It stays in Podium > Traffic."]);
    });

    it('drops the held messages on a removed link and tells their senders', async () => {
      const { s, stateOf } = await setup();
      const r = ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'x'));
      const other = ok(await s.send('s-mbp', 'arm64-check@build-pi', 'y'));
      await s.linkRemoved('r-ci', 'r-mbp');
      expect(await stateOf(r.id)).toMatchObject({ state: 'dropped', why: 'link-removed' });
      expect((await stateOf(other.id)).state).toBe('approval');
      expect((await s.deliveriesFor('s-mbp', false)).map((d) => d.text)).toEqual(['Your message to Tester on ci-runner-01 was not delivered: the link between ed-mbp and ci-runner-01 was removed. It stays in Podium > Traffic.']);
    });

    it('drops every held message when messaging goes off, and clears every notice', async () => {
      const { s, trails, closed, stateOf } = await setup();
      const a = ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'x'));
      const b = ok(await s.send('s-mbp', 'arm64-check@build-pi', 'y'));
      s.notice('s-ci', 'pending notice');
      await s.dropAll();
      expect(await stateOf(a.id)).toMatchObject({ state: 'dropped', why: 'messaging-off' });
      expect(await stateOf(b.id)).toMatchObject({ state: 'dropped', why: 'messaging-off' });
      expect(closed).toHaveLength(2);
      expect(trails.filter((t) => t.kind === 'dropped')).toHaveLength(2);
      expect(await s.deliveriesFor('s-mbp', false)).toEqual([]);
      expect(await s.deliveriesFor('s-ci', false)).toEqual([]);
    });
  });

  describe('PeerMessages: podium_peers', () => {
    it('lists what the sender can see, and says why each other reporter is left out', async () => {
      const { s, set, pause } = await setup();
      set('r-mbp', 'r-hid', 'none');
      set('r-mbp', 'r-idle', 'see');
      set('r-mbp', 'r-adm', 'send');
      await s.note(orch('s-hid', 'r-hid', 'Hidden', 'hidden-box'));
      await s.note(orch('s-adm', 'r-adm', 'Adm', 'admin-box'));
      await s.note(orch('s-ann', 'r-ann', 'Helper', 'ann-box', { owner: 'Ann' }));
      await s.note(orch('s-mbp2', 'r-mbp', 'second', 'ed-mbp'));
      set('r-mbp', 'r-mbp', 'see');
      pause('r-mbp', 'r-pi');
      const { peers, leftOut } = await s.list('s-mbp');
      expect(peers).toEqual([
        { address: 'arm64-check@build-pi', id: 's-pi', duplicate: false, name: 'arm64-check', machine: 'build-pi', os: null, project: '~/dev/podium', status: 'running', level: 'ask', paused: true },
        { address: 'second@ed-mbp', id: 's-mbp2', duplicate: false, name: 'second', machine: 'ed-mbp', os: null, project: '~/dev/podium', status: 'running', level: 'see', paused: false },
        { address: 'Tester@ci-runner-01', id: 's-ci', duplicate: false, name: 'Tester', machine: 'ci-runner-01', os: 'Ubuntu 24.04', project: '~/dev/podium', status: 'waiting', level: 'send', paused: false },
      ]);
      expect(leftOut).toEqual([
        { machine: 'win-lab', why: 'messaging off on the machine' },
        { machine: 'old-box', why: 'reporter too old to message' },
        { machine: 'hidden-box', why: 'no right to see it' },
        { machine: 'idle-box', why: 'no orchestrator running' },
      ]);
    });

    it('lists nothing for a session that cannot take part', async () => {
      const { s } = await setup();
      expect(await s.list('s-none')).toEqual({ peers: [], leftOut: [] });
    });
  });

  describe('PeerMessages: conversations', () => {
    it('summarizes each pair of orchestrators without the text, and filters by owner, time and liveness', async () => {
      const { s, set, tick, pause } = await setup();
      set('r-pi', 'r-mbp', 'send');
      ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'one'));
      tick(10);
      ok(await s.send('s-ci', 'claude-dashboard@ed-mbp', 'two'));
      tick(10);
      ok(await s.send('s-mbp', 'arm64-check@build-pi', 'three'));
      const all = await s.conversations({});
      expect(all).toHaveLength(2);
      const [pi, ci] = all;
      expect(pi).toEqual({
        link: linkKey('r-mbp', 'r-pi'),
        a: { sessionId: 's-mbp', name: 'claude-dashboard', machine: 'ed-mbp', reporterKey: 'r-mbp' },
        b: { sessionId: 's-pi', name: 'arm64-check', machine: 'build-pi', reporterKey: 'r-pi' },
        owner: 'Ed',
        messages: 1,
        lastAt: T0 + 20,
        state: 'waiting',
        paused: false,
        aToB: true,
        bToA: true,
        roundTrips: { used: 0, cap: 10 },
      });
      expect(ci).toMatchObject({ a: { sessionId: 's-ci' }, b: { sessionId: 's-mbp' }, messages: 2, lastAt: T0 + 10, state: 'active', aToB: true, bToA: true, roundTrips: { used: 1, cap: 10 } });
      expect(JSON.stringify(all)).not.toContain('one');
      pause('r-ci', 'r-mbp');
      expect((await s.conversations({})).find((c) => c.a.sessionId === 's-ci')).toMatchObject({ state: 'paused', paused: true });
      // A paused link with a message waiting for approval reads `waiting`, and still says it is paused (#417).
      pause('r-mbp', 'r-pi');
      expect((await s.conversations({})).find((c) => c.b.sessionId === 's-pi')).toMatchObject({ state: 'waiting', paused: true });
      expect(await s.conversations({ owner: 'ed' })).toHaveLength(2);
      expect(await s.conversations({ owner: 'Ann' })).toEqual([]);
      expect((await s.conversations({ since: T0 + 15 })).map((c) => c.b.sessionId)).toEqual(['s-pi']);
      await s.note({ ...CI, status: 'done' });
      await s.note({ ...MBP, status: 'done' });
      expect((await s.conversations({ liveOnly: true })).map((c) => c.b.sessionId)).toEqual(['s-pi']);
      await s.note({ ...PI, status: 'done' });
      expect(await s.conversations({ liveOnly: true })).toEqual([]);
    });

    it('says a direction cannot send when its right is only to see', async () => {
      const { s, set } = await setup();
      ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'x'));
      set('r-ci', 'r-mbp', 'see');
      expect((await s.conversations({}))[0]).toMatchObject({ a: { sessionId: 's-ci' }, aToB: false, bToA: true });
    });

    it('reads one conversation, both directions, oldest first, with the text', async () => {
      const { s, tick } = await setup();
      ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'one'));
      tick();
      ok(await s.send('s-ci', 'claude-dashboard@ed-mbp', 'two'));
      tick();
      ok(await s.send('s-mbp', 'arm64-check@build-pi', 'other'));
      expect((await s.conversation('s-ci', 's-mbp')).map((m) => m.text)).toEqual(['one', 'two']);
      expect((await s.conversation('s-mbp', 's-ci')).map((m) => m.fromSession)).toEqual(['s-mbp', 's-ci']);
    });

    it('deletes the messages of links whose newest message is older than the cutoff', async () => {
      const { s, tick, count } = await setup();
      ok(await s.send('s-mbp', 'Tester@ci-runner-01', 'old'));
      tick(100);
      ok(await s.send('s-mbp', 'arm64-check@build-pi', 'old pi'));
      tick(100);
      ok(await s.send('s-ci', 'claude-dashboard@ed-mbp', 'new ci'));
      expect(await s.retain(T0 + 150)).toBe(1);
      expect(await count()).toBe(2);
      expect(await s.conversation('s-mbp', 's-ci')).toHaveLength(2);
    });
  });
});
