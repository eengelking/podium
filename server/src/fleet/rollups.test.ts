// The daily rollups (#484, SPEC 7.2 Migration 22 and Retention).
import { describe, it, expect } from 'vitest';
import { openDb } from './db.js';
import { Fleet, DEFAULT_CONFIG, configFromEnv } from './fleet.js';
import { addDays, buildRollups, costFn, dayStart, daysBetween, localDay, parseDay, peakLiveByDay, serverZone, writeRollups } from './rollups.js';
import { DAY_MS, NOW, TODAY, at, populate, session, world } from './rollupFixtures.js';
import { Pricing } from './pricing.js';

const policy = { sessionsMs: 30 * DAY_MS };

const dump = (w: ReturnType<typeof world>) =>
  JSON.stringify(['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily'].map((t) => w.fdb.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3, 4, 5`).all()));

describe('days', () => {
  it('names, parses and moves calendar days in the server zone', () => {
    expect(TODAY).toBe('2026-10-20');
    expect(parseDay('2026-02-29')).toBeNull();
    expect(parseDay('2026-2-9')).toBeNull();
    expect(parseDay('2028-02-29')).toEqual({ y: 2028, m: 2, d: 29 });
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-01', '2026-10-20')).toBe(19);
    expect(daysBetween('2026-10-20', '2026-10-01')).toBe(-19);
    expect(localDay(dayStart('2026-10-20'))).toBe('2026-10-20');
    expect(serverZone().length).toBeGreaterThan(0);
  });
});

describe('migration 22', () => {
  it('creates the four rollup tables', () => {
    const tables = (openDb(':memory:').prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily']));
  });
});

describe('buildRollups', () => {
  it('counts a session on the day it was last seen and sums priced models only', () => {
    const w = world();
    populate(w);
    const b = buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
    const day3 = b.usage.filter((u) => u.day === addDays(TODAY, -3));
    // p1 is repriced from its usage: one million opus input tokens at the built-in price.
    expect(day3).toHaveLength(1);
    expect(day3[0]).toMatchObject({ owner: 'Priya', group: 'Backend', model: 'claude-opus-5-5', project: 'demo', sessions: 1, agents: 2, unpricedSessions: 0, tokIn: 100 });
    expect(day3[0]!.costUsd).toBeGreaterThan(0);
    // p2 runs a model nobody priced: counted, cost kept out.
    const p2 = b.usage.find((u) => u.day === addDays(TODAY, -2) && u.owner === 'Priya')!;
    expect(p2).toMatchObject({ sessions: 1, costUsd: 0, unpricedSessions: 1, model: 'llama-local' });
    // p4 began yesterday and was last seen today: it counts today only.
    expect(b.usage.find((u) => u.day === TODAY && u.owner === 'Priya')).toMatchObject({ sessions: 1, costUsd: 4, agents: 2 });
    expect(b.usage.some((u) => u.day === addDays(TODAY, -1) && u.owner === 'Priya' && u.costUsd === 4)).toBe(false);
    // No owner, no repo and no model are empty names.
    expect(b.usage.find((u) => u.owner === '')).toMatchObject({ group: '', model: '', project: '', sessions: 1 });
  });

  it('rolls outcomes, durations, failures and the fleet up without any content', () => {
    const w = world();
    populate(w);
    const b = buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
    expect(b.sessions.find((s) => s.day === addDays(TODAY, -3))).toMatchObject({ outcome: 'completed', plan: 'TodoWrite', blowouts: 1, maxContextPct: 91, durationS: 7200, agents: 2 });
    expect(b.sessions.find((s) => s.outcome === 'error')).toMatchObject({ model: 'llama-local', plan: 'none' });
    expect(b.sessions.find((s) => s.outcome === 'running')).toBeTruthy();
    expect(b.failures.filter((f) => f.day === addDays(TODAY, -3)).map((f) => [f.cls, f.tool, f.count]).sort()).toEqual([['permission', 'Bash', 1], ['timeout', 'WebFetch', 1]]);
    expect(b.failureSessions.filter((f) => f.cls === 'permission').map((f) => f.sessionId).sort()).toEqual(['p1', 'p3']);
    const d = b.fleet.find((f) => f.day === addDays(TODAY, -3))!;
    expect(d).toMatchObject({ activePeople: 1, activeReporters: 1, sessionsStarted: 1, peakLive: 0 });
    expect(d.reporterVersions).toEqual({ '1.2.2': 1 });
    expect(d.engineVersions).toEqual({ '2.1.301': 1 });
    // A session that began yesterday evening counts as started there, though last seen today.
    expect(b.fleet.find((f) => f.day === addDays(TODAY, -1))!.sessionsStarted).toBe(2);
    const text = JSON.stringify(b);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('/Users/dev');
  });

  it('ignores a failure row it cannot read and an unreadable plan', () => {
    const w = world();
    w.fdb.upsertSession(session({ id: 'x', plan_json: '{nope', owner: 'Dana' }));
    w.fdb.db.prepare("INSERT INTO agents (session_id, id, kind, type, description, status, started_at, failure_json) VALUES ('x', 'a', 'sub', 'T', 'd', 'done', 1, '{bad'), ('x', 'b', 'sub', 'T', 'd', 'done', 1, '{}')").run();
    const b = buildRollups(w.fdb, costFn(undefined), 0);
    expect(b.failures).toEqual([]);
    expect(b.sessions[0]!.plan).toBe('none');
  });
});

describe('peakLiveByDay', () => {
  it('counts the sessions live at one second, across midnight too', () => {
    const w = world();
    const put = (id: string, a: number, b: number) => {
      for (const t of [a, b]) w.fdb.insertSampleIfAbsent({ session_id: id, t: Math.floor(t / 1000), tokens_total: 0, tokens_delta: 0, peak_context: 0, running_agents: 0, cost_usd: null });
    };
    put('a', at(1, 23), at(0, 1));
    put('b', at(1, 23) + 60_000, at(1, 23) + 120_000);
    put('c', at(0, 5), at(0, 6));
    expect(peakLiveByDay(w.fdb)).toEqual(new Map([[addDays(TODAY, -1), 2], [TODAY, 1]]));
  });
});

describe('writeRollups', () => {
  it('writes every day from the oldest stored session, once, and a second run changes nothing', () => {
    const w = world();
    populate(w);
    const cost = costFn(w.deps.pricing());
    const first = writeRollups(w.fdb, NOW, cost, policy);
    expect(first.days).toBeGreaterThanOrEqual(4);
    const before = dump(w);
    writeRollups(w.fdb, NOW, cost, policy);
    expect(dump(w)).toBe(before);
    expect((w.fdb.db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get() as { n: number }).n).toBeGreaterThanOrEqual(6);
  });

  it('does nothing but prune on an empty database', () => {
    const w = world();
    expect(writeRollups(w.fdb, NOW, costFn(undefined), policy)).toEqual({ days: 0, deleted: 0 });
  });

  it('never lowers a day\'s peak of live sessions, and reads it from the samples while they last', () => {
    const w = world();
    populate(w);
    for (const id of ['p3', 'd1']) for (const t of [at(1, 10), at(1, 11)]) w.fdb.insertSampleIfAbsent({ session_id: id, t: Math.floor(t / 1000), tokens_total: 0, tokens_delta: 0, peak_context: 0, running_agents: 0, cost_usd: null });
    const cost = costFn(w.deps.pricing());
    writeRollups(w.fdb, NOW, cost, policy);
    const peak = () => (w.fdb.db.prepare('SELECT peak_live_sessions AS p FROM fleet_daily WHERE day = ?').get(addDays(TODAY, -1)) as { p: number }).p;
    expect(peak()).toBe(2);
    w.fdb.db.prepare('DELETE FROM samples').run();
    writeRollups(w.fdb, NOW, cost, policy);
    expect(peak()).toBe(2);
  });

  it('leaves alone a day that retention may already have taken sessions from, and a day whose raw rows are gone', () => {
    const w = world();
    populate(w);
    w.fdb.upsertSession(session({ id: 'old', owner: 'Dana', started_at: at(40, 9), last_seen_at: at(40, 10), ended_at: at(40, 10), cost_usd: 9 }));
    const cost = costFn(w.deps.pricing());
    // The day 40 days back was written by an earlier run, when its sessions were all there.
    w.fdb.db.prepare("INSERT INTO usage_daily VALUES (?, 'Dana', '', 'm', 'p', 5, 0, 7, 0, 1, 1, 1, 1)").run(addDays(TODAY, -40));
    writeRollups(w.fdb, NOW, cost, policy);
    expect(w.fdb.db.prepare('SELECT sessions FROM usage_daily WHERE day = ?').all(addDays(TODAY, -40))).toEqual([{ sessions: 5 }]);
    // Once the sessions are gone the rollup is all that is left, and nothing touches it.
    w.fdb.db.prepare('DELETE FROM sessions WHERE id = ?').run('old');
    writeRollups(w.fdb, NOW, cost, policy);
    expect(w.fdb.db.prepare('SELECT sessions FROM usage_daily WHERE day = ?').all(addDays(TODAY, -40))).toEqual([{ sessions: 5 }]);
  });

  it('rebuilds a day from what is stored when a session is gone from it', () => {
    const w = world();
    populate(w);
    const cost = costFn(w.deps.pricing());
    writeRollups(w.fdb, NOW, cost, policy);
    w.fdb.db.prepare("DELETE FROM sessions WHERE id = 'd1'").run();
    writeRollups(w.fdb, NOW, cost, policy);
    expect(w.fdb.db.prepare("SELECT COUNT(*) AS n FROM usage_daily WHERE owner = 'Dana'").get()).toEqual({ n: 0 });
  });

  it('deletes rollup rows older than the rollup period, 395 days by default', () => {
    const w = world();
    const put = (day: string) => w.fdb.db.prepare("INSERT INTO fleet_daily VALUES (?, 1, 1, 1, 1, '{}', '{}')").run(day);
    put(addDays(TODAY, -396));
    put(addDays(TODAY, -394));
    w.fdb.db.prepare("INSERT INTO failures_daily VALUES (?, 'x', 'c', 't', 1)").run(addDays(TODAY, -400));
    expect(writeRollups(w.fdb, NOW, costFn(undefined), policy).deleted).toBe(2);
    expect(w.fdb.db.prepare('SELECT day FROM fleet_daily').all()).toEqual([{ day: addDays(TODAY, -394) }]);
    put(addDays(TODAY, -20));
    expect(writeRollups(w.fdb, NOW, costFn(undefined), { ...policy, rollupMs: 10 * DAY_MS }).deleted).toBe(2);
  });
});

describe('retention', () => {
  it('Fleet.retain writes the rollups before it deletes sessions, so their days survive the deletion', () => {
    const w = world();
    const fleet = new Fleet(w.fdb, { ...DEFAULT_CONFIG, home: '/h', dbPath: ':memory:' }, () => NOW);
    const bare = new Pricing({});
    void bare;
    // A session that ended 31 days ago is about to go; its day began before the cut-off so the rollup written on an earlier run stays.
    w.fdb.upsertSession(session({ id: 'gone', owner: 'Dana', started_at: at(29, 9), last_seen_at: at(29, 10), ended_at: at(29, 10), cost_usd: 3 }));
    w.fdb.upsertSession(session({ id: 'gone2', owner: 'Dana', started_at: at(31, 9), last_seen_at: at(31, 10), ended_at: at(31, 10), cost_usd: 3 }));
    expect(fleet.retain().sessions).toBe(1);
    const days = (w.fdb.db.prepare('SELECT day FROM usage_daily ORDER BY day').all() as { day: string }[]).map((r) => r.day);
    expect(days).toEqual([addDays(TODAY, -29)]);
    expect(w.fdb.getSession('gone2')).toBeUndefined();
  });

  it('Fleet.retain still prunes when the rollups cannot be written', () => {
    const w = world();
    const fleet = new Fleet(w.fdb, { ...DEFAULT_CONFIG, home: '/h', dbPath: ':memory:' }, () => NOW);
    w.fdb.upsertSession(session({ id: 'old', owner: 'Dana', started_at: at(31, 9), last_seen_at: at(31, 10), ended_at: at(31, 10), cost_usd: 3 }));
    w.fdb.db.exec('DROP TABLE usage_daily');
    expect(fleet.retain().sessions).toBe(1);
    expect(w.fdb.getSession('old')).toBeUndefined();
  });

  it('reads RETAIN_ROLLUP_MS from the environment, 395 days by default', () => {
    const base = { home: '/h', dbPath: 'x' };
    expect(configFromEnv({}, base).retention.rollupMs).toBe(395 * DAY_MS);
    expect(configFromEnv({ RETAIN_ROLLUP_MS: '86400000' }, base).retention.rollupMs).toBe(DAY_MS);
    expect(configFromEnv({ RETAIN_ROLLUP_MS: 'soon' }, base).retention.rollupMs).toBe(395 * DAY_MS);
  });
});
