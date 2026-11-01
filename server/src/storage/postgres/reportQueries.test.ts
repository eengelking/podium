import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';
import { DAY_MS, NOW, TODAY, populate, world } from './rollupFixtures.js';
import { addDays, costFn, writeRollups } from '../../fleet/rollups.js';

// The report and rollup queries (#313) on PostgreSQL: the SQLite adapter's checks against the stored data, plus the orderings and the
// types PostgreSQL needs stated.
describe.skipIf(!TEST_PG)('postgres report queries', () => {
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

  const filled = async () => {
    const w = await world(db);
    await populate(w);
    return w;
  };

  it('read the sessions, agents, reporters and samples a period covers', async () => {
    const w = await filled();
    const from = NOW - 5 * DAY_MS;
    const sessions = await w.fdb.sessionsSince(from);
    expect(sessions.map((s) => s.id)).toEqual(expect.arrayContaining(['p1', 'p3', 'p4']));
    expect(sessions.map((s) => s.last_seen_at)).toEqual([...sessions.map((s) => s.last_seen_at)].sort((a, b) => a - b));
    expect(sessions.find((s) => s.id === 'p1')?.grp).toBe('Backend');
    expect(await w.fdb.agentCountsSince(from)).toEqual([{ id: 'p1', n: 2 }, { id: 'p3', n: 1 }, { id: 'p4', n: 2 }]);
    expect(await w.fdb.reporterKeysSince(from)).toEqual([{ id: 'p1', k: 'm1' }, { id: 'p3', k: 'm1' }]);
    expect((await w.fdb.failureRowsSince(from)).map((r) => r.id)).toEqual(['p1', 'p1', 'p3']);
    expect(await w.fdb.sampleSpans()).toEqual([{ a: expect.any(Number), b: expect.any(Number) }]);
    expect(await w.fdb.oldestSessionSeen()).toBe(Math.min(...(await w.fdb.sessionsSince(0)).map((s) => s.last_seen_at)));
  });

  it('read nothing from an empty database', async () => {
    const w = await world(db);
    expect(await w.fdb.oldestSessionSeen()).toBeNull();
    expect(await w.fdb.sampleSpans()).toEqual([]);
    expect(await w.fdb.countReporters()).toBe(0);
    expect(await w.fdb.rollupStats('usage_daily')).toEqual({ n: 0, d: null });
  });

  it('read the people, groups and reporters', async () => {
    const w = await filled();
    expect((await w.fdb.knownPeople()).map((p) => [p.name, p.grp])).toEqual([['Priya', 'Backend'], ['Dana', null], ['Quiet', null]]);
    expect((await w.fdb.knownPeople()).map((p) => typeof p.last)).toEqual(['number', 'number', 'object']);
    expect(await w.fdb.ownerGroupNames()).toEqual([{ n: 'Priya', g: 'Backend' }, { n: 'Dana', g: '' }, { n: 'Quiet', g: '' }]);
    expect(await w.fdb.countReporters()).toBe(1);
    expect(await w.fdb.countGroups()).toBe(2);
  });

  it('write and read back the rollup tables', async () => {
    const w = await filled();
    const days = await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), { sessionsMs: 30 * DAY_MS });
    expect(days.days).toBeGreaterThan(0);
    expect(await w.fdb.rollupOldestDay('usage_daily')).toBe(addDays(TODAY, -3));
    const stats = await w.fdb.rollupStats('usage_daily');
    expect(stats.n).toBeGreaterThan(0);
    expect(typeof stats.n).toBe('number');
    expect((await w.fdb.rollupRows('usage_daily', addDays(TODAY, -3), addDays(TODAY, -3))).map((r) => r.owner)).toEqual(['Priya']);
    for (const t of ['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily'] as const) {
      const rows = await w.fdb.rollupRows(t, addDays(TODAY, -10), TODAY);
      expect(rows.map((r) => r.day)).toEqual([...rows.map((r) => r.day)].sort());
    }
    expect(await w.fdb.storedPeak(TODAY)).toEqual(expect.any(Number));
    expect(await w.fdb.storedPeak('1999-01-01')).toBeUndefined();
    expect((await w.fdb.rollupDaysBefore(TODAY)).sort()).toContain(addDays(TODAY, -3));
    expect(await w.fdb.deleteRollupsBefore(TODAY)).toBeGreaterThan(0);
    expect(await w.fdb.rollupOldestDay('usage_daily')).toBe(TODAY);
    await w.fdb.deleteRollupsFrom(TODAY);
    expect(await w.fdb.rollupOldestDay('usage_daily')).toBeNull();
  });

  it('keep a stored peak of live sessions from going down', async () => {
    const w = await world(db);
    const day = { day: '2026-10-01', activePeople: 1, activeReporters: 1, sessionsStarted: 2, peakLive: 0, reporterVersions: { '1.0.0': 1 }, engineVersions: {} };
    await w.fdb.upsertFleetDays([{ day, peak: 5 }]);
    await w.fdb.upsertFleetDays([{ day: { ...day, sessionsStarted: 3 }, peak: 2 }]);
    expect(await w.fdb.storedPeak('2026-10-01')).toBe(5);
    expect((await w.fdb.rollupRows('fleet_daily', '2026-10-01', '2026-10-01'))[0]).toMatchObject({ sessions_started: 3, reporter_versions_json: '{"1.0.0":1}' });
    await w.fdb.upsertFleetDays([{ day, peak: 9 }]);
    expect(await w.fdb.storedPeak('2026-10-01')).toBe(9);
  });

  it('read the Admin log newest first, of one kind when asked, and stop at the limit', async () => {
    const w = await filled();
    for (const [i, kind] of ['a', 'b', 'a'].entries()) await w.storage.people.log(kind, `entry ${i}`, 'test', NOW + i);
    expect((await w.fdb.adminLogRows(NOW, NOW + 10, undefined, 10)).map((r) => r.detail)).toEqual(['entry 2', 'entry 1', 'entry 0']);
    expect((await w.fdb.adminLogRows(NOW, NOW + 10, 'a', 10)).map((r) => r.detail)).toEqual(['entry 2', 'entry 0']);
    expect(await w.fdb.adminLogRows(NOW, NOW + 10, undefined, 1)).toHaveLength(1);
  });
});
