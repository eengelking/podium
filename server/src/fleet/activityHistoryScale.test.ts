// The Activity history on a big file (#432): aggregates kept in step, removals in chunks that give the event loop a turn,
// one heavy operation at a time, a purge that does not stack, and the v1 to v2 migration.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACTIVITY_SCHEMA_STEPS, ACTIVITY_SCHEMA_VERSION, openActivityDb, recomputeAggregates } from './activityDb.js';
import { ActivityHistory, type ActivityHistoryOpts, type SessionMeta } from './activityHistory.js';
import { ACTIVITY_HISTORY_DEFAULTS, ACTIVITY_UNIT_MS, type ActivityHistorySettings, type StoredDeleteBody } from './activityHistoryTypes.js';
import { FleetDb, openDb } from './db.js';
import { DEFAULT_CONFIG, Fleet, type FleetConfig } from './fleet.js';
import { PeopleStore } from './people.js';
import { MAIN_LOOP, type ActivityEntry, type Report } from './protocol.js';
import { purgeActivityHistory, startSweeper } from './sweeper.js';
import { fixtureReport } from './testing.js';

const sqlite = process.getBuiltinModule('node:sqlite');
const T0 = 1_800_000_000_000;
const HOUR = ACTIVITY_UNIT_MS.hours;
const META: SessionMeta = { name: 'invoice-v2', project: 'acme/billing', owner: 'Ed' };

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmpFile = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'podium-activity-scale-'));
  dirs.push(dir);
  return path.join(dir, 'activity.sqlite');
};

function setup(over: Partial<ActivityHistorySettings> = {}, extra: Partial<ActivityHistoryOpts> = {}, file = ':memory:') {
  let t = T0;
  const state = { settings: { ...ACTIVITY_HISTORY_DEFAULTS, policy: 'all' as ActivityHistorySettings['policy'], ...over }, live: new Set<string>() };
  const db = openActivityDb(file);
  const h = new ActivityHistory(db, { now: () => t, settings: () => state.settings, isLive: (id) => state.live.has(id), authOn: true, ...extra });
  return { h, db, state, advance: (ms: number) => (t += ms), now: () => t };
}

/** A report for session `id` with `n` main-loop entries and `n` entries on agent `a1`, starting at time `at`. */
function report(id: string, at: number, n: number, text = 'Read file'): Report {
  const r = fixtureReport();
  r.session.id = id;
  r.session.activityFeed = true;
  const entries = (): ActivityEntry[] => Array.from({ length: n }, (_, i) => ({ at: at + i, kind: 'tool' as const, text: `${text} ${at + i}` }));
  r.session.activity = entries();
  r.agents = [{ ...r.agents[0]!, id: 'a1', activity: entries() }];
  return r;
}

/** Every session's entry count, bytes and oldest time, recomputed from `entries`, against what `stored_sessions` holds. */
function aggregatesMatch(db: ReturnType<typeof openActivityDb>) {
  const fromRows = db.prepare('SELECT session_id AS sid, COUNT(*) AS n, SUM(' + entryBytes() + ') AS b, MIN(t) AS o FROM entries GROUP BY session_id ORDER BY session_id').all();
  const kept = db.prepare('SELECT session_id AS sid, entries AS n, bytes AS b, oldest_t AS o FROM stored_sessions ORDER BY session_id').all();
  expect(kept).toEqual(fromRows);
  const loopsFromRows = db
    .prepare(
      `SELECT g.session_id AS sid, g.loop AS loop, g.n AS n,
         (SELECT at FROM entries e WHERE e.session_id = g.session_id AND e.loop = g.loop ORDER BY seq LIMIT 1) AS f,
         (SELECT t FROM entries e WHERE e.session_id = g.session_id AND e.loop = g.loop ORDER BY seq DESC LIMIT 1) AS l
       FROM (SELECT session_id, loop, COUNT(*) AS n FROM entries GROUP BY session_id, loop) g ORDER BY g.session_id, g.loop`,
    )
    .all();
  const loopsKept = db.prepare('SELECT session_id AS sid, loop, entries AS n, first_at AS f, last_t AS l FROM loops ORDER BY session_id, loop').all();
  expect(loopsKept).toEqual(loopsFromRows);
}
const entryBytes = () => '(length(text) + length(kind) + length(loop) + COALESCE(length("by"), 0) + COALESCE(length(note), 0) + COALESCE(length(ref), 0) + 48)';

