import { describe, it, expect } from 'vitest';
import { DAY_MS, NOW, TODAY, populate, world } from '../fleet/rollupFixtures.js';
import { addDays, costFn, writeRollups } from '../fleet/rollups.js';

// The report and rollup queries that moved out of reports.ts and rollups.ts (#313). The reports' and rollups' own tests read through
// them; these check each one against the stored data directly.
describe('report queries', () => {
  it('read the sessions, agents, reporters and samples a period covers', async () => {
    const w = await filled();
    const from = NOW - 5 * DAY_MS;
    const sessions = await w.fdb.sessionsSince(from);
    expect(sessions.map((s) => s.id)).toEqual(expect.arrayContaining(['p1', 'p3', 'p4']));
    expect(sessions.find((s) => s.id === 'p1')?.grp).toBe('Backend');
    expect(await w.fdb.agentCountsSince(from)).toEqual(expect.arrayContaining([{ id: 'p1', n: 2 }, { id: 'p4', n: 2 }]));
    expect(await w.fdb.reporterKeysSince(from)).toEqual(expect.arrayContaining([{ id: 'p1', k: 'm1' }]));
    expect((await w.fdb.failureRowsSince(from)).map((r) => r.id).sort()).toEqual(['p1', 'p1', 'p3']);
    expect(await w.fdb.sampleSpans()).toEqual([{ a: expect.any(Number), b: expect.any(Number) }]);
    expect(await w.fdb.oldestSessionSeen()).toBe(Math.min(...sessions.map((s) => s.last_seen_at), ...(await w.fdb.sessionsSince(0)).map((s) => s.last_seen_at)));
  });

  it('read the people, groups and reporters', async () => {
    const w = await filled();
    expect((await w.fdb.knownPeople()).map((p) => [p.name, p.grp]).sort()).toEqual([['Dana', null], ['Priya', 'Backend'], ['Quiet', null]]);
    expect(await w.fdb.ownerGroupNames()).toEqual(expect.arrayContaining([{ n: 'Priya', g: 'Backend' }, { n: 'Dana', g: '' }]));
    expect(await w.fdb.countReporters()).toBe(1);
    expect(await w.fdb.countGroups()).toBeGreaterThanOrEqual(1);
  });

  it('write and read back the rollup tables', async () => {
    const w = await filled();
    const days = await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), { sessionsMs: 30 * DAY_MS });
    expect(days.days).toBeGreaterThan(0);
    expect(await w.fdb.rollupOldestDay('usage_daily')).toBe(addDays(TODAY, -3));
    const stats = await w.fdb.rollupStats('usage_daily');
    expect(stats.n).toBeGreaterThan(0);
    expect((await w.fdb.rollupRows('usage_daily', addDays(TODAY, -3), addDays(TODAY, -3))).map((r) => r.owner)).toEqual(['Priya']);
    expect(await w.fdb.storedPeak(TODAY)).toEqual(expect.any(Number));
    expect(await w.fdb.storedPeak('1999-01-01')).toBeUndefined();
    expect((await w.fdb.rollupDaysBefore(TODAY)).sort()).toContain(addDays(TODAY, -3));
    expect(await w.fdb.deleteRollupsBefore(TODAY)).toBeGreaterThan(0);
    expect(await w.fdb.rollupOldestDay('usage_daily')).toBe(TODAY);
    await w.fdb.deleteRollupsFrom(TODAY);
    expect(await w.fdb.rollupOldestDay('usage_daily')).toBeNull();
  });

  it('read the Admin log newest first, of one kind when asked, and stop at the limit', async () => {
    const w = await filled();
    for (const [i, kind] of ['a', 'b', 'a'].entries()) await w.storage.people.log(kind, `entry ${i}`, 'test', NOW + i);
    expect((await w.fdb.adminLogRows(NOW, NOW + 10, undefined, 10)).map((r) => r.detail)).toEqual(['entry 2', 'entry 1', 'entry 0']);
    expect((await w.fdb.adminLogRows(NOW, NOW + 10, 'a', 10)).map((r) => r.detail)).toEqual(['entry 2', 'entry 0']);
    expect(await w.fdb.adminLogRows(NOW, NOW + 10, undefined, 1)).toHaveLength(1);
  });
});

async function filled() {
  const w = world();
  await populate(w);
  return w;
}
