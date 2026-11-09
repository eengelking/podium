// What a report may say about each tool beyond its calls (#721): failures, permission asks and call lengths, as counts only.
import { describe, it, expect } from 'vitest';
import { validateReport, LIMITS, TIME_BUCKETS, timeBucket, bucketMs } from './protocol.js';
import { loadFixture } from './testing.js';

const agent = (f: unknown) => (f as { agents: Record<string, unknown>[] }).agents[0]!;
const loopOf = (f: unknown) => (f as { session: { loop: Record<string, unknown> } }).session.loop;
const statsOf = (r: ReturnType<typeof validateReport>) => (r.ok ? r.report.agents[0]!.toolStats : 'rejected');
const loopStats = (r: ReturnType<typeof validateReport>) => (r.ok ? r.report.session.loop?.toolStats : 'rejected');

describe('toolStats', () => {
  it('is absent from a reporter that does not send it, on an agent and on the main loop', () => {
    const f = loadFixture();
    delete agent(f).toolStats;
    delete loopOf(f).toolStats;
    expect(statsOf(validateReport(f))).toBeUndefined();
    expect(loopStats(validateReport(f))).toBeUndefined();
  });

  it('keeps what the shared sample report carries, so a reporter that sends it is understood', () => {
    expect(statsOf(validateReport(loadFixture()))).toEqual({ Grep: { times: { '25': 14 } } });
    expect(loopStats(validateReport(loadFixture()))).toEqual({ Edit: { asked: 2, allowed: 1, denied: 1, podium: 1, times: { '31': 4, '40': 1 } }, Read: { failed: 1, times: { '20': 7 } } });
  });

  it('keeps the counts of an agent and of the main loop', () => {
    const f = loadFixture();
    const stat = { failed: 2, asked: 5, allowed: 3, denied: 1, podium: 2, times: { '10': 4, '40': 1 } };
    agent(f).toolStats = { Bash: stat };
    loopOf(f).toolStats = { Edit: { failed: 1 } };
    const r = validateReport(f);
    expect(statsOf(r)).toEqual({ Bash: stat });
    expect(loopStats(r)).toEqual({ Edit: { failed: 1 } });
  });

  it('rejects a non-object, a negative or non-numeric count and a bucket outside the ladder, with a path', () => {
    const bad: unknown[] = ['Bash', [1], { Bash: 5 }, { Bash: { failed: -1 } }, { Bash: { asked: 'many' } }, { Bash: { times: { '-1': 1 } } }, { Bash: { times: { [String(TIME_BUCKETS)]: 1 } } }, { Bash: { times: { x: 1 } } }];
    for (const b of bad) {
      const f = loadFixture();
      agent(f).toolStats = b;
      expect(validateReport(f)).toMatchObject({ ok: false });
    }
    const f = loadFixture();
    agent(f).toolStats = { Bash: { failed: -1 } };
    expect(validateReport(f)).toMatchObject({ path: '$.agents[0].toolStats.Bash.failed' });
  });

  it('clips long names, adds up names that clip alike, rounds counts and drops zeros', () => {
    const f = loadFixture();
    agent(f).toolStats = { ['x'.repeat(300)]: { failed: 1 }, ['x'.repeat(200)]: { failed: 2.4, asked: 0 }, 'a\u0001b': { allowed: 3 } };
    expect(statsOf(validateReport(f))).toEqual({ ['x'.repeat(LIMITS.short)]: { failed: 3 }, 'a b': { allowed: 3 } });
  });

  it('keeps the busiest names when there are more than the cap', () => {
    const f = loadFixture();
    const many: Record<string, unknown> = {};
    for (let i = 0; i < LIMITS.toolNames + 5; i++) many[`t${String(i).padStart(3, '0')}`] = { failed: 1 };
    many.big = { failed: 50 };
    agent(f).toolStats = many;
    const r = statsOf(validateReport(f)) as Record<string, unknown>;
    expect(Object.keys(r)).toHaveLength(LIMITS.toolNames);
    expect(r.big).toEqual({ failed: 50 });
  });

  it('adds up the buckets of names that clip alike', () => {
    const f = loadFixture();
    agent(f).toolStats = { a: { times: { '5': 1, '6': 2 } }, 'a\u0001': { times: { '5': 3 } } };
    const r = statsOf(validateReport(f)) as Record<string, { times: Record<string, number> }>;
    expect(r.a!.times).toEqual({ '5': 1, '6': 2 });
    expect(r['a ']!.times).toEqual({ '5': 3 });
  });
});

describe('call length buckets', () => {
  it('put a call in a bucket whose length is within 10% of it, and in order', () => {
    for (const ms of [0, 1, 2, 40, 310, 1800, 41_000, 252_000, 3_600_000, 9_000_000]) {
      const b = timeBucket(ms);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(TIME_BUCKETS);
      const shown = bucketMs(b);
      const real = Math.min(ms, 3_600_000);
      if (real > 1) {
        expect(shown / real).toBeGreaterThanOrEqual(0.99);
        expect(shown / real).toBeLessThan(1.11);
      }
    }
    expect(timeBucket(40)).toBeLessThan(timeBucket(60));
    expect(timeBucket(-5)).toBe(0);
    expect(bucketMs(0)).toBe(1);
  });
});
