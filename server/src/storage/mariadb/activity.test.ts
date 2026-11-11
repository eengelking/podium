// The activity connection over MariaDB (#823): the cases of `sqlite/activity.test.ts` that belong to the connection and the Activity
// history. The read-then-write sequences that were atomic while the calls were synchronous must stay so with every call awaited, a
// chunked removal must still give other callers a turn between chunks, and the activity pool's lock must not be the main pool's.
// The cases that need the session recordings (`MariaSessionRecordings`, ported on its own) are in `recordings.test.ts`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MariaDbConn, parseTarget } from './conn.js';
import { ACTIVITY_MIGRATIONS, ACTIVITY_STEPS, MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { MariaActivityConnection } from './activity.js';
import { MariaActivityHistory, entryBytesSql } from './activityHistory.js';
import { TEST_MARIADB, createTestDatabase, type TestDatabase, truncate } from './testing.js';
import { ACTIVITY_HISTORY_DEFAULTS, type ActivityHistorySettings } from '../../fleet/activityHistoryTypes.js';
import { MAIN_LOOP, RECORDING_DEFAULTS, type ActivityEntry, type RecordingSettings, type Report } from '../../fleet/protocol.js';
import { fixtureReport } from '../../fleet/testing.js';
import type { RecordingTrail } from '../rows.js';

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const META = { name: 'billing', project: 'acme/billing', owner: 'Ed' };

const tool = (at: number, text = `Read f${at}`): ActivityEntry => ({ at, kind: 'tool', text });

function report(id: string, main: ActivityEntry[]): Report {
  const r = fixtureReport();
  r.session.activityFeed = true;
  r.session.id = id;
  r.session.activity = main;
  r.agents[0]!.activity = [];
  return r;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const later = (ms: number) => new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), ms));
const gate = () => {
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  return { open, release };
};

