// The session recordings on PostgreSQL (#822): the cases of `sqlite/recordings.test.ts` against the class over a migrated
// `podium_activity` schema. Skipped without `PODIUM_TEST_PG`.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIN_LOOP, RECORDING_DEFAULTS, RECORDING_LIMITS, type RecordingBatch, type RecordingEntry, type RecordingSettings } from '../../fleet/protocol.js';
import type { RecordingTrail } from '../rows.js';
import { PgDb } from './conn.js';
import { ACTIVITY_SCHEMA, ACTIVITY_STEPS, migrate } from './schema.js';
import { PgSessionRecordings } from './recordings.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';

const HOUR_MS = 3_600_000;
const MB = 1024 * 1024;
// The room a start needs under the budget (one full request); the class keeps the constant private.
const RECORDING_START_HEADROOM_BYTES = RECORDING_LIMITS.bodyBytes;
const PODIUM_PROMPT_MATCH_MS = 10 * 60_000;
const T0 = 1_800_000_000_000;
const SECRET = 'the-admin-secret-0123456789';
const META = { name: 'billing', project: 'acme/billing', owner: 'Ed' };

let td: TestDatabase;
let db: PgDb;

type Exclusive = <T>(fn: () => Promise<T>) => Promise<T>;

/** Builds the class over the shared database with the connection's `step` replaced by one that just runs the function. */
function make(over: { authOn?: boolean; chunkRows?: number; exclusive?: boolean; hold?: boolean } = {}) {
  const s = {
    now: T0,
    flag: true,
    live: new Set(['s1', 's2', 's3']),
    settings: { ...RECORDING_DEFAULTS } as RecordingSettings,
    agents: ['a1'],
  };
  const trails: RecordingTrail[] = [];
  const compacted = vi.fn(() => Promise.resolve());
  // `hold` stops a removal after its first step, so a test can look at the state in between.
  let enter = () => {};
  let open = () => {};
  const gate = { entered: new Promise<void>((r) => (enter = r)), open: () => open() };
  const released = new Promise<void>((r) => (open = r));
  let exclusive: Exclusive | undefined;
  if (over.hold) {
    exclusive = async (fn) => {
      enter();
      await released;
      return fn();
    };
  } else if (over.exclusive) {
    exclusive = (fn) => fn();
  }
  const rec = new PgSessionRecordings(db, {
    now: () => s.now,
    settings: () => s.settings,
    flagOn: () => s.flag,
    authOn: over.authOn ?? true,
    isLive: (id) => s.live.has(id),
    loopsOf: () => [{ loop: MAIN_LOOP, name: 'Orchestrator' }, ...s.agents.map((a) => ({ loop: a, name: `agent ${a}` }))],
    secrets: () => [SECRET],
    chunkRows: over.chunkRows,
    step: (fn) => fn(),
    ...(exclusive ? { exclusive, compact: compacted } : {}),
  });
  rec.trail = (t) => trails.push(t);
  return { rec, s, db, trails, compacted, gate };
}

const entry = (loop: string, seq: number, text = `text ${seq}`, extra: Partial<RecordingEntry> = {}): RecordingEntry => ({ loop, seq, at: T0 + seq, kind: 'tool', text, ...extra });
const batch = (...entries: RecordingEntry[]): RecordingBatch => ({ v: 1, sentAt: T0, entries });

/** A recording that is chosen, with the owner's option on. */
async function running(over: Parameters<typeof make>[0] = {}, loops = [MAIN_LOOP, 'a1']) {
  const m = make(over);
  m.rec.noteOption('s1', true);
  expect(await m.rec.start('s1', loops, 'Ed', META)).toBe('ok');
  return m;
}