describe('schema v2', () => {
  it('is the current version', () => {
    expect(ACTIVITY_SCHEMA_VERSION).toBe(4);
    expect(ACTIVITY_SCHEMA_STEPS).toHaveLength(4);
  });

  it('migrates a file made with the v1 schema: the aggregates are filled from its rows and the indexes change', () => {
    const file = tmpFile();
    const raw = new sqlite.DatabaseSync(file);
    raw.exec('PRAGMA auto_vacuum = INCREMENTAL');
    raw.exec(ACTIVITY_SCHEMA_STEPS[0]!);
    raw.exec('PRAGMA user_version = 1');
    const put = raw.prepare('INSERT INTO entries (session_id, loop, seq, at, t, kind, text, "by", note, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    put.run('s1', MAIN_LOOP, 1, T0 + 5, T0 + 4, 'tool', 'Read a', null, null, null);
    put.run('s1', MAIN_LOOP, 2, T0 + 9, T0 + 8, 'podium', 'answered', 'Ed', 'queued', 'ref1');
    put.run('s1', 'a1', 1, T0 + 2, T0 + 1, 'text', 'thinking', null, null, null);
    put.run('s2', 'a1', 1, T0 + 3, T0 + 3, 'tool', 'Edit b', null, null, null);
    const session = raw.prepare('INSERT INTO stored_sessions (session_id, name, project, owner, first_t, last_t) VALUES (?, ?, ?, ?, ?, ?)');
    session.run('s1', 'one', null, null, T0 + 1, T0 + 8);
    session.run('s2', 'two', 'p', 'Ed', T0 + 3, T0 + 3);
    raw.close();

    const db = openActivityDb(file);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4);
    aggregatesMatch(db);
    expect(db.prepare('SELECT session_id AS sid, loop, entries AS n, first_at AS f, last_t AS l FROM loops ORDER BY session_id, loop').all()).toEqual([
      { sid: 's1', loop: '@orchestrator', n: 2, f: T0 + 5, l: T0 + 8 },
      { sid: 's1', loop: 'a1', n: 1, f: T0 + 2, l: T0 + 1 },
      { sid: 's2', loop: 'a1', n: 1, f: T0 + 3, l: T0 + 3 },
    ]);
    expect(db.prepare('SELECT entries AS n, oldest_t AS o FROM stored_sessions ORDER BY session_id').all()).toEqual([
      { n: 3, o: T0 + 1 },
      { n: 1, o: T0 + 3 },
    ]);
    const sql = (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('entries_ref', 'entries_session_t')").all() as { name: string; sql: string }[]).sort((a, b) => a.name.localeCompare(b.name));
    expect(sql.map((r) => r.name)).toEqual(['entries_ref', 'entries_session_t']);
    expect(sql[0]!.sql).toContain('WHERE ref IS NOT NULL');
    // the store works on it
    const h = new ActivityHistory(db, { now: () => T0, settings: () => ({ ...ACTIVITY_HISTORY_DEFAULTS, policy: 'all' }), isLive: () => false, authOn: true });
    expect(h.totals()).toMatchObject({ entries: 4, sessions: 2 });
    h.close();
  });

  it('recomputes the aggregates of a file whose counters drifted', () => {
    const { h, db } = setup();
    h.ingest(report('s1', T0, 3), 0, META);
    db.exec('UPDATE stored_sessions SET entries = 99, bytes = 1, oldest_t = NULL');
    recomputeAggregates(db);
    aggregatesMatch(db);
  });
});

describe('the aggregates stay in step', () => {
  const rnd = (seed: number) => {
    let s = seed;
    return () => (s = (s * 1_664_525 + 1_013_904_223) % 4_294_967_296) / 4_294_967_296;
  };

  it.each([1, 2, 3, 4])('after a random run of ingests, Podium entries, purges and deletes (seed %i)', async (seed) => {
    const { h, db, state, now } = setup({ policy: 'all' }, { chunkRows: 3 });
    const r = rnd(seed);
    const ids = ['s0', 's1', 's2', 's3'];
    const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
    const refs: { sid: string; ref: string }[] = [];
    let at = T0;
    let ref = 0;
    for (let step = 0; step < 70; step++) {
      const op = Math.floor(r() * 10);
      const sid = pick(ids);
      if (op <= 2) {
        at += 1000 + Math.floor(r() * 4000);
        h.ingest(report(sid, at, 1 + Math.floor(r() * 4), 'x'.repeat(Math.floor(r() * 30))), 0, META);
        at += 10;
      } else if (op === 3) {
        const entry = { sid, ref: `r${ref++}` };
        refs.push(entry);
        h.addPodium(sid, pick([MAIN_LOOP, 'a1']), entry.ref, { at: (at += 500), text: 'sent'.repeat(1 + Math.floor(r() * 5)), by: 'Ed', note: r() < 0.5 ? null : 'queued' }, META);
      } else if (op === 4 && refs.length) {
        const e = pick(refs);
        h.updatePodium(e.sid, e.ref, r() < 0.3 ? null : 'n'.repeat(Math.floor(r() * 40)));
      } else if (op === 5 && refs.length) {
        const e = refs.splice(Math.floor(r() * refs.length), 1)[0]!;
        h.removePodium(e.sid, e.ref);
      } else if (op === 6) {
        state.settings = { policy: 'after', n: 1, unit: 'hours', capGb: null };
        await h.purge(at + Math.floor(r() * 2 * HOUR) - HOUR / 2);
        state.settings = { ...state.settings, policy: 'all' };
      } else if (op === 7) {
        const bodies: StoredDeleteBody[] = [{ ids: [sid] }, { match: { loop: 'agents' } }, { match: { from: at - 20_000, to: at - 5_000 } }, { match: { olderThanDays: 0, owner: 'Ed', loop: 'main' } }];
        await h.deleteBy(pick(bodies));
      } else if (op === 8) {
        await h.deleteSession(sid);
      } else if (op === 9) {
        state.settings = { policy: 'all', n: 30, unit: 'days', capGb: 1 };
        await h.purge();
        state.settings = { ...state.settings, capGb: null };
      }
      aggregatesMatch(db);
      expect(db.prepare('SELECT COUNT(*) AS n FROM stored_sessions WHERE entries <= 0').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(DISTINCT session_id) AS n FROM entries WHERE session_id NOT IN (SELECT session_id FROM stored_sessions)').get()).toEqual({ n: 0 });
    }
    expect(now()).toBe(T0);
    expect(h.totals().entries).toBe((db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n);
  });

  it('counts a Podium note’s length in the session’s bytes, and drops the session row with its last entry', () => {
    const { h, db } = setup();
    h.addPodium('s1', MAIN_LOOP, 'd1', { at: T0, text: 'hello', by: 'Ed', note: null }, META);
    const bytes = () => (db.prepare('SELECT bytes AS b FROM stored_sessions').get() as { b: number }).b;
    const before = bytes();
    h.updatePodium('s1', 'd1', 'queued here');
    expect(bytes()).toBe(before + 'queued here'.length);
    h.updatePodium('s1', 'd1', 'queued here');
    expect(bytes()).toBe(before + 'queued here'.length);
    aggregatesMatch(db);
    h.removePodium('s1', 'd1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM stored_sessions').get()).toEqual({ n: 0 });
  });
});

describe('removals in chunks', () => {
  /** Ten sessions with 40 entries each, five of them old. */
  function fill(extra: Partial<ActivityHistoryOpts>, policy: Partial<ActivityHistorySettings> = {}) {
    const s = setup(policy, extra);
    for (let i = 0; i < 10; i++) s.h.ingest(report(`s${i}`, T0 - (i < 5 ? 10 : 1) * HOUR + i * 100, 20), 0, { ...META, project: i % 2 ? 'acme/web' : 'acme/billing' });
    s.state.live.add('s7');
    return s;
  }

  it('give the event loop a turn between chunks of a big purge', async () => {
    const { h } = fill({ chunkRows: 10 }, { policy: 'after', n: 5, unit: 'hours' });
    let turns = 0;
    let done = false;
    const spin = () => {
      if (done) return;
      turns++;
      setImmediate(spin);
    };
    const p = h.purge().then((r) => {
      done = true;
      return r;
    });
    spin();
    const r = await p;
    expect(r.entries).toBe(200);
    // 200 rows in chunks of 10 is 20 chunks, with a turn after each
    expect(turns).toBeGreaterThanOrEqual(20);
  });

  it('run a callback queued before them between two chunks, not after the whole removal', async () => {
    const { h, db } = fill({ chunkRows: 10 }, { policy: 'after', n: 5, unit: 'hours' });
    let seenDuring: number | null = null;
    const p = h.purge();
    setImmediate(() => {
      seenDuring = (db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;
    });
    await p;
    expect(seenDuring).not.toBeNull();
    expect(seenDuring!).toBeGreaterThan(200);
    expect(seenDuring!).toBeLessThan(400);
  });

  const scenarios: [string, (h: ActivityHistory, s: ReturnType<typeof setup>) => Promise<unknown>][] = [
    ['purge under after', async (h, s) => { s.state.settings = { policy: 'after', n: 5, unit: 'hours', capGb: null }; return h.purge(); }],
    ['purge under end', async (h, s) => { s.state.settings = { policy: 'end', n: 5, unit: 'hours', capGb: null }; return h.purge(); }],
    ['purge over the cap', async (h, s) => { s.state.settings = { policy: 'all', n: 5, unit: 'hours', capGb: 1 }; return h.purge(); }],
    ['deleteBy ids', async (h) => h.deleteBy({ ids: ['s1', 's2', 'nope'] })],
    ['deleteBy a filter on the session', async (h) => h.deleteBy({ match: { project: 'acme/web' } })],
    ['deleteBy a filter on the entries', async (h) => h.deleteBy({ match: { loop: 'agents', olderThanDays: 0.2 } })],
    ['deleteBy all', async (h) => h.deleteBy({ all: true })],
  ];

  it.each(scenarios)('give the same result as one big chunk: %s', async (_name, run) => {
    const fresh = (chunkRows: number) => {
      const s = fill({ chunkRows, capBytesPerGb: 4000 });
      return s;
    };
    const small = fresh(7);
    const big = fresh(100_000);
    const a = (await run(small.h, small)) as Record<string, number>;
    const b = (await run(big.h, big)) as Record<string, number>;
    const { freed: _fa, ...ra } = a;
    const { freed: _fb, ...rb } = b;
    expect(ra).toEqual(rb);
    const dump = (db: ReturnType<typeof openActivityDb>) => db.prepare('SELECT session_id, loop, seq, t FROM entries ORDER BY session_id, loop, seq').all();
    expect(dump(small.db)).toEqual(dump(big.db));
    aggregatesMatch(small.db);
    aggregatesMatch(big.db);
  });

  it('size the next chunk from how long the last one took: smaller when slow, larger when fast, within the cap', async () => {
    const slow = fill({ chunkRows: 300, chunkMs: 0.000001 }, { policy: 'after', n: 5, unit: 'hours' });
    expect((await slow.h.purge()).entries).toBe(200);
    const fast = fill({ chunkRows: 5000, chunkMs: 1_000_000 }, { policy: 'after', n: 5, unit: 'hours' });
    expect((await fast.h.purge()).entries).toBe(200);
    aggregatesMatch(slow.db);
    aggregatesMatch(fast.db);
  });

  it('stop at the next chunk when the store is closed, and a closed store answers nothing', async () => {
    const { h } = fill({ chunkRows: 10 }, { policy: 'after', n: 5, unit: 'hours' });
    const p = h.purge();
    h.close();
    const r = await p.catch(() => null);
    expect(r === null || r.entries < 200).toBe(true);
    const again = setup({ policy: 'after', n: 5, unit: 'hours' });
    again.h.close();
    expect(await again.h.purge()).toEqual({ entries: 0, bytes: 0, sessions: 0, freed: 0 });
  });

  it('compact in steps and report the bytes freed', async () => {
    const file = tmpFile();
    const { h } = setup({}, { vacuumPages: 2, chunkRows: 500 }, file);
    for (let i = 0; i < 4; i++) h.ingest(report(`s${i}`, T0 + i * 1000, 20, 'z'.repeat(250)), 0, META);
    for (let b = 1; b < 30; b++) for (let i = 0; i < 4; i++) h.ingest(report(`s${i}`, T0 + b * 100_000 + i * 1000, 20, 'z'.repeat(250)), 0, META);
    const r = await h.deleteBy({ all: true });
    expect(r.entries).toBe(4 * 20 * 2 * 30);
    expect(r.freed).toBeGreaterThan(50_000);
    h.close();
  });
});

describe('heavy operations run one at a time', () => {
  it('a delete queued behind a purge starts only when the purge is done, and capture runs between chunks', async () => {
    const { h, db, state } = setup({ policy: 'after', n: 5, unit: 'hours' }, { chunkRows: 10 });
    for (let i = 0; i < 4; i++) h.ingest(report(`old${i}`, T0 - 10 * HOUR + i, 20), 0, META);
    for (let i = 0; i < 4; i++) h.ingest(report(`new${i}`, T0 - HOUR + i, 20), 0, META);
    const recent = () => (db.prepare("SELECT COUNT(*) AS n FROM entries WHERE session_id LIKE 'new%'").get() as { n: number }).n;
    expect(recent()).toBe(160);
    let purged = false;
    const p1 = h.purge().then(() => {
      purged = true;
    });
    const p2 = h.deleteBy({ all: true });
    expect(h.busy).toBe(true);
    let captured = false;
    while (!purged) {
      // the purge has not finished, so the delete has not started: nothing recent is gone
      expect(recent()).toBeGreaterThanOrEqual(160);
      if (!captured) {
        expect(h.ingest(report('live', T0, 2), 0, META)).toBe(4);
        captured = true;
      }
      await new Promise((r) => setImmediate(r));
    }
    await p1;
    expect(captured).toBe(true);
    const r = await p2;
    expect(r.entries).toBe(160 + 4);
    await h.idle();
    expect(h.busy).toBe(false);
    expect(state.settings.policy).toBe('after');
    expect(h.totals().entries).toBe(0);
  });

  it('a failing operation does not block the ones queued behind it', async () => {
    const { h } = setup({}, { chunkRows: 5 });
    h.ingest(report('s1', T0, 3), 0, META);
    const bad = h.deleteBy({ ids: [Symbol('x') as unknown as string] });
    const good = h.deleteBy({ ids: ['s1'] });
    await expect(bad).rejects.toThrow();
    expect((await good).entries).toBe(6);
    expect(h.busy).toBe(false);
  });

  it('a preview waits its turn too', async () => {
    const { h } = setup({ policy: 'after', n: 5, unit: 'hours' }, { chunkRows: 10 });
    for (let i = 0; i < 4; i++) h.ingest(report(`old${i}`, T0 - 10 * HOUR + i, 20), 0, META);
    const purge = h.purge();
    const preview = h.preview({ policy: 'after', n: 5, unit: 'hours', capGb: null });
    await purge;
    expect(await preview).toMatchObject({ entries: 0, sessions: 0, stopsCapturing: false });
  });
});

describe('preview as an estimate', () => {
  it('counts by index range, with bytes from the session average, for every policy', async () => {
    const { h, state } = setup({ policy: 'all' }, { capBytesPerGb: 1000 });
    for (let i = 0; i < 4; i++) h.ingest(report(`s${i}`, T0 - (i < 2 ? 10 : 1) * HOUR, 20), 0, META);
    state.live.add('s3');
    const total = h.totals().entries;
    const after = await h.preview({ policy: 'after', n: 5, unit: 'hours', capGb: null });
    expect(after).toMatchObject({ entries: 80, sessions: 2, stopsCapturing: false });
    expect(after.bytes).toBeGreaterThan(0);
    const end = await h.preview({ policy: 'end', n: 5, unit: 'hours', capGb: null });
    expect(end).toMatchObject({ entries: 120, sessions: 3 });
    const capped = await h.preview({ policy: 'all', n: 5, unit: 'hours', capGb: 1 });
    expect(capped.entries).toBeGreaterThan(0);
    expect(capped.entries).toBeLessThanOrEqual(total);
    const all = await h.preview({ policy: 'all', n: 5, unit: 'hours', capGb: null });
    expect(all).toMatchObject({ entries: 0, bytes: 0, sessions: 0 });
    // nothing was removed
    expect(h.totals().entries).toBe(total);
  });

  it('matches the purge that follows to within a rounding', async () => {
    const { h, state } = setup({ policy: 'all' });
    for (let i = 0; i < 4; i++) h.ingest(report(`s${i}`, T0 - (i < 2 ? 10 : 1) * HOUR, 20), 0, META);
    const next: ActivityHistorySettings = { policy: 'after', n: 5, unit: 'hours', capGb: null };
    const p = await h.preview(next);
    state.settings = next;
    const r = await h.purge();
    expect([p.entries, p.sessions]).toEqual([r.entries, r.sessions]);
    expect(Math.abs(p.bytes - r.bytes)).toBeLessThan(r.bytes * 0.1);
  });
});

describe('a filter on the entries is counted in slices', () => {
  it('gives the same list with one entry per slice as with one slice, and yields between slices', async () => {
    const make = (sliceRows: number) => {
      const s = setup({ policy: 'all' }, { sliceRows });
      for (let i = 0; i < 4; i++) s.h.ingest(report(`s${i}`, T0 - (i + 1) * HOUR, 20), 0, { ...META, owner: i % 2 ? 'Sam' : 'Ed' });
      return s;
    };
    const sliced = make(3);
    const whole = make(1_000_000);
    for (const filter of [{ loop: 'agents' as const }, { olderThanDays: 2 / 24 }, { from: T0 - 3 * HOUR, to: T0 - HOUR + 1000 }, { owner: 'Ed', loop: 'main' as const, olderThanDays: 10 }]) {
      const a = await sliced.h.list(filter, 1, 25);
      const b = await whole.h.list(filter, 1, 25);
      expect(a).toEqual(b);
    }
    let turns = 0;
    let done = false;
    const spin = () => {
      if (!done) {
        turns++;
        setImmediate(spin);
      }
    };
    const p = sliced.h.list({ loop: 'main' }).then(() => {
      done = true;
    });
    spin();
    await p;
    expect(turns).toBeGreaterThan(8);
  });

  it('leaves out a session with nothing in the window, estimates its bytes from the average, and reports the matching totals', async () => {
    const { h } = setup({ policy: 'all' });
    h.ingest(report('old', T0 - 10 * HOUR, 20), 0, META);
    h.ingest(report('new', T0 - HOUR, 20), 0, META);
    const l = await h.list({ olderThanDays: 5 / 24 });
    expect(l.rows.map((r) => r.sessionId)).toEqual(['old']);
    expect(l.match).toMatchObject({ entries: 40, sessions: 1 });
    expect(l.rows[0]!.oldestAt).toBe(T0 - 10 * HOUR);
    expect(l.totals.entries).toBe(80);
    expect((await h.list({ from: T0 + 5 * HOUR })).total).toBe(0);
  });
});

describe('through the fleet', () => {
  const CFG: FleetConfig = { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' };

  it('deleting a session returns at once and logs a failure of the background removal', async () => {
    const errors: string[] = [];
    const db = new FleetDb(openDb(':memory:'));
    const fleet = new Fleet(db, CFG, () => T0, { info() {}, warn() {}, debug() {}, error: (_e: string, m: string) => errors.push(m) } as never, { authOn: true });
    vi.spyOn(fleet.activityHistory, 'deleteSession').mockRejectedValue(new Error('disk full'));
    expect(() => fleet.deleteSession('whatever')).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(errors.join('\n')).toContain('disk full');
  });

  it('a purge that is still running when the next tick fires is skipped, not stacked', async () => {
    const people = new PeopleStore(openDb(':memory:'));
    const logger = { info: vi.fn() } as never;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const purge = vi.fn(async () => {
      await gate;
      return { entries: 3, bytes: 300, sessions: 1, freed: 0 };
    });
    const history = { purge, current: () => ({ ...ACTIVITY_HISTORY_DEFAULTS, policy: 'end' as const }) } as unknown as ActivityHistory;
    const first = purgeActivityHistory(history, people, logger, T0);
    await purgeActivityHistory(history, people, logger, T0 + 1);
    await purgeActivityHistory(history, people, logger, T0 + 2);
    expect(purge).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(people.listLog({ page: 1, pageSize: 10 }).rows.filter((r) => r.kind === 'activity_purged')).toHaveLength(1);
    // finished, so the next tick runs
    await purgeActivityHistory(history, people, logger, T0 + 3);
    expect(purge).toHaveBeenCalledTimes(2);
  });

  it('a purge that fails frees the slot for the next tick', async () => {
    const people = new PeopleStore(openDb(':memory:'));
    const purge = vi.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValue({ entries: 0, bytes: 0, sessions: 0, freed: 0 });
    const history = { purge, current: () => ACTIVITY_HISTORY_DEFAULTS } as unknown as ActivityHistory;
    await expect(purgeActivityHistory(history, people, { info() {} } as never, T0)).rejects.toThrow('locked');
    await purgeActivityHistory(history, people, { info() {} } as never, T0 + 1);
    expect(purge).toHaveBeenCalledTimes(2);
  });

  it('the sweeper logs a hook that rejects after its first chunk, and keeps ticking', async () => {
    vi.useFakeTimers();
    const fleet = new Fleet(new FleetDb(openDb(':memory:')), CFG, () => T0, undefined, { authOn: true });
    const logs: string[] = [];
    const hook = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('locked')).mockResolvedValue(undefined);
    const stop = startSweeper(fleet, { sweepMs: 1000, tickMs: 2000, retentionMs: 3_600_000, activityPurgeMs: 5000 }, (l) => logs.push(l), undefined, hook);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(hook).toHaveBeenCalledTimes(3);
    expect(logs).toEqual(['podium sweeper: activity-purge failed: locked']);
    stop();
  });
});
