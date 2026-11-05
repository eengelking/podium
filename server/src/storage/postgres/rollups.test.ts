// The daily rollups (#484) over the PostgreSQL fleet store: the database-backed tests of fleet/rollups.test.ts, run against `PgDb`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';
import { addDays, buildRollups, costFn, dayStart, peakLiveByDay, writeRollups } from '../../fleet/rollups.js';
import { DAY_MS, NOW, TODAY, at, populate, session, world, type World } from './rollupFixtures.js';

const policy = { sessionsMs: 30 * DAY_MS };

describe.skipIf(!TEST_PG)('postgres rollups', () => {
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

  const dump = async (w: World) => JSON.stringify(await Promise.all(['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily'].map((t) => w.db.all(`SELECT * FROM ${t} ORDER BY 1, 2, 3, 4, 5`))));

  it('creates the four rollup tables', async () => {
    const tables = (await db.all<{ table_name: string }>('SELECT table_name FROM information_schema.tables WHERE table_schema = ?', [MAIN_SCHEMA])).map((r) => r.table_name);
    expect(tables).toEqual(expect.arrayContaining(['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily']));
  });

  describe('buildRollups', () => {
    it('counts a session on the day it was last seen and sums priced models only', async () => {
      const w = await world(db);
      await populate(w);
      const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
      const day3 = b.usage.filter((u) => u.day === addDays(TODAY, -3));
      expect(day3).toHaveLength(1);
      expect(day3[0]).toMatchObject({ owner: 'Priya', group: 'Backend', model: 'claude-opus-5-5', project: 'demo', sessions: 1, agents: 2, unpricedSessions: 0, tokIn: 100 });
      expect(day3[0]!.costUsd).toBeGreaterThan(0);
      const p2 = b.usage.find((u) => u.day === addDays(TODAY, -2) && u.owner === 'Priya')!;
      expect(p2).toMatchObject({ sessions: 1, costUsd: 0, unpricedSessions: 1, model: 'llama-local' });
      expect(b.usage.find((u) => u.day === TODAY && u.owner === 'Priya')).toMatchObject({ sessions: 1, costUsd: 4, agents: 2 });
      expect(b.usage.some((u) => u.day === addDays(TODAY, -1) && u.owner === 'Priya' && u.costUsd === 4)).toBe(false);
      expect(b.usage.find((u) => u.owner === '')).toMatchObject({ group: '', model: '', project: '', sessions: 1 });
    });

    it('rolls outcomes, durations, failures and the fleet up without any content', async () => {
      const w = await world(db);
      await populate(w);
      const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
      expect(b.sessions.find((s) => s.day === addDays(TODAY, -3))).toMatchObject({ outcome: 'completed', plan: 'TodoWrite', blowouts: 1, maxContextPct: 91, durationS: 7200, agents: 2 });
      expect(b.sessions.find((s) => s.outcome === 'error')).toMatchObject({ model: 'llama-local', plan: 'none' });
      expect(b.sessions.find((s) => s.outcome === 'running')).toBeTruthy();
      expect(b.failures.filter((f) => f.day === addDays(TODAY, -3)).map((f) => [f.cls, f.tool, f.count]).sort()).toEqual([['permission', 'Bash', 1], ['timeout', 'WebFetch', 1]]);
      expect(b.failureSessions.filter((f) => f.cls === 'permission').map((f) => f.sessionId).sort()).toEqual(['p1', 'p3']);
      const d = b.fleet.find((f) => f.day === addDays(TODAY, -3))!;
      expect(d).toMatchObject({ activePeople: 1, activeReporters: 1, sessionsStarted: 1, peakLive: 0 });
      expect(d.reporterVersions).toEqual({ '1.2.2': 1 });
      expect(d.engineVersions).toEqual({ '2.1.301': 1 });
      expect(b.fleet.find((f) => f.day === addDays(TODAY, -1))!.sessionsStarted).toBe(2);
      const text = JSON.stringify(b);
      expect(text).not.toContain('secret');
      expect(text).not.toContain('/Users/dev');
    });

    it('ignores a failure row it cannot read and an unreadable plan', async () => {
      const w = await world(db);
      await w.fdb.upsertSession(session({ id: 'x', plan_json: '{nope', owner: 'Dana' }));
      await w.db.run("INSERT INTO agents (session_id, id, kind, type, description, status, started_at, failure_json) VALUES ('x', 'a', 'sub', 'T', 'd', 'done', 1, '{bad'), ('x', 'b', 'sub', 'T', 'd', 'done', 1, '{}')");
      const b = await buildRollups(w.fdb, costFn(undefined), 0);
      expect(b.failures).toEqual([]);
      expect(b.sessions[0]!.plan).toBe('none');
    });
  });

  describe('peakLiveByDay', () => {
    it('counts the sessions live at one second, across midnight too', async () => {
      const w = await world(db);
      const put = async (id: string, a: number, b: number) => {
        for (const t of [a, b]) await w.fdb.insertSampleIfAbsent({ session_id: id, t: Math.floor(t / 1000), tokens_total: 0, tokens_delta: 0, peak_context: 0, running_agents: 0, cost_usd: null });
      };
      await put('a', at(1, 23), at(0, 1));
      await put('b', at(1, 23) + 60_000, at(1, 23) + 120_000);
      await put('c', at(0, 5), at(0, 6));
      expect(await peakLiveByDay(w.fdb)).toEqual(new Map([[addDays(TODAY, -1), 2], [TODAY, 1]]));
    });
  });

  describe('writeRollups', () => {
    it('writes every day from the oldest stored session, once, and a second run changes nothing', async () => {
      const w = await world(db);
      await populate(w);
      const cost = costFn(w.deps.pricing());
      const first = await writeRollups(w.storage, NOW, cost, policy);
      expect(first.days).toBeGreaterThanOrEqual(4);
      const before = await dump(w);
      await writeRollups(w.storage, NOW, cost, policy);
      expect(await dump(w)).toBe(before);
      expect((await w.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM usage_daily'))!.n).toBeGreaterThanOrEqual(6);
    });

    it('does nothing but prune on an empty database', async () => {
      const w = await world(db);
      expect(await writeRollups(w.storage, NOW, costFn(undefined), policy)).toEqual({ days: 0, deleted: 0 });
    });

    it('never lowers a day\'s peak of live sessions, and reads it from the samples while they last', async () => {
      const w = await world(db);
      await populate(w);
      for (const id of ['p3', 'd1']) for (const t of [at(1, 10), at(1, 11)]) await w.fdb.insertSampleIfAbsent({ session_id: id, t: Math.floor(t / 1000), tokens_total: 0, tokens_delta: 0, peak_context: 0, running_agents: 0, cost_usd: null });
      const cost = costFn(w.deps.pricing());
      await writeRollups(w.storage, NOW, cost, policy);
      const peak = async () => (await w.db.get<{ p: number }>('SELECT peak_live_sessions AS p FROM fleet_daily WHERE day = ?', [addDays(TODAY, -1)]))!.p;
      expect(await peak()).toBe(2);
      await w.db.run('DELETE FROM samples');
      await writeRollups(w.storage, NOW, cost, policy);
      expect(await peak()).toBe(2);
    });

    it('leaves alone a day that retention may already have taken sessions from, and a day whose raw rows are gone', async () => {
      const w = await world(db);
      await populate(w);
      await w.fdb.upsertSession(session({ id: 'old', owner: 'Dana', started_at: at(40, 9), last_seen_at: at(40, 10), ended_at: at(40, 10), cost_usd: 9 }));
      const cost = costFn(w.deps.pricing());
      await w.db.run("INSERT INTO usage_daily VALUES (?, 'Dana', '', 'm', 'p', 5, 0, 7, 0, 1, 1, 1, 1)", [addDays(TODAY, -40)]);
      await writeRollups(w.storage, NOW, cost, policy);
      expect(await w.db.all('SELECT sessions FROM usage_daily WHERE day = ?', [addDays(TODAY, -40)])).toEqual([{ sessions: 5 }]);
      await w.db.run('DELETE FROM sessions WHERE id = ?', ['old']);
      await writeRollups(w.storage, NOW, cost, policy);
      expect(await w.db.all('SELECT sessions FROM usage_daily WHERE day = ?', [addDays(TODAY, -40)])).toEqual([{ sessions: 5 }]);
    });

    it('writes the day at the retention cutoff when no run has written it yet, and leaves it alone once one has (#529)', async () => {
      const w = await world(db);
      const cost = costFn(w.deps.pricing());
      await w.fdb.upsertSession(session({ id: 'edge', owner: 'Dana', started_at: at(30, 16), last_seen_at: at(30, 17), ended_at: at(30, 17), cost_usd: 2 }));
      const day = addDays(TODAY, -30);
      await writeRollups(w.storage, NOW, cost, policy);
      expect(await w.db.all('SELECT sessions FROM usage_daily WHERE day = ?', [day])).toEqual([{ sessions: 1 }]);
      expect(await w.db.all('SELECT sessions_started FROM fleet_daily WHERE day = ?', [day])).toEqual([{ sessions_started: 1 }]);
      await w.db.run('DELETE FROM sessions WHERE id = ?', ['edge']);
      await w.fdb.upsertSession(session({ id: 'edge2', owner: 'Dana', started_at: at(30, 18), last_seen_at: at(30, 19), ended_at: at(30, 19), cost_usd: 3 }));
      await writeRollups(w.storage, NOW, cost, policy);
      expect(await w.db.all('SELECT sessions, cost_usd FROM usage_daily WHERE day = ?', [day])).toEqual([{ sessions: 1, cost_usd: 2 }]);
    });

    it('rebuilds a day from what is stored when a session is gone from it', async () => {
      const w = await world(db);
      await populate(w);
      const cost = costFn(w.deps.pricing());
      await writeRollups(w.storage, NOW, cost, policy);
      await w.db.run("DELETE FROM sessions WHERE id = 'd1'");
      await writeRollups(w.storage, NOW, cost, policy);
      expect(await w.db.get("SELECT COUNT(*) AS n FROM usage_daily WHERE owner = 'Dana'")).toEqual({ n: 0 });
    });

    it('deletes rollup rows older than the rollup period, 395 days by default', async () => {
      const w = await world(db);
      const put = (day: string) => w.db.run("INSERT INTO fleet_daily VALUES (?, 1, 1, 1, 1, '{}', '{}')", [day]);
      await put(addDays(TODAY, -396));
      await put(addDays(TODAY, -394));
      await w.db.run("INSERT INTO failures_daily VALUES (?, 'x', 'c', 't', 1)", [addDays(TODAY, -400)]);
      expect((await writeRollups(w.storage, NOW, costFn(undefined), policy)).deleted).toBe(2);
      expect(await w.db.all('SELECT day FROM fleet_daily')).toEqual([{ day: addDays(TODAY, -394) }]);
      await put(addDays(TODAY, -20));
      expect((await writeRollups(w.storage, NOW, costFn(undefined), { ...policy, rollupMs: 10 * DAY_MS })).deleted).toBe(2);
    });

    it('rolls the transaction back, writing nothing, when a write fails', async () => {
      const w = await world(db);
      await populate(w);
      await w.db.exec('ALTER TABLE failures_daily RENAME TO failures_daily_off');
      try {
        await expect(writeRollups(w.storage, NOW, costFn(w.deps.pricing()), policy)).rejects.toThrow();
        expect((await w.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM usage_daily'))!.n).toBe(0);
      } finally {
        await w.db.exec('ALTER TABLE failures_daily_off RENAME TO failures_daily');
      }
    });
  });
});