describe.skipIf(!TEST_PG)('postgres session recordings', () => {
  beforeAll(async () => {
    td = await createTestDatabase();
    db = new PgDb({ connectionString: td.url, schema: ACTIVITY_SCHEMA, max: 4, name: 'test' });
    await migrate(db, ACTIVITY_SCHEMA, ACTIVITY_STEPS);
  });
  afterAll(async () => {
    await db.close();
    await td.drop();
  });
  beforeEach(async () => {
    await db.exec('TRUNCATE rec_entries, rec_sessions RESTART IDENTITY');
  });

  describe('the three yes answers', () => {
    it('grants nothing while no one has chosen the session, and says which answers are missing', async () => {
      const { rec } = make();
      expect(await rec.grant('s1')).toMatchObject({ state: 'off', consent: { admin: true, chosen: false, owner: false }, loops: [], keptUntil: null, bytes: 0 });
      rec.noteOption('s1', true);
      expect((await rec.grant('s1')).consent).toEqual({ admin: true, chosen: false, owner: true });
    });

    it('is off for every session while the flag is off, and when the server has no token', async () => {
      const m = await running();
      m.s.flag = false;
      expect(m.rec.enabled()).toBe(false);
      expect(await m.rec.grant('s1')).toMatchObject({ state: 'off', consent: { admin: false, chosen: false, owner: true }, loops: [] });
      expect(await m.rec.capturing('s1')).toBe(false);
      const open = make({ authOn: false });
      expect(open.rec.enabled()).toBe(false);
      expect((await open.rec.grant('s1')).consent.admin).toBe(false);
      expect(await open.rec.view('s1')).toBeNull();
    });

    it('records only with the choice and the owner option together', async () => {
      const { rec } = make();
      expect(await rec.start('s1', [MAIN_LOOP], 'Ed', META)).toBe('ok');
      // chosen, but the owner has not allowed it: nothing is captured and the grant says why
      expect(await rec.capturing('s1')).toBe(false);
      expect(await rec.grant('s1')).toMatchObject({ state: 'recording', consent: { admin: true, chosen: true, owner: false }, loops: [MAIN_LOOP], startedBy: 'Ed', startedAt: T0 });
      rec.noteOption('s1', true);
      expect(await rec.capturing('s1')).toBe(true);
      rec.noteOption('s1', undefined); // a reporter that does not send the option is read as off
      expect(await rec.capturing('s1')).toBe(false);
      expect(rec.optionOn('s1')).toBe(false);
    });

    it('stops capturing when the session ends or the flag goes off, and keeps what it has', async () => {
      const m = await running();
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)));
      m.s.live.delete('s1');
      expect(await m.rec.grant('s1')).toMatchObject({ state: 'stopped', consent: { chosen: false }, loops: [] });
      expect(await m.rec.capturing('s1')).toBe(false);
      m.s.live.add('s1');
      expect(await m.rec.capturing('s1')).toBe(true);
      m.s.flag = false;
      expect((await m.rec.view('s1'))?.state).toBe('stopped');
      expect((await m.rec.page('s1', null, 10, null)).entries).toHaveLength(1);
    });

    it('forgets the option of a session that left', async () => {
      const { rec } = make();
      rec.noteOption('s1', true);
      rec.forgetSession('s1');
      expect(rec.optionOn('s1')).toBe(false);
    });
  });

  describe('start and stop', () => {
    it('starts, changes the loops of a running recording without losing who started it, and starts a stopped one again', async () => {
      const m = await running();
      m.s.now = T0 + 1000;
      expect(await m.rec.start('s1', [MAIN_LOOP], 'Boss', META)).toBe('ok');
      expect(await m.rec.grant('s1')).toMatchObject({ state: 'recording', loops: [MAIN_LOOP], startedBy: 'Ed', startedAt: T0 });
      const out = await m.rec.stop('s1', 'Boss');
      expect(out?.changed).toBe(true);
      m.s.now = T0 + 2000;
      expect(await m.rec.start('s1', [MAIN_LOOP, 'a1'], 'Boss', META)).toBe('ok');
      expect(await m.rec.grant('s1')).toMatchObject({ state: 'recording', loops: [MAIN_LOOP, 'a1'], startedBy: 'Boss', startedAt: T0 + 2000, stoppedBy: null, stoppedAt: null });
      // the earlier stop mark is kept
      expect((await m.rec.page('s1', null, 10, null)).entries.map((e) => e.kind)).toEqual(['stopped']);
    });

    it('stop keeps what was recorded, writes a mark naming who stopped it, and does nothing the second time', async () => {
      const m = await running();
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, 'first')));
      m.s.now = T0 + 5000;
      const out = await m.rec.stop('s1', 'Boss');
      expect(out).toMatchObject({ changed: true, grant: { state: 'stopped', stoppedBy: 'Boss', stoppedAt: T0 + 5000, loops: [], consent: { chosen: false } } });
      expect(await m.rec.stop('s1', 'Ed')).toMatchObject({ changed: false, grant: { state: 'stopped', stoppedBy: 'Boss' } });
      const rows = (await m.rec.page('s1', null, 10, null)).entries;
      expect(rows.map((r) => [r.kind, r.text, r.by])).toEqual([
        ['tool', 'first', undefined],
        ['stopped', '', 'Boss'],
      ]);
      expect(await m.rec.capturing('s1')).toBe(false);
      expect(await m.rec.stop('nope', 'Ed')).toBeNull();
      expect(await m.rec.stateFor('s1')).toBe('stopped');
      expect(await m.rec.stateFor('nope')).toBeUndefined();
    });

    it('refuses to start again after a limit until the recording is deleted, and while a delete is going', async () => {
      const m = await running({ hold: true });
      m.s.settings = { ...m.s.settings, sessionMb: 100 / MB };
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, 'x'.repeat(200))));
      expect((await m.rec.grant('s1')).state).toBe('limit');
      expect(await m.rec.start('s1', [MAIN_LOOP], 'Ed', META)).toBe('limit');
      const gone = m.rec.removeMany(['s1']);
      await m.gate.entered; // the rows that carry the state are gone, the entries are still being removed
      m.rec.noteOption('s1', true);
      expect(await m.rec.start('s1', [MAIN_LOOP], 'Ed', META)).toBe('busy');
      m.gate.open();
      await gone;
      expect(await m.rec.start('s1', [MAIN_LOOP], 'Ed', META)).toBe('ok');
    });

    it('stopAll stops every running recording, naming who, and tells the log', async () => {
      const m = await running();
      m.rec.noteOption('s2', true);
      await m.rec.start('s2', [MAIN_LOOP], 'Ed', META);
      await m.rec.stop('s2', 'Ed');
      expect(await m.rec.stopAll('Admin')).toEqual(['s1']);
      expect(await m.rec.grant('s1')).toMatchObject({ state: 'stopped', stoppedBy: 'Admin' });
      expect(m.trails).toEqual([{ kind: 'stopped', sessionId: 's1', by: 'Admin' }]);
      expect(await m.rec.stopAll('Admin')).toEqual([]);
    });

    it('does not let a failing log write undo a stop', async () => {
      const m = await running();
      m.rec.trail = () => {
        throw new Error('log is full');
      };
      expect(await m.rec.stopAll('Admin')).toEqual(['s1']);
      expect(await m.rec.stateFor('s1')).toBe('stopped');
    });
  });

  describe('capture', () => {
    it('stores entries of the chosen loops once each, and drops a resend by (loop, seq)', async () => {
      const m = await running({}, [MAIN_LOOP]);
      const b = batch(entry(MAIN_LOOP, 1), entry(MAIN_LOOP, 2), entry('a1', 1, 'an agent that was not chosen'));
      expect(await m.rec.ingest('s1', b)).toBe(2);
      expect(await m.rec.ingest('s1', b)).toBe(0);
      expect(await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 2), entry(MAIN_LOOP, 3)))).toBe(1);
      const page = await m.rec.page('s1', null, 10, null);
      expect(page.entries.map((e) => `${e.loop}:${e.text}`)).toEqual([`${MAIN_LOOP}:text 1`, `${MAIN_LOOP}:text 2`, `${MAIN_LOOP}:text 3`]);
      expect(page.total).toBe(3);
      expect(await m.rec.ingest('nope', batch(entry(MAIN_LOOP, 1)))).toBe(0);
    });

    it('stores nothing of a batch that fails half way, and goes on working', async () => {
      const m = await running();
      await expect(m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1), { ...entry(MAIN_LOOP, 2), at: undefined as never }))).rejects.toThrow();
      expect((await m.rec.page('s1', null, 10, null)).entries).toEqual([]);
      expect((await m.rec.grant('s1')).bytes).toBe(0);
      expect(await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)))).toBe(1);
    });

    it('reads a damaged list of chosen loops as none', async () => {
      const m = await running();
      await m.db.run('UPDATE rec_sessions SET loops = ?', ['not json']);
      expect((await m.rec.grant('s1')).loops).toEqual([]);
      await m.db.run('UPDATE rec_sessions SET loops = ?', ['{"a":1}']);
      expect((await m.rec.view('s1'))?.loops.every((l) => !l.recorded)).toBe(true);
    });

    it('keeps every field of an entry and leaves out the ones that are not set', async () => {
      const m = await running();
      await m.rec.ingest(
        's1',
        batch(
          entry(MAIN_LOOP, 1, 'ls -la', { kind: 'tool', name: 'Bash' }),
          entry(MAIN_LOOP, 2, 'total 0', { kind: 'result', name: 'Bash', callSeq: 1, failed: true, cut: true }),
          entry('a1', 1, '', { kind: 'gap', lost: 4 }),
          entry('a1', 2, '', { kind: 'thinking' }),
        ),
      );
      const rows = (await m.rec.page('s1', null, 10, null)).entries;
      expect(rows[0]).toEqual({ n: 1, seq: 1, loop: MAIN_LOOP, at: T0 + 1, kind: 'tool', text: 'ls -la', name: 'Bash' });
      expect(rows[1]).toEqual({ n: 2, seq: 2, loop: MAIN_LOOP, at: T0 + 2, kind: 'result', text: 'total 0', name: 'Bash', callSeq: 1, failed: true, cut: true });
      expect(rows[2]).toMatchObject({ kind: 'gap', lost: 4, loop: 'a1' });
      expect(rows[3]).toEqual({ n: 4, seq: 2, loop: 'a1', at: T0 + 2, kind: 'thinking', text: '' });
    });

    it('gives the server its own marks a seq at or below zero, apart from the mod range', async () => {
      const m = await running();
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)));
      await m.rec.stop('s1', 'Ed');
      expect((await m.rec.page('s1', null, 10, null)).entries.map((e) => [e.kind, e.seq])).toEqual([
        ['tool', 1],
        ['stopped', 0],
      ]);
    });

    it('says when the oldest part of a recording goes, only for one that is held', async () => {
      const m = await running();
      expect(await m.rec.keptUntilOf('nope')).toBeNull();
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)));
      expect(await m.rec.keptUntilOf('s1')).toBe(T0 + 6 * HOUR_MS);
      const open = make({ authOn: false });
      open.rec.noteOption('s1', true);
      await open.rec.start('s1', [MAIN_LOOP], 'Ed', META);
      expect(await open.rec.keptUntilOf('s1')).toBeNull();
    });

    it("replaces Podium's own credentials in what the mod sent, and nothing else", async () => {
      const m = await running();
      const token = 'pdm_0123456789ab_0123456789abcdef0123456789abcdef';
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, `curl -H "X-Podium-Token: ${token}" and ${SECRET} end`), entry(MAIN_LOOP, 2, 'password=hunter2 stays: the mod redacts, the server adds no pattern pass')));
      const rows = (await m.rec.page('s1', null, 10, null)).entries;
      expect(rows[0]!.text).toBe('curl -H "X-Podium-Token: [redacted]" and [redacted] end');
      expect(rows[1]!.text).toContain('password=hunter2');
    });

    it('pages a replay newest first, oldest first within a page, with the older cursor, a loop filter and a clamped size', async () => {
      const m = await running();
      const entries: RecordingEntry[] = [];
      for (let i = 1; i <= 7; i++) entries.push(entry(i % 2 ? MAIN_LOOP : 'a1', Math.ceil(i / 2), `row ${i}`));
      await m.rec.ingest('s1', batch(...entries));
      const newest = await m.rec.page('s1', null, 3, null);
      expect(newest.entries.map((e) => e.text)).toEqual(['row 5', 'row 6', 'row 7']);
      expect(newest.olderBefore).toBe(5);
      expect(newest.total).toBe(7);
      const older = await m.rec.page('s1', newest.olderBefore, 3, null);
      expect(older.entries.map((e) => e.text)).toEqual(['row 2', 'row 3', 'row 4']);
      const oldest = await m.rec.page('s1', older.olderBefore, 3, null);
      expect(oldest.entries.map((e) => e.text)).toEqual(['row 1']);
      expect(oldest.olderBefore).toBeNull();
      const agent = await m.rec.page('s1', null, 2, 'a1');
      expect(agent.entries.map((e) => e.text)).toEqual(['row 4', 'row 6']);
      expect(agent.olderBefore).toBe(4);
      expect(agent.total).toBe(3);
      expect((await m.rec.page('s1', agent.olderBefore, 2, 'a1')).olderBefore).toBeNull();
      expect((await m.rec.page('s1', null, 99_999, null)).entries).toHaveLength(7);
      expect((await m.rec.page('s1', null, 0, null)).entries).toHaveLength(7);
      expect(await m.rec.page('nope', null, 5, null)).toEqual({ entries: [], olderBefore: null, total: 0 });
    });
  });

  describe('the session limit and the disk budget', () => {
    const hundred = 'x'.repeat(100);

    it('stops the recording with a limit mark at the entry that would pass the limit, and stores nothing after it', async () => {
      const m = await running();
      m.s.settings = { ...m.s.settings, sessionMb: 400 / MB };
      expect(await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, hundred), entry(MAIN_LOOP, 2, hundred), entry(MAIN_LOOP, 3, hundred), entry(MAIN_LOOP, 4, hundred)))).toBe(2);
      expect(await m.rec.grant('s1')).toMatchObject({ state: 'limit', limit: 'session', consent: { chosen: false }, loops: [] });
      const rows = (await m.rec.page('s1', null, 10, null)).entries;
      expect(rows.map((r) => r.kind)).toEqual(['tool', 'tool', 'limit']);
      expect(rows[2]!.text).toContain('size limit');
      expect(await m.rec.capturing('s1')).toBe(false);
      expect(m.trails).toEqual([{ kind: 'limit', sessionId: 's1', which: 'session', bytes: 330 }]);
      expect(await m.rec.view('s1')).toMatchObject({ state: 'limit', limit: 'session' });
    });

    it('does not count an entry it already holds against the limit', async () => {
      const m = await running();
      m.s.settings = { ...m.s.settings, sessionMb: 400 / MB };
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, hundred), entry(MAIN_LOOP, 2, hundred)));
      expect(await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, hundred), entry(MAIN_LOOP, 2, hundred)))).toBe(0);
      expect((await m.rec.grant('s1')).state).toBe('recording');
    });

    it('stops every running recording when the budget is reached, and takes no new one while the total is at it', async () => {
      const m = await running();
      m.rec.noteOption('s2', true);
      await m.rec.start('s2', [MAIN_LOOP], 'Ed', META);
      m.s.settings = { ...m.s.settings, budgetMb: 400 / MB };
      expect(await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, hundred), entry(MAIN_LOOP, 2, hundred)))).toBe(2);
      expect(await m.rec.ingest('s2', batch(entry(MAIN_LOOP, 1, hundred)))).toBe(0);
      expect(await m.rec.grant('s2')).toMatchObject({ state: 'limit', limit: 'budget' });
      expect(await m.rec.grant('s1')).toMatchObject({ state: 'limit', limit: 'budget' });
      expect(m.trails.map((t) => t.kind === 'limit' && t.which)).toEqual(['budget', 'budget']);
      expect((await m.rec.page('s1', null, 10, null)).entries.at(-1)?.kind).toBe('limit');
      expect(await m.rec.totalBytes()).toBeGreaterThanOrEqual(400);
      expect(await m.rec.start('s3', [MAIN_LOOP], 'Ed', META)).toBe('budget');
    });
  });

  describe('starting while the budget is nearly full', () => {
    it('refuses a start when less than one request is left under the budget, and accepts one while that much is left', async () => {
      const m = await running();
      m.s.settings = { ...m.s.settings, budgetMb: 1 }; // 1,048,576 bytes
      const big = 'x'.repeat(100_000);
      const seqs = [1, 2, 3, 4, 5];
      await m.rec.ingest('s1', batch(...seqs.map((n) => entry(MAIN_LOOP, n, big))));
      expect(await m.rec.totalBytes() + RECORDING_START_HEADROOM_BYTES).toBeLessThanOrEqual(MB);
      expect(await m.rec.start('s2', [MAIN_LOOP], 'Ed', META)).toBe('ok');
      await m.rec.ingest('s1', batch(...[6, 7].map((n) => entry(MAIN_LOOP, n, big))));
      expect(await m.rec.totalBytes() + RECORDING_START_HEADROOM_BYTES).toBeGreaterThan(MB);
      expect(await m.rec.totalBytes()).toBeLessThan(MB); // under the budget, yet no room for a new recording
      expect(await m.rec.start('s3', [MAIN_LOOP], 'Ed', META)).toBe('budget');
    });
  });

  describe('expiry, part by part', () => {
    it('removes each part keepHours after it was recorded, and shows the oldest part that is left as the time it goes', async () => {
      const m = await running({ chunkRows: 3 });
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, 'early 1'), entry(MAIN_LOOP, 2, 'early 2')));
      m.s.now = T0 + 3 * HOUR_MS;
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 3, 'later 1'), entry(MAIN_LOOP, 4, 'later 2'), entry(MAIN_LOOP, 5, 'later 3')));
      expect((await m.rec.grant('s1')).keptUntil).toBe(T0 + 6 * HOUR_MS);
      expect(await m.rec.purge(T0 + 6 * HOUR_MS)).toMatchObject({ entries: 0 }); // not older than six hours yet
      m.s.now = T0 + 6 * HOUR_MS + 1;
      const out = await m.rec.purge();
      expect(out).toMatchObject({ entries: 2, sessions: 1 });
      expect(out.bytes).toBeGreaterThan(0);
      expect((await m.rec.page('s1', null, 10, null)).entries.map((e) => e.text)).toEqual(['later 1', 'later 2', 'later 3']);
      expect((await m.rec.grant('s1')).keptUntil).toBe(T0 + 9 * HOUR_MS);
      expect(await m.rec.totals()).toMatchObject({ recordings: 1 });
    });

    it('removes in chunks, honors a short keep time at once, and compacts the file when it removed something', async () => {
      const m = await running({ chunkRows: 3, exclusive: true });
      await m.rec.ingest('s1', batch(...Array.from({ length: 7 }, (_, i) => entry(MAIN_LOOP, i + 1))));
      m.s.settings = { ...m.s.settings, keepHours: 1 };
      m.s.now = T0 + HOUR_MS + 5;
      expect(await m.rec.purge()).toEqual({ entries: 7, bytes: expect.any(Number), sessions: 1, freed: 0 });
      expect(m.compacted).toHaveBeenCalledTimes(1);
      expect((await m.rec.purge()).freed).toBe(0);
      expect(m.compacted).toHaveBeenCalledTimes(1);
      // the session is still running, so its empty recording stays
      expect(await m.rec.has('s1')).toBe(true);
      expect(await m.rec.grant('s1')).toMatchObject({ state: 'recording', bytes: 0, keptUntil: T0 + 2 * HOUR_MS + 5 });
    });

    it('drops a recording that expired completely, unless it is still running', async () => {
      const m = await running();
      m.rec.noteOption('s2', true);
      await m.rec.start('s2', [MAIN_LOOP], 'Ed', META);
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)));
      await m.rec.stop('s1', 'Ed');
      m.s.now = T0 + 7 * HOUR_MS;
      await m.rec.purge();
      expect(await m.rec.has('s1')).toBe(false);
      expect(await m.rec.has('s2')).toBe(true);
      m.s.live.delete('s2');
      await m.rec.purge();
      expect(await m.rec.has('s2')).toBe(false);
    });

    it('keeps a chosen but empty recording until keepHours after it was started, then drops it once its session is gone', async () => {
      const m = await running();
      m.s.live.delete('s1'); // not live, so only the clock can keep it
      m.s.now = T0 + 5 * HOUR_MS;
      await m.rec.purge();
      expect(await m.rec.has('s1')).toBe(true); // empty, but started less than six hours ago
      m.s.now = T0 + 6 * HOUR_MS + 1;
      await m.rec.purge();
      expect(await m.rec.has('s1')).toBe(false);
    });
  });

  describe('deleting', () => {
    it('removes the recording and its entries, stops capture at once, and reports what went', async () => {
      const m = await running({ hold: true });
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1), entry(MAIN_LOOP, 2)));
      const bytes = (await m.rec.grant('s1')).bytes;
      const pending = m.rec.removeMany(['s1', 'missing']);
      await m.gate.entered;
      expect(await m.rec.has('s1')).toBe(false);
      expect(await m.rec.capturing('s1')).toBe(false);
      m.gate.open();
      const out = await pending;
      expect(out).toMatchObject({ entries: 2, sessions: 1, bytes, freed: 0, each: [{ sessionId: 's1', name: 'billing', entries: 2, bytes }] });
      expect((await m.rec.page('s1', null, 10, null)).entries).toEqual([]);
      expect(await m.rec.removeMany(['s1'])).toEqual({ entries: 0, sessions: 0, bytes: 0, freed: 0, each: [] });
    });

    it('removes a long recording in chunks', async () => {
      const m = await running({ chunkRows: 2 });
      await m.rec.ingest('s1', batch(...Array.from({ length: 5 }, (_, i) => entry(MAIN_LOOP, i + 1))));
      const out = await m.rec.removeSession('s1');
      expect(out.entries).toBe(5);
      expect((await m.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM rec_entries'))?.c).toBe(0);
    });

    it("removes the recordings of sessions the main database no longer holds, and only those", async () => {
      const m = await running();
      m.rec.noteOption('s2', true);
      await m.rec.start('s2', [MAIN_LOOP], 'Ed', META);
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)));
      expect(await m.rec.dropMissingSessions((id) => id === 's2')).toBe(1);
      expect(await m.rec.has('s1')).toBe(false);
      expect(await m.rec.has('s2')).toBe(true);
      expect(await m.rec.dropMissingSessions(() => true)).toBe(0);
    });
  });

  describe('a /clear', () => {
    it('carries a running recording over to the new session with its starter, once, and only for the orchestrator', async () => {
      const m = await running();
      m.s.live.add('s9');
      expect(await m.rec.carryOver('s1', 's9', META)).toBe(true);
      expect(await m.rec.grant('s9')).toMatchObject({ state: 'recording', loops: [MAIN_LOOP], startedBy: 'Ed', startedAt: T0 });
      expect(await m.rec.stateFor('s1')).toBe('stopped');
      expect(m.trails).toEqual([{ kind: 'carried', sessionId: 's9', from: 's1', by: 'Ed' }]);
      // the new session already has a recording, and the old one is no longer running
      expect(await m.rec.carryOver('s1', 's9', META)).toBe(false);
    });

    it('carries nothing over when the old session was not recording, did not record the orchestrator, or the flag is off', async () => {
      const m = make();
      expect(await m.rec.carryOver('s1', 's9', META)).toBe(false);
      await m.rec.start('s1', ['a1'], 'Ed', META);
      expect(await m.rec.carryOver('s1', 's9', META)).toBe(false);
      await m.rec.start('s1', [MAIN_LOOP], 'Ed', META);
      m.s.flag = false;
      expect(await m.rec.carryOver('s1', 's9', META)).toBe(false);
      expect(await m.rec.has('s9')).toBe(false);
    });

    it('carries nothing over to a session whose recording is still being deleted', async () => {
      const m = await running({ hold: true });
      await m.rec.start('s9', [MAIN_LOOP], 'Ed', META);
      const pending = m.rec.removeMany(['s9']);
      await m.gate.entered;
      expect(await m.rec.carryOver('s1', 's9', META)).toBe(false);
      m.gate.open();
      await pending;
    });
  });

  const prompt = (loop: string, seq: number, text: string, at: number): RecordingEntry => ({ loop, seq, at, kind: 'prompt', text });

  describe('a prompt delivered from Podium', () => {
    it('writes nothing of its own: only the mod entry that matches it is stored, with the sender as its marker', async () => {
      const m = await running({}, [MAIN_LOOP]);
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: T0 + 10, text: `Answer from Ed: use password=hunter2 and ${SECRET}`, by: 'Ed' });
      expect((await m.rec.page('s1', null, 10, null)).entries).toEqual([]);
      // the mod redacted its copy its own way; the text still matches the delivered one
      await m.rec.ingest('s1', batch(prompt(MAIN_LOOP, 1, 'Answer from Ed:   use password=[redacted] and [redacted]', T0 + 12), prompt(MAIN_LOOP, 2, 'typed by the person', T0 + 13)));
      const rows = (await m.rec.page('s1', null, 10, null)).entries;
      expect(rows.map((r) => [r.kind, r.by, r.at, r.text])).toEqual([
        ['prompt', 'Ed', T0 + 12, 'Answer from Ed:   use password=[redacted] and [redacted]'],
        ['prompt', undefined, T0 + 13, 'typed by the person'],
      ]);
    });

    it('marks only an entry whose text is exactly the delivered one (whitespace folded), and each delivery only once', async () => {
      const m = await running({}, [MAIN_LOOP]);
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: T0, text: 'please also update the guide', by: 'Boss' });
      await m.rec.ingest('s1', batch(prompt(MAIN_LOOP, 1, 'Message from Boss: please also update the guide', T0 + 5), prompt(MAIN_LOOP, 2, 'please  also\nupdate the guide', T0 + 6), prompt(MAIN_LOOP, 3, 'please also update the guide', T0 + 7)));
      expect((await m.rec.page('s1', null, 10, null)).entries.map((r) => r.by)).toEqual([undefined, 'Boss', undefined]);
    });

    it('does not let a short message mark a later, longer prompt that merely contains it (or the reverse)', async () => {
      const m = await running({}, [MAIN_LOOP]);
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: T0, text: 'ok', by: 'Ed' });
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: T0, text: 'run the whole suite again please', by: 'Ed' });
      await m.rec.ingest('s1', batch(prompt(MAIN_LOOP, 1, 'ok, now run the migration', T0 + 1), prompt(MAIN_LOOP, 2, 'run the whole suite', T0 + 2)));
      expect((await m.rec.page('s1', null, 10, null)).entries.map((r) => r.by)).toEqual([undefined, undefined]);
      await m.rec.ingest('s1', batch(prompt(MAIN_LOOP, 3, 'ok', T0 + 3)));
      expect((await m.rec.page('s1', null, 10, null)).entries.map((r) => r.by)).toEqual([undefined, undefined, 'Ed']);
    });

    it('forgets a message taken back, and takes no sender from the mod for a prompt', async () => {
      const m = await running({}, [MAIN_LOOP]);
      m.rec.forgetPodiumPrompt('nobody', 'dlv_x'); // a session it knows nothing about
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: T0, text: 'taken back', by: 'Ed' }, 'dlv_1');
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: T0, text: 'kept', by: 'Boss' }, 'dlv_2');
      m.rec.forgetPodiumPrompt('s1', 'dlv_1');
      await m.rec.ingest('s1', batch({ ...prompt(MAIN_LOOP, 1, 'taken back', T0 + 1), by: 'Mallory' }, prompt(MAIN_LOOP, 2, 'kept', T0 + 2)));
      expect((await m.rec.page('s1', null, 10, null)).entries.map((r) => [r.text, r.by])).toEqual([
        ['taken back', undefined],
        ['kept', 'Boss'],
      ]);
    });

    it('stores nothing for a delivery no mod entry ever matches', async () => {
      const m = await running({}, [MAIN_LOOP]);
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: T0, text: 'never recorded by the mod', by: 'Ed' });
      m.s.now = T0 + 2 * PODIUM_PROMPT_MATCH_MS;
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)));
      expect((await m.rec.page('s1', null, 10, null)).entries.map((r) => [r.kind, r.by])).toEqual([['tool', undefined]]);
    });

    it('does not mark a different text, another loop, a tool entry, or a prompt outside the window', async () => {
      const m = await running({}, [MAIN_LOOP, 'a1']);
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: T0, text: 'for the orchestrator', by: 'Ed' });
      await m.rec.ingest(
        's1',
        batch(
          prompt(MAIN_LOOP, 1, 'something else entirely', T0 + 1),
          prompt('a1', 1, 'for the orchestrator', T0 + 1),
          entry(MAIN_LOOP, 2, 'for the orchestrator'),
          prompt(MAIN_LOOP, 3, 'for the orchestrator', T0 + PODIUM_PROMPT_MATCH_MS + 1),
        ),
      );
      expect((await m.rec.page('s1', null, 10, null)).entries.map((r) => r.by)).toEqual([undefined, undefined, undefined, undefined]);
      // an empty delivered text matches nothing
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: T0, text: '  ', by: 'Ed' });
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: T0, text: 'a real one', by: 'Ed' });
      await m.rec.ingest('s1', batch(prompt(MAIN_LOOP, 4, 'anything', T0 + 1), prompt(MAIN_LOOP, 5, '', T0 + 1)));
      expect((await m.rec.page('s1', null, 10, null)).entries.slice(-2).map((r) => r.by)).toEqual([undefined, undefined]);
    });

    it('forgets deliveries that outlived the window, so the memory stays small', async () => {
      const m = await running({}, [MAIN_LOOP]);
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: T0, text: 'old', by: 'Ed' });
      m.s.now = T0 + PODIUM_PROMPT_MATCH_MS + 1;
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: m.s.now, text: 'new', by: 'Ed' });
      await m.rec.ingest('s1', batch(prompt(MAIN_LOOP, 1, 'old', m.s.now), prompt(MAIN_LOOP, 2, 'new', m.s.now)));
      expect((await m.rec.page('s1', null, 10, null)).entries.map((r) => r.by)).toEqual([undefined, 'Ed']);
    });

    it('is not remembered when capture is off, or for a loop nobody chose, and goes with the session', async () => {
      const m = await running({}, [MAIN_LOOP]);
      await m.rec.notePodiumPrompt('s1', 'a1', { at: T0, text: 'for an agent', by: 'Ed' });
      await m.rec.notePodiumPrompt('s2', MAIN_LOOP, { at: T0, text: 'nothing chosen', by: 'Ed' });
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: T0, text: 'forgotten with the session', by: 'Ed' });
      m.rec.forgetSession('s1');
      m.rec.noteOption('s1', true);
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: T0, text: 'kept for a moment', by: 'Ed' });
      m.rec.noteOption('s1', false);
      await m.rec.notePodiumPrompt('s1', MAIN_LOOP, { at: T0, text: 'owner has not allowed it', by: 'Ed' });
      m.rec.noteOption('s1', true);
      await m.rec.ingest('s1', batch(prompt(MAIN_LOOP, 1, 'for an agent', T0), prompt(MAIN_LOOP, 2, 'forgotten with the session', T0), prompt(MAIN_LOOP, 3, 'owner has not allowed it', T0), prompt(MAIN_LOOP, 4, 'kept for a moment', T0)));
      expect((await m.rec.page('s1', null, 10, null)).entries.map((r) => r.by)).toEqual([undefined, undefined, undefined, 'Ed']);
    });
  });

  describe('late entries of a stopped recording', () => {
    it('stores entries recorded at or before the stop, and refuses the ones after it', async () => {
      const m = await running({}, [MAIN_LOOP]);
      m.s.now = T0 + 100;
      await m.rec.stop('s1', 'Boss');
      expect(await m.rec.acceptsUntil('s1')).toBe(T0 + 100);
      expect(await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, 'before', { at: T0 + 99 }), entry(MAIN_LOOP, 2, 'at the stop', { at: T0 + 100 }), entry(MAIN_LOOP, 3, 'after', { at: T0 + 101 })))).toBe(2);
      expect((await m.rec.page('s1', null, 10, null)).entries.map((r) => r.text)).toEqual(['', 'before', 'at the stop']);
      expect((await m.rec.grant('s1')).state).toBe('stopped');
    });

    it('accepts everything while it records, and nothing when it is off, over its limit, deleted, or the owner turned the option off', async () => {
      const m = await running({}, [MAIN_LOOP]);
      expect(await m.rec.acceptsUntil('s1')).toBe(Number.POSITIVE_INFINITY);
      await m.rec.stop('s1', 'Boss');
      m.rec.noteOption('s1', false);
      expect(await m.rec.acceptsUntil('s1')).toBeNull();
      m.rec.noteOption('s1', true);
      m.s.flag = false;
      expect(await m.rec.acceptsUntil('s1')).toBeNull();
      m.s.flag = true;
      expect(await m.rec.acceptsUntil('nope')).toBeNull();
      m.s.settings = { ...m.s.settings, sessionMb: 100 / MB };
      await db.exec('TRUNCATE rec_entries, rec_sessions RESTART IDENTITY'); // the cases below are separate stores in the SQLite test
      const lim = make();
      lim.rec.noteOption('s1', true);
      await lim.rec.start('s1', [MAIN_LOOP], 'Ed', META);
      lim.s.settings = { ...lim.s.settings, sessionMb: 100 / MB };
      await lim.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, 'x'.repeat(200))));
      expect((await lim.rec.grant('s1')).state).toBe('limit');
      expect(await lim.rec.acceptsUntil('s1')).toBeNull();
      await db.exec('TRUNCATE rec_entries, rec_sessions RESTART IDENTITY');
      const del = await running({}, [MAIN_LOOP]);
      await del.rec.removeMany(['s1']);
      expect(await del.rec.acceptsUntil('s1')).toBeNull();
    });

    it('does not turn a stopped recording into a limit one when a late entry would pass the limit; it just stores no more', async () => {
      const m = await running({}, [MAIN_LOOP]);
      await m.rec.stop('s1', 'Boss');
      m.s.settings = { ...m.s.settings, sessionMb: 200 / MB };
      expect(await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, 'x'.repeat(300), { at: T0 })))).toBe(0);
      expect(await m.rec.grant('s1')).toMatchObject({ state: 'stopped', limit: null });
      expect(m.trails).toEqual([]);
    });
  });

  describe('what everyone sees, and what the Admin lists', () => {
    it('shows the state, the starter, every loop with whether it is recorded and when it goes, and no text', async () => {
      const m = await running({}, [MAIN_LOOP]);
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, 'SECRET BODY')));
      const v = (await m.rec.view('s1'))!;
      expect(v).toMatchObject({ state: 'recording', startedBy: 'Ed', ownerAllows: true, keptUntil: T0 + 6 * HOUR_MS, limit: null });
      expect(v.loops).toEqual([
        { loop: MAIN_LOOP, name: 'Orchestrator', recorded: true },
        { loop: 'a1', name: 'agent a1', recorded: false },
      ]);
      expect(JSON.stringify(v)).not.toContain('SECRET BODY');
      expect(await m.rec.view('s2')).toBeNull();
      expect((await m.rec.loopInfo('s2')).every((l) => !l.recorded)).toBe(true);
    });

    it('lists recordings for the Admin with labels, state and size, filtered and paged', async () => {
      const m = await running();
      m.rec.noteOption('s2', true);
      await m.rec.start('s2', [MAIN_LOOP], 'Boss', { name: 'api', project: null, owner: 'Alex' });
      m.rec.noteOption('s3', true);
      await m.rec.start('s3', ['a1'], 'Boss', { name: 'web', project: null, owner: null });
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)));
      await m.rec.stop('s2', 'Boss');
      const all = await m.rec.adminList({ page: 1, pageSize: 25 });
      expect(all.total).toBe(3);
      expect(all.totals).toMatchObject({ recordings: 3, running: 2 });
      const byId = Object.fromEntries(all.rows.map((r) => [r.sessionId, r]));
      expect(byId.s1).toMatchObject({ state: 'recording', label: 'orchestrator and 1 agent', loops: 2, startedBy: 'Ed', owner: 'Ed' });
      expect(byId.s2).toMatchObject({ state: 'stopped', label: 'orchestrator' });
      expect(byId.s3).toMatchObject({ label: '1 agent' });
      expect((await m.rec.adminList({ page: 1, pageSize: 25, state: 'stopped' })).rows.map((r) => r.sessionId)).toEqual(['s2']);
      expect((await m.rec.adminList({ page: 1, pageSize: 25, q: 'ALEX' })).rows.map((r) => r.sessionId)).toEqual(['s2']);
      expect((await m.rec.adminList({ page: 1, pageSize: 25, q: 'web' })).rows.map((r) => r.sessionId)).toEqual(['s3']);
      expect((await m.rec.adminList({ page: 1, pageSize: 25, q: 's1' })).rows.map((r) => r.sessionId)).toEqual(['s1']);
      const paged = await m.rec.adminList({ page: 2, pageSize: 2 });
      expect(paged).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(paged.rows).toHaveLength(1);
      expect(await m.rec.adminList({ page: 0, pageSize: 0 })).toMatchObject({ page: 1, pageSize: 25 });
    });

    it('lists the same recordings for Stored activity, with its filters, totals and distinct values', async () => {
      const m = await running();
      m.rec.noteOption('s2', true);
      await m.rec.start('s2', [MAIN_LOOP], 'Boss', { name: 'api', project: 'acme/api', owner: 'Alex' });
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1), entry(MAIN_LOOP, 2)));
      m.s.now = T0 + 3 * HOUR_MS;
      await m.rec.ingest('s2', batch(entry(MAIN_LOOP, 1)));
      const all = await m.rec.listStored({}, 1, 25);
      expect(all).toMatchObject({ total: 2, page: 1, pageSize: 25, projects: ['acme/api', 'acme/billing'], owners: ['Alex', 'Ed'] });
      expect(all.totals).toMatchObject({ entries: 3, sessions: 2, fileBytes: 0 });
      expect(all.match).toMatchObject({ entries: 3, sessions: 2 });
      expect(all.rows.map((r) => r.sessionId)).toEqual(['s2', 's1']);
      expect(all.rows[1]).toMatchObject({ name: 'billing', owner: 'Ed', live: true, entries: 2, oldestAt: T0 });
      const f = async (x: object) => (await m.rec.listStored(x, 1, 25)).rows.map((r) => r.sessionId);
      expect(await f({ q: 'API' })).toEqual(['s2']);
      expect(await f({ q: 's1' })).toEqual(['s1']);
      expect(await f({ project: 'acme/billing' })).toEqual(['s1']);
      expect(await f({ owner: 'Alex' })).toEqual(['s2']);
      expect(await f({ olderThanDays: 0.1 })).toEqual(['s1']);
      expect(await f({ from: T0 + HOUR_MS })).toEqual(['s2']);
      expect(await f({ to: T0 + HOUR_MS })).toEqual(['s1']);
      expect((await m.rec.listStored({}, 3, 1)).rows.map((r) => r.sessionId)).toEqual([]);
      expect(await m.rec.listStored({}, 0, 0)).toMatchObject({ page: 1, pageSize: 25 });
      expect(await m.rec.idsFor({ ids: ['x'] })).toEqual(['x']);
      expect(await m.rec.idsFor({ match: { owner: 'Ed' } })).toEqual(['s1']);
      expect((await m.rec.idsFor({ all: true })).sort()).toEqual(['s1', 's2']);
    });

    it('reads the recordings table once per request, and returns the same totals and rows', async () => {
      const m = await running();
      m.rec.noteOption('s2', true);
      await m.rec.start('s2', [MAIN_LOOP], 'Boss', { name: 'api', project: 'acme/api', owner: 'Alex' });
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)));
      await m.rec.ingest('s2', batch(entry(MAIN_LOOP, 1)));
      const all = vi.spyOn(m.rec as unknown as { all: () => Promise<unknown[]> }, 'all');
      const admin = await m.rec.adminList({ page: 1, pageSize: 25 });
      expect(all).toHaveBeenCalledTimes(1);
      expect(admin.totals).toEqual(await m.rec.totals());
      expect(admin.rows.map((r) => r.sessionId).sort()).toEqual(['s1', 's2']);
      all.mockClear();
      const stored = await m.rec.listStored({ owner: 'Alex' }, 1, 25);
      expect(all).toHaveBeenCalledTimes(1);
      expect(stored).toMatchObject({ total: 1, totals: { entries: 2, sessions: 2 }, match: { entries: 1, sessions: 1 } });
      expect(stored.rows.map((r) => r.sessionId)).toEqual(['s2']);
    });

    it('counts a recording with nothing stored in the Admin totals but not in Stored activity', async () => {
      const m = await running();
      expect(await m.rec.totals()).toEqual({ recordings: 1, bytes: 0, running: 1 });
      expect((await m.rec.listStored({}, 1, 25)).total).toBe(0);
    });
  });

  describe('the steps that check and write as one', () => {
    it('choose refuses an ended session and a loop the session does not have, and otherwise starts', async () => {
      const m = make();
      m.s.live.delete('s2');
      expect(await m.rec.choose('s2', [MAIN_LOOP], 'Ed', META, [MAIN_LOOP])).toBe('ended');
      expect(await m.rec.choose('s1', [MAIN_LOOP, 'zz'], 'Ed', META, [MAIN_LOOP, 'a1'])).toBe('unknown-loop');
      expect(await m.rec.has('s1')).toBe(false);
      expect(await m.rec.choose('s1', [MAIN_LOOP], 'Ed', META, [MAIN_LOOP, 'a1'])).toBe('ok');
      expect(await m.rec.has('s1')).toBe(true);
    });

    it('accept refuses an ended session (saying whether a recording is held) and one that is off, and otherwise stores and reports the states', async () => {
      const m = await running({}, [MAIN_LOOP]);
      m.s.live.delete('s1');
      expect(await m.rec.accept('s1', batch(entry(MAIN_LOOP, 1)), META)).toEqual({ kind: 'ended', held: true });
      expect(await m.rec.accept('s9', batch(entry(MAIN_LOOP, 1)), META)).toEqual({ kind: 'ended', held: false });
      m.s.live.add('s1');
      m.rec.noteOption('s1', false);
      expect(await m.rec.accept('s1', batch(entry(MAIN_LOOP, 1)), META)).toEqual({ kind: 'off' });
      m.rec.noteOption('s1', true);
      const out = await m.rec.accept('s1', batch(entry(MAIN_LOOP, 1)), { name: 'renamed', project: null, owner: 'Alex' });
      expect(out).toMatchObject({ kind: 'stored', stored: 1, before: 'recording', recording: { state: 'recording' } });
      expect((await m.rec.adminList({ page: 1, pageSize: 5 })).rows[0]).toMatchObject({ name: 'renamed', owner: 'Alex' });
    });

    it('removeFor removes the recordings a filter means, and only those', async () => {
      const m = await running();
      m.rec.noteOption('s2', true);
      await m.rec.start('s2', [MAIN_LOOP], 'Boss', { name: 'api', project: 'acme/api', owner: 'Alex' });
      await m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)));
      await m.rec.ingest('s2', batch(entry(MAIN_LOOP, 1)));
      const out = await m.rec.removeFor({ match: { owner: 'Alex' } });
      expect(out.each.map((g) => g.sessionId)).toEqual(['s2']);
      expect(await m.rec.has('s1')).toBe(true);
      expect((await m.rec.removeFor({ all: true })).sessions).toBe(1);
      expect(await m.rec.has('s1')).toBe(false);
    });

    it('works without the connection: a step and a heavy operation just run', async () => {
      const rec = new PgSessionRecordings(db, { now: () => T0, settings: () => RECORDING_DEFAULTS, flagOn: () => true, authOn: true, isLive: () => true, loopsOf: () => [] });
      rec.noteOption('s1', true);
      expect(await rec.start('s1', [MAIN_LOOP], 'Ed', META)).toBe('ok');
      expect((await rec.removeMany(['s1'])).sessions).toBe(1);
      expect(await rec.purge()).toMatchObject({ entries: 0, freed: 0 });
    });
  });
});
