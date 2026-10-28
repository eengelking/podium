// The daily rollups (#484, SPEC 7.2 Migration 22 and Retention).
import { describe, it, expect, vi } from 'vitest';
import { openDb } from './db.js';
import { Fleet, DEFAULT_CONFIG, configFromEnv } from './fleet.js';
import { addDays, buildRollups, costFn, dayStart, daysBetween, localDay, parseDay, peakLiveByDay, serverZone, writeRollups } from './rollups.js';
import { DAY_MS, NOW, TODAY, agent, at, failure, populate, session, world } from './rollupFixtures.js';
import { Pricing } from './pricing.js';

const policy = { sessionsMs: 30 * DAY_MS };

const dump = (w: ReturnType<typeof world>) =>
  JSON.stringify(['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily'].map((t) => w.storage.sqliteHandle.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3, 4, 5`).all()));

describe('days', () => {
  it('names, parses and moves calendar days in the server zone', async () => {
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
  it('creates the four rollup tables', async () => {
    const tables = (openDb(':memory:').prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily']));
  });
});

describe('buildRollups', () => {
  it('counts a session on the day it was last seen and sums priced models only', async () => {
    const w = world();
    await populate(w);
    const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
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

  it('rolls outcomes, durations, failures and the fleet up without any content', async () => {
    const w = world();
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
    // A session that began yesterday evening counts as started there, though last seen today.
    expect(b.fleet.find((f) => f.day === addDays(TODAY, -1))!.sessionsStarted).toBe(2);
    const text = JSON.stringify(b);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('/Users/dev');
  });

  it('ignores a failure row it cannot read and an unreadable plan', async () => {
    const w = world();
    await w.fdb.upsertSession(session({ id: 'x', plan_json: '{nope', owner: 'Dana' }));
    w.storage.sqliteHandle.prepare("INSERT INTO agents (session_id, id, kind, type, description, status, started_at, failure_json) VALUES ('x', 'a', 'sub', 'T', 'd', 'done', 1, '{bad'), ('x', 'b', 'sub', 'T', 'd', 'done', 1, '{}')").run();
    const b = await buildRollups(w.fdb, costFn(undefined), 0);
    expect(b.failures).toEqual([]);
    expect(b.sessions[0]!.plan).toBe('none');
  });
});

describe('buildRollups reads only what it needs (#529)', () => {
  it('reads the same number of rows for today however many old sessions are stored', async () => {
    const rowsRead = async (olds: number): Promise<number> => {
      const w = world();
      await w.fdb.upsertSession(session({ id: 'today', owner: 'Dana', started_at: at(0, 9), last_seen_at: at(0, 10), ended_at: at(0, 10) }));
      await w.fdb.upsertAgent(agent('today', 'a0', { cost_usd_est: 1, failure_json: failure('timeout', 'Bash') }));
      w.storage.sqliteHandle.prepare("INSERT INTO reporters (key, kind, machine_id, owner, reporter_version, engine_version, first_seen_at, last_seen_at) VALUES ('m', 'mod', 'm', 'Dana', '1.2.2', '2.1.301', 1, 2)").run();
      for (let i = 0; i < olds; i++) {
        await w.fdb.upsertSession(session({ id: `old${i}`, owner: 'Dana', started_at: at(20, 9), last_seen_at: at(20, 10), ended_at: at(20, 10) }));
        await w.fdb.upsertAgent(agent(`old${i}`, `a${i}`, { cost_usd_est: 1, failure_json: failure('timeout', 'Bash') }));
        w.storage.sqliteHandle.prepare("INSERT INTO reporter_sessions (reporter_key, session_id) VALUES ('m', ?)").run(`old${i}`);
      }
      let read = 0;
      const prepare = w.storage.sqliteHandle.prepare.bind(w.storage.sqliteHandle);
      vi.spyOn(w.storage.sqliteHandle, 'prepare').mockImplementation((sql: string) => {
        const st = prepare(sql);
        const all = st.all.bind(st);
        st.all = ((...args: unknown[]) => {
          const rows = (all as (...a: unknown[]) => unknown[])(...args);
          read += rows.length;
          return rows;
        }) as typeof st.all;
        return st;
      });
      await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(TODAY));
      return read;
    };
    expect(await rowsRead(40)).toBe(await rowsRead(0));
  });
});

describe('peakLiveByDay', () => {
  it('counts the sessions live at one second, across midnight too', async () => {
    const w = world();
    const put = async (id: string, a: number, b: number) => {
      for (const t of [a, b]) (await w.fdb.insertSampleIfAbsent({ session_id: id, t: Math.floor(t / 1000), tokens_total: 0, tokens_delta: 0, peak_context: 0, running_agents: 0, cost_usd: null }));
    };
    await put('a', at(1, 23), at(0, 1));
    await put('b', at(1, 23) + 60_000, at(1, 23) + 120_000);
    await put('c', at(0, 5), at(0, 6));
    expect(await peakLiveByDay(w.fdb)).toEqual(new Map([[addDays(TODAY, -1), 2], [TODAY, 1]]));
  });
});

describe('writeRollups', () => {
  it('writes every day from the oldest stored session, once, and a second run changes nothing', async () => {
    const w = world();
    await populate(w);
    const cost = costFn(w.deps.pricing());
    const first = await writeRollups(w.storage, NOW, cost, policy);
    expect(first.days).toBeGreaterThanOrEqual(4);
    const before = dump(w);
    await writeRollups(w.storage, NOW, cost, policy);
    expect(dump(w)).toBe(before);
    expect((w.storage.sqliteHandle.prepare('SELECT COUNT(*) AS n FROM usage_daily').get() as { n: number }).n).toBeGreaterThanOrEqual(6);
  });

  it('does nothing but prune on an empty database', async () => {
    const w = world();
    expect(await writeRollups(w.storage, NOW, costFn(undefined), policy)).toEqual({ days: 0, deleted: 0 });
  });

  it('never lowers a day\'s peak of live sessions, and reads it from the samples while they last', async () => {
    const w = world();
    await populate(w);
    for (const id of ['p3', 'd1']) for (const t of [at(1, 10), at(1, 11)]) (await w.fdb.insertSampleIfAbsent({ session_id: id, t: Math.floor(t / 1000), tokens_total: 0, tokens_delta: 0, peak_context: 0, running_agents: 0, cost_usd: null }));
    const cost = costFn(w.deps.pricing());
    await writeRollups(w.storage, NOW, cost, policy);
    const peak = () => (w.storage.sqliteHandle.prepare('SELECT peak_live_sessions AS p FROM fleet_daily WHERE day = ?').get(addDays(TODAY, -1)) as { p: number }).p;
    expect(peak()).toBe(2);
    w.storage.sqliteHandle.prepare('DELETE FROM samples').run();
    await writeRollups(w.storage, NOW, cost, policy);
    expect(peak()).toBe(2);
  });

  it('leaves alone a day that retention may already have taken sessions from, and a day whose raw rows are gone', async () => {
    const w = world();
    await populate(w);
    await w.fdb.upsertSession(session({ id: 'old', owner: 'Dana', started_at: at(40, 9), last_seen_at: at(40, 10), ended_at: at(40, 10), cost_usd: 9 }));
    const cost = costFn(w.deps.pricing());
    // The day 40 days back was written by an earlier run, when its sessions were all there.
    w.storage.sqliteHandle.prepare("INSERT INTO usage_daily VALUES (?, 'Dana', '', 'm', 'p', 5, 0, 7, 0, 1, 1, 1, 1)").run(addDays(TODAY, -40));
    await writeRollups(w.storage, NOW, cost, policy);
    expect(w.storage.sqliteHandle.prepare('SELECT sessions FROM usage_daily WHERE day = ?').all(addDays(TODAY, -40))).toEqual([{ sessions: 5 }]);
    // Once the sessions are gone the rollup is all that is left, and nothing touches it.
    w.storage.sqliteHandle.prepare('DELETE FROM sessions WHERE id = ?').run('old');
    await writeRollups(w.storage, NOW, cost, policy);
    expect(w.storage.sqliteHandle.prepare('SELECT sessions FROM usage_daily WHERE day = ?').all(addDays(TODAY, -40))).toEqual([{ sessions: 5 }]);
  });

  it('writes the day at the retention cutoff when no run has written it yet, and leaves it alone once one has (#529)', async () => {
    const w = world();
    const cost = costFn(w.deps.pricing());
    // The cutoff is 30 days back at 15:00: this session is kept, but the midnight that starts its day is before the cutoff.
    await w.fdb.upsertSession(session({ id: 'edge', owner: 'Dana', started_at: at(30, 16), last_seen_at: at(30, 17), ended_at: at(30, 17), cost_usd: 2 }));
    const day = addDays(TODAY, -30);
    await writeRollups(w.storage, NOW, cost, policy);
    expect(w.storage.sqliteHandle.prepare('SELECT sessions FROM usage_daily WHERE day = ?').all(day)).toEqual([{ sessions: 1 }]);
    expect(w.storage.sqliteHandle.prepare('SELECT sessions_started FROM fleet_daily WHERE day = ?').all(day)).toEqual([{ sessions_started: 1 }]);
    // A second session of that day was swept since; the written day is the fuller one and stays.
    w.storage.sqliteHandle.prepare('DELETE FROM sessions WHERE id = ?').run('edge');
    await w.fdb.upsertSession(session({ id: 'edge2', owner: 'Dana', started_at: at(30, 18), last_seen_at: at(30, 19), ended_at: at(30, 19), cost_usd: 3 }));
    await writeRollups(w.storage, NOW, cost, policy);
    expect(w.storage.sqliteHandle.prepare('SELECT sessions, cost_usd FROM usage_daily WHERE day = ?').all(day)).toEqual([{ sessions: 1, cost_usd: 2 }]);
  });

  it('rebuilds a day from what is stored when a session is gone from it', async () => {
    const w = world();
    await populate(w);
    const cost = costFn(w.deps.pricing());
    await writeRollups(w.storage, NOW, cost, policy);
    w.storage.sqliteHandle.prepare("DELETE FROM sessions WHERE id = 'd1'").run();
    await writeRollups(w.storage, NOW, cost, policy);
    expect(w.storage.sqliteHandle.prepare("SELECT COUNT(*) AS n FROM usage_daily WHERE owner = 'Dana'").get()).toEqual({ n: 0 });
  });

  it('deletes rollup rows older than the rollup period, 395 days by default', async () => {
    const w = world();
    const put = (day: string) => w.storage.sqliteHandle.prepare("INSERT INTO fleet_daily VALUES (?, 1, 1, 1, 1, '{}', '{}')").run(day);
    put(addDays(TODAY, -396));
    put(addDays(TODAY, -394));
    w.storage.sqliteHandle.prepare("INSERT INTO failures_daily VALUES (?, 'x', 'c', 't', 1)").run(addDays(TODAY, -400));
    expect((await writeRollups(w.storage, NOW, costFn(undefined), policy)).deleted).toBe(2);
    expect(w.storage.sqliteHandle.prepare('SELECT day FROM fleet_daily').all()).toEqual([{ day: addDays(TODAY, -394) }]);
    put(addDays(TODAY, -20));
    expect((await writeRollups(w.storage, NOW, costFn(undefined), { ...policy, rollupMs: 10 * DAY_MS })).deleted).toBe(2);
  });
});

describe('retention', () => {
  it('Fleet.retain writes the rollups before it deletes sessions, so their days survive the deletion', async () => {
    const w = world();
    const fleet = new Fleet(w.storage, { ...DEFAULT_CONFIG, home: '/h', dbPath: ':memory:' }, () => NOW);
    await fleet.init();
    const bare = new Pricing({});
    void bare;
    // A session that ended 31 days ago is about to go; its day began before the cut-off so the rollup written on an earlier run stays.
    await w.fdb.upsertSession(session({ id: 'gone', owner: 'Dana', started_at: at(29, 9), last_seen_at: at(29, 10), ended_at: at(29, 10), cost_usd: 3 }));
    await w.fdb.upsertSession(session({ id: 'gone2', owner: 'Dana', started_at: at(31, 9), last_seen_at: at(31, 10), ended_at: at(31, 10), cost_usd: 3 }));
    expect((await fleet.retain()).sessions).toBe(1);
    const days = (w.storage.sqliteHandle.prepare('SELECT day FROM usage_daily ORDER BY day').all() as { day: string }[]).map((r) => r.day);
    expect(days).toEqual([addDays(TODAY, -29)]);
    expect(await w.fdb.getSession('gone2')).toBeUndefined();
  });

  it('Fleet.retain still prunes when the rollups cannot be written', async () => {
    const w = world();
    const fleet = new Fleet(w.storage, { ...DEFAULT_CONFIG, home: '/h', dbPath: ':memory:' }, () => NOW);
    await fleet.init();
    await w.fdb.upsertSession(session({ id: 'old', owner: 'Dana', started_at: at(31, 9), last_seen_at: at(31, 10), ended_at: at(31, 10), cost_usd: 3 }));
    w.storage.sqliteHandle.exec('DROP TABLE usage_daily');
    expect((await fleet.retain()).sessions).toBe(1);
    expect(await w.fdb.getSession('old')).toBeUndefined();
  });

  it('reads RETAIN_ROLLUP_MS from the environment, 395 days by default', async () => {
    const base = { home: '/h', dbPath: 'x' };
    expect(configFromEnv({}, base).retention.rollupMs).toBe(395 * DAY_MS);
    expect(configFromEnv({ RETAIN_ROLLUP_MS: '86400000' }, base).retention.rollupMs).toBe(DAY_MS);
    expect(configFromEnv({ RETAIN_ROLLUP_MS: 'soon' }, base).retention.rollupMs).toBe(395 * DAY_MS);
  });
});
