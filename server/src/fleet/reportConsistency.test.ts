// A report reads the rollup tables, the live build and the sessions in several storage calls (#313). Each call takes a
// few milliseconds here, as a networked database's would, so a rollup write or retention pass could commit between two of
// them and a report would mix stored rows from before with others from after. It reads in one transaction instead.
import { describe, it, expect } from 'vitest';
import { costFn, writeRollups } from './rollups.js';
import { DAY_MS, NOW, populate, world, type World } from './rollupFixtures.js';
import { projectionReport, retentionReport, runReport, spendToday, type ReportDeps } from './reports.js';

const CALL_MS = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The same store with every method taking CALL_MS before it runs. */
function slow<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, key) {
      const v = (t as Record<string | symbol, unknown>)[key];
      if (typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        await sleep(CALL_MS);
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

async function filled(): Promise<World> {
  const w = world();
  await populate(w);
  await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), { sessionsMs: 30 * DAY_MS });
  return w;
}

/** Retention that drops every rollup day older than two days: the rows a report over the last week reads shrink. */
const prune = (w: World) => writeRollups(w.storage, NOW, costFn(w.deps.pricing()), { sessionsMs: 30 * DAY_MS, rollupMs: 2 * DAY_MS });

const from = new Date(NOW - 6 * DAY_MS);
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const range = { from: day(from), to: day(new Date(NOW - DAY_MS)), by: 'day' };

describe('a report is one consistent read', () => {
  it('does not mix rollups from before a retention pass with rows read after it', async () => {
    const w = await filled();
    const before = await runReport(w.deps, 'spend', range);
    expect(before.rows.length).toBeGreaterThan(1);
    // Only a single-moment answer is right: what it was before the pass, or what it is after it.
    const slowDeps = { ...w.deps, db: slow(w.deps.db) };
    const running = runReport(slowDeps, 'spend', range);
    await sleep(CALL_MS * 2.5); // after the first reads, before the last
    await prune(w);
    const got = await running;
    const after = await runReport(w.deps, 'spend', range);
    expect(after).not.toEqual(before);
    expect([before, after]).toContainEqual(got);
  });

  it('holds the same for the projection, the retention figures and spend today', async () => {
    for (const read of [
      (d: ReportDeps) => projectionReport(d, {}),
      (d: ReportDeps) => retentionReport(d),
      (d: ReportDeps) => spendToday(d, 'Priya', false),
    ]) {
      const w2 = await filled();
      const deps2 = { ...w2.deps, db: slow(w2.deps.db) };
      const before = await read(w2.deps);
      const running = read(deps2);
      await sleep(CALL_MS * 2.5);
      await prune(w2);
      const got = await running;
      const after = await read(w2.deps);
      expect([before, after]).toContainEqual(got);
    }
  });
});