describe.skipIf(!TEST_MARIADB)('mariadb activity connection', () => {
  let td: TestDatabase;
  let db: MariaDbConn;
  let main: MariaDbConn;
  const extra: MariaDbConn[] = [];
  beforeAll(async () => {
    td = await createTestDatabase();
    db = new MariaDbConn({ target: parseTarget(td.url), max: 6 });
    main = new MariaDbConn({ target: parseTarget(td.url), max: 4 });
    await migrate(db, ACTIVITY_MIGRATIONS, ACTIVITY_STEPS);
    await migrate(main, MAIN_MIGRATIONS, MAIN_STEPS);
  });
  afterAll(async () => {
    await db.close();
    await main.close();
    for (const e of extra) await e.close().catch(() => undefined);
    await td.drop();
  });
  beforeEach(async () => {
    await truncate(db, 'entries', 'stored_sessions', 'loops', 'rec_sessions', 'rec_entries');
  });

  interface Knobs {
    chunkRows?: number;
    policy?: ActivityHistorySettings['policy'];
    db?: MariaDbConn;
  }

  /** The services built the way the fleet builds them, and the memory they read. */
  function world(k: Knobs = {}) {
    const conn = new MariaActivityConnection(k.db ?? db);
    const s = {
      now: T0,
      flag: true,
      live: new Set(['s1', 's2']),
      agents: ['a1'],
      history: { ...ACTIVITY_HISTORY_DEFAULTS, policy: k.policy ?? ('all' as const) } as ActivityHistorySettings,
      recording: { ...RECORDING_DEFAULTS } as RecordingSettings,
    };
    const trails: RecordingTrail[] = [];
    const act = conn.build({
      history: {
        now: () => s.now,
        settings: () => s.history,
        isLive: (id) => s.live.has(id),
        agentsOf: async () => s.agents,
        authOn: true,
        chunkRows: k.chunkRows,
      },
      recordings: {
        now: () => s.now,
        settings: () => s.recording,
        flagOn: () => s.flag,
        authOn: true,
        isLive: (id) => s.live.has(id),
        loopsOf: async () => [{ loop: MAIN_LOOP, name: 'Orchestrator' }, ...s.agents.map((a) => ({ loop: a, name: `agent ${a}` }))],
        chunkRows: k.chunkRows,
      },
    });
    act.recordings.trail = (t) => trails.push(t);
    return { conn, ...act, s, trails };
  }

  const count = async (d: MariaDbConn, sql: string, ...p: (string | number)[]): Promise<number> => (await d.get<{ n: number }>(sql, p))!.n;

  /** The aggregates of the Activity history agree with the rows they summarize, and no entry is left without its session. */
  async function expectConsistent(d: MariaDbConn = db): Promise<void> {
    const rows = await d.all<{ sid: string; n: number; b: number }>(`SELECT session_id AS sid, COUNT(*) AS n, SUM(${entryBytesSql()}) AS b FROM entries GROUP BY session_id`);
    const kept = new Map(rows.map((r) => [r.sid, r]));
    for (const r of rows) {
      const s = await d.get('SELECT entries, bytes FROM stored_sessions WHERE session_id = ?', [r.sid]);
      expect(s, `entries of ${r.sid} have a stored session`).toBeDefined();
      expect(s).toEqual({ entries: r.n, bytes: r.b });
    }
    for (const s of await d.all<{ sid: string; entries: number }>('SELECT session_id AS sid, entries FROM stored_sessions')) {
      expect(s.entries, `stored session ${s.sid} holds entries`).toBeGreaterThan(0);
      expect(kept.get(s.sid)?.n).toBe(s.entries);
    }
    for (const l of await d.all<{ sid: string; loop: string; entries: number }>('SELECT session_id AS sid, loop, entries FROM loops')) {
      expect(await count(d, 'SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND loop = ?', l.sid, l.loop)).toBe(l.entries);
    }
  }

  describe('the activity pool has its own lock', () => {
    it('serves the activity calls while a transaction holds the main database', async () => {
      const w = world();
      const g = gate();
      const held = main.tx(() => g.open);
      expect(await Promise.race([w.history.totals(), later(1500)])).toMatchObject({ entries: 0 });
      g.release();
      await held;
    });

    it('serves the main database while a step holds the activity connection', async () => {
      const w = world();
      const g = gate();
      const held = w.conn.lock.run(() => g.open);
      expect(await Promise.race([main.get('SELECT 1 AS x'), later(1500)])).toEqual({ x: 1 });
      g.release();
      await held;
    });

    it('keeps its tables apart from the main ones in the one database, with a record of steps of its own', async () => {
      const made = (steps: typeof MAIN_STEPS) => new Set(steps.flatMap((x) => x.statements).flatMap((q) => /CREATE TABLE IF NOT EXISTS "?(\w+)"?/.exec(q)?.[1] ?? []));
      const mine = made(ACTIVITY_STEPS);
      const theirs = made(MAIN_STEPS);
      expect([...mine].sort()).toEqual(['entries', 'loops', 'rec_entries', 'rec_sessions', 'stored_sessions']);
      expect([...mine].filter((t) => theirs.has(t))).toEqual([]);
      expect(await count(db, `SELECT MAX(version) AS n FROM ${ACTIVITY_MIGRATIONS}`)).toBe(ACTIVITY_STEPS.at(-1)!.version);
    });
  });

  describe('a chunked removal still gives other callers a turn between chunks', () => {
    it('lets reads and writes run between the chunks of a purge', async () => {
      const w = world({ policy: 'after', chunkRows: 2 });
      w.s.history = { ...w.s.history, policy: 'after', n: 1, unit: 'hours' };
      await w.history.ingest(report('s1', Array.from({ length: 20 }, (_, i) => tool(T0 - 5 * HOUR + i))), 0, META);
      expect((await w.history.totals()).entries).toBe(20);
      let done = false;
      const purge = w.history.purge(T0).then((r) => ((done = true), r));
      const seen: number[] = [];
      let wroteDuring = 0;
      for (let i = 0; !done; i++) {
        await tick();
        seen.push((await w.history.totals()).entries);
        // a capture for another session lands between two chunks
        const stored = await w.history.ingest(report(`n${i}`, [tool(T0 + i)]), 0, META);
        if (!done) wroteDuring += stored;
      }
      const r = await purge;
      expect(r.entries).toBe(20);
      // the purge was not one step: reads saw it part way, and captures were stored while it ran
      expect(seen.some((n) => n > 3 && n < 23)).toBe(true);
      expect(wroteDuring).toBeGreaterThan(0);
      await expectConsistent();
      expect(await count(db, "SELECT COUNT(*) AS n FROM entries WHERE session_id = 's1'")).toBe(0);
    });

    it('stops at the next chunk when the connection closes, and leaves the totals matching the rows', async () => {
      const own = new MariaDbConn({ target: parseTarget(td.url), max: 4 });
      extra.push(own);
      const w = world({ policy: 'after', chunkRows: 2, db: own });
      w.s.history = { ...w.s.history, policy: 'after', n: 1, unit: 'hours' };
      await w.history.ingest(report('s1', Array.from({ length: 40 }, (_, i) => tool(T0 - 5 * HOUR + i))), 0, META);
      const purge = w.history.purge(T0);
      await tick();
      await w.conn.close();
      await purge;
      const left = await count(db, 'SELECT COUNT(*) AS n FROM entries');
      expect(left).toBeGreaterThan(0);
      expect(left).toBeLessThan(40);
      expect(await count(db, 'SELECT entries AS n FROM stored_sessions')).toBe(left);
      await expectConsistent();
    });

    it('waits for a running removal and every queued step when it closes', async () => {
      const own = new MariaDbConn({ target: parseTarget(td.url), max: 4 });
      extra.push(own);
      const w = world({ db: own });
      let ran = false;
      void w.conn.lock.run(async () => {
        await later(50);
        ran = true;
      });
      await w.conn.close();
      expect(ran).toBe(true);
    });
  });

  describe('a deleted session against a concurrent write', () => {
    it('leaves rows and totals that agree however the writes fall between the chunks', async () => {
      for (const chunk of [1, 2, 3, 7]) {
        await truncate(db, 'entries', 'stored_sessions', 'loops');
        const w = world({ chunkRows: chunk });
        await w.history.ingest(report('s1', Array.from({ length: 12 }, (_, i) => tool(T0 + i))), 0, META);
        const gone = w.history.deleteSession('s1');
        let more = 0;
        for (let i = 0; i < 14; i++) {
          await tick();
          // the same session keeps reporting while its rows go
          more += await w.history.ingest(report('s1', [tool(T0 + 100 + i)]), 0, META);
          await w.history.ingest(report('other', [tool(T0 + 200 + i)]), 0, META);
        }
        await gone;
        expect(more).toBeGreaterThan(0);
        await expectConsistent();
        expect(await count(db, "SELECT COUNT(*) AS n FROM entries WHERE session_id = 'other'")).toBe(14);
      }
    });
  });

  describe('a write that lands after any one step of a removal', () => {
    /** An Activity history whose steps are plain, with a write after the `k`th one: the interleaving the lock allows between two steps. */
    function afterStep(k: number, policy: ActivityHistorySettings['policy'] = 'all') {
      let steps = 0;
      let write: (() => Promise<void>) | null = null;
      const state = { ...ACTIVITY_HISTORY_DEFAULTS, policy, ...(policy === 'after' ? { n: 1, unit: 'hours' as const } : {}) } as ActivityHistorySettings;
      const h = new MariaActivityHistory(db, {
        now: () => T0,
        settings: () => state,
        isLive: () => false,
        authOn: true,
        chunkRows: 2,
        step: async (fn) => {
          const out = await fn();
          if (steps++ === k) await write?.();
          return out;
        },
      });
      return { h, onStep: (w: () => Promise<void>) => (write = w) };
    }

    it('keeps the totals and the rows of a deleted session in step', async () => {
      let landed = 0;
      for (let k = 0; k < 30; k++) {
        await truncate(db, 'entries', 'stored_sessions', 'loops');
        const { h, onStep } = afterStep(k);
        await h.ingest(report('s1', Array.from({ length: 7 }, (_, i) => tool(T0 + i))), 0, META);
        onStep(async () => {
          landed += await h.ingest(report('s1', [tool(T0 + 1000 + k)]), 0, META);
        });
        await h.deleteSession('s1');
        await expectConsistent();
      }
      expect(landed).toBeGreaterThan(5);
    });

    it('keeps the totals and the rows of a purge in step', async () => {
      for (let k = 0; k < 30; k++) {
        await truncate(db, 'entries', 'stored_sessions', 'loops');
        const { h, onStep } = afterStep(k, 'after');
        await h.ingest(report('s1', Array.from({ length: 7 }, (_, i) => tool(T0 - 5 * HOUR + i))), 0, META);
        onStep(async () => void (await h.ingest(report('s1', [tool(T0 + 1000 + k)]), 0, META)));
        await h.purge(T0);
        await expectConsistent();
      }
    });

    it('keeps the totals and the rows of a delete by filter in step', async () => {
      for (let k = 0; k < 30; k++) {
        await truncate(db, 'entries', 'stored_sessions', 'loops');
        const { h, onStep } = afterStep(k);
        await h.ingest(report('s1', Array.from({ length: 5 }, (_, i) => tool(T0 + i))), 0, META);
        await h.ingest(report('s2', Array.from({ length: 5 }, (_, i) => tool(T0 + i))), 0, META);
        onStep(async () => void (await h.ingest(report('s1', [tool(T0 + 1000 + k)]), 0, META)));
        await h.deleteBy({ all: true });
        await expectConsistent();
      }
    });
  });

  describe('a purge against a concurrent write', () => {
    it('keeps what was written while old entries went, and the totals agree', async () => {
      const w = world({ policy: 'after', chunkRows: 3 });
      w.s.history = { ...w.s.history, policy: 'after', n: 1, unit: 'hours' };
      await w.history.ingest(report('s1', Array.from({ length: 24 }, (_, i) => tool(T0 - 5 * HOUR + i))), 0, META);
      const purge = w.history.purge(T0);
      let stored = 0;
      for (let i = 0; i < 10; i++) {
        await tick();
        stored += await w.history.ingest(report('s1', [tool(T0 + i, `new ${i}`)]), 0, META);
      }
      const r = await purge;
      expect(r.entries).toBe(24);
      expect(stored).toBe(10);
      await expectConsistent();
      expect(await count(db, 'SELECT COUNT(*) AS n FROM entries')).toBe(10);
      expect(await count(db, 'SELECT entries AS n FROM stored_sessions WHERE session_id = ?', 's1')).toBe(10);
    });
  });

  describe('a session that is not in the main database any more', () => {
    it('keeps the activity of one that came back between the two looks', async () => {
      const w = world();
      await w.history.ingest(report('s1', [tool(T0), tool(T0 + 1)]), 0, META);
      await w.history.ingest(report('s2', [tool(T0)]), 0, META);
      const asked: string[] = [];
      // `s1` is missing at the first look and back at the second; `s2` stays missing
      let back = false;
      const exists = async (id: string) => {
        asked.push(id);
        if (id === 's1' && asked.filter((a) => a === 's1').length > 1) back = true;
        return back && id === 's1';
      };
      expect(await w.history.dropMissingSessions(exists)).toBe(1);
      expect(await count(db, "SELECT COUNT(*) AS n FROM entries WHERE session_id = 's1'")).toBe(2);
      expect(await count(db, "SELECT COUNT(*) AS n FROM entries WHERE session_id = 's2'")).toBe(0);
      await expectConsistent();
      expect(await w.history.dropMissingSessions(async () => true)).toBe(0);
    });
  });

  describe('what the server read from the main database answers as the synchronous read did', () => {
    it('lists the orchestrator and the agents to watch', async () => {
      const w = world();
      const direct = new MariaActivityHistory(db, { now: () => T0, settings: () => w.s.history, isLive: () => false, agentsOf: () => w.s.agents, authOn: true });
      expect(await w.history.loopsToWatch('s1')).toEqual(direct.loopsToWatch('s1'));
      w.s.agents = [];
      expect(await w.history.loopsToWatch('s1')).toEqual(direct.loopsToWatch('s1'));
      expect(await w.history.loopsToWatch('s1')).toEqual([MAIN_LOOP]);
    });

    it('answers the memory-only calls at once', () => {
      const w = world();
      expect(w.history.enabled()).toBe(true);
      expect(w.history.current()).toBe(w.s.history);
      expect(w.history.lastPurge).toBeNull();
      expect(w.history.busy).toBe(false);
      w.history.forgetSession('s1');
    });
  });

  describe('a Podium entry for a session', () => {
    it('is stored, updated and taken back through the connection as through the class', async () => {
      const w = world();
      const direct = new MariaActivityHistory(db, { now: () => T0, settings: () => w.s.history, isLive: () => false, authOn: true });
      const e = { at: T0, text: 'rerun the tests', by: 'Ed', note: null };
      await w.history.addPodium('s1', MAIN_LOOP, 'ref1', e, META);
      await w.history.updatePodium('s1', 'ref1', 'queued');
      expect(await w.history.page('s1', MAIN_LOOP, null)).toEqual(await direct.page('s1', MAIN_LOOP, null));
      expect(await w.history.note('s1', MAIN_LOOP)).toEqual(await direct.note('s1', MAIN_LOOP));
      await w.history.removePodium('s1', 'ref1');
      expect(await w.history.totals()).toEqual(await direct.totals());
      await expectConsistent();
      expect(await w.history.deleteSession('nobody')).toEqual({ entries: 0, sessions: 0, bytes: 0, freed: 0 });
    });
  });

  describe('the heavy calls through the connection', () => {
    it('previews, lists and runs idle through the history api', async () => {
      const w = world();
      await w.history.ingest(report('s1', [tool(T0 - 5 * HOUR)]), 0, META);
      expect(await w.history.preview(ACTIVITY_HISTORY_DEFAULTS)).toMatchObject({ entries: 1, stopsCapturing: true });
      expect((await w.history.list({})).total).toBe(1);
      expect(await w.history.deleteBy({ ids: ['s1'] }, async () => true)).toMatchObject({ entries: 1 });
      await w.history.idle();
      expect(w.history.busy).toBe(false);
    });
  });

  describe('the main database is untouched by the activity pool', () => {
    it('keeps its own rows when the activity connection is busy', async () => {
      const w = world();
      await w.history.ingest(report('s1', [tool(T0)]), 0, META);
      expect(await count(main, 'SELECT COUNT(*) AS n FROM sessions')).toBe(0);
      expect(await count(db, 'SELECT COUNT(*) AS n FROM entries')).toBe(1);
    });
  });
});
