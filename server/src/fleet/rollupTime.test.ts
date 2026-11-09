// How long sessions ran and waited on their person, which agents they launched and how deep the chains went, who ran sessions on a day, and the
// peak of live sessions in each hour (#722). Names, counts and times only. The builder reads through the store, so one scenario here holds on
// every adapter that passes the contract.
import { describe, it, expect } from 'vitest';
import { addDays, agentDepths, buildRollups, costFn, dayStart, MAX_AGENT_DEPTH, peaksByHour, writeRollups } from './rollups.js';
import { DAY_MS, NOW, TODAY, agent, at, session, world } from '../storage/sqlite/rollupFixtures.js';
import type { SessionWaitRow } from '../storage/rows.js';

const wait = (id: string, over: Partial<SessionWaitRow> = {}): SessionWaitRow => ({
  session_id: id, permission_ms: 0, permission_n: 0, question_ms: 0, question_n: 0, plan_ms: 0, plan_n: 0, tracked_since: at(2, 9), open_kind: null, open_since: null, ...over,
});
const sample = (id: string, t: number) => ({ session_id: id, t: Math.floor(t / 1000), tokens_total: 0, tokens_delta: 0, peak_context: 0, running_agents: 0, cost_usd: null });
const DAY = addDays(TODAY, -2);

describe('agentDepths', () => {
  it('is one for an agent the session launched and one more for each level down', () => {
    const d = agentDepths([{ agent: 'a', parent: null }, { agent: 'b', parent: 'a' }, { agent: 'c', parent: 'b' }, { agent: 'd', parent: 'a' }]);
    expect([...d]).toEqual([['a', 1], ['b', 2], ['c', 3], ['d', 2]]);
  });

  it('counts an agent whose parent is not stored as a child, and stops a loop of parents at the cap', () => {
    expect(agentDepths([{ agent: 'x', parent: 'gone' }]).get('x')).toBe(2);
    const loop = agentDepths([{ agent: 'p', parent: 'q' }, { agent: 'q', parent: 'p' }]);
    expect(loop.get('p')).toBe(MAX_AGENT_DEPTH);
  });
});

describe('buildRollups session time', () => {
  it('adds up how long sessions ran and waited per harness, and shares time only over sessions that can say', async () => {
    const w = world();
    // c1 waited 2 minutes for a permission and 1 for a question, and is still waiting on a plan from 10:00 to the last time it was seen (10:30)
    await w.fdb.upsertSession(session({ id: 'c1', harness: 'claude-code', started_at: at(2, 9), last_seen_at: at(2, 10) + 30 * 60_000, ended_at: null }));
    await w.fdb.putSessionWait(wait('c1', { permission_ms: 120_000, permission_n: 2, question_ms: 60_000, question_n: 1, open_kind: 'plan', open_since: at(2, 10) }));
    // c2 ran an hour and has no wait record at all (stored before waits were kept)
    await w.fdb.upsertSession(session({ id: 'c2', harness: 'claude-code', started_at: at(2, 9), last_seen_at: at(2, 10), ended_at: at(2, 10) }));
    await w.fdb.upsertSession(session({ id: 'o1', harness: 'opencode', started_at: at(2, 9), last_seen_at: at(2, 9) + 10 * 60_000, ended_at: at(2, 9) + 10 * 60_000 }));
    await w.fdb.putSessionWait(wait('o1', { question_ms: 30_000, question_n: 1, tracked_since: at(2, 9) }));
    const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
    const cc = b.sessionTime.find((r) => r.day === DAY && r.harness === 'claude-code')!;
    expect(cc).toMatchObject({ sessions: 2, durationS: 5400 + 3600, maxDurationS: 5400, trackedSessions: 1, permissionS: 120, permissionN: 2, questionS: 60, questionN: 1, planS: 1800, planN: 1 });
    // c1 was tracked from 09:00 until it was last seen at 10:30
    expect(cc.trackedS).toBe(5400);
    const oc = b.sessionTime.find((r) => r.day === DAY && r.harness === 'opencode')!;
    expect(oc).toMatchObject({ sessions: 1, trackedSessions: 1, trackedS: 600, questionS: 30, questionN: 1, permissionS: 0, planS: 0 });
  });

  it('counts a session on the day it was last seen, as every other rollup does', async () => {
    const w = world();
    await w.fdb.upsertSession(session({ id: 'late', started_at: at(3, 23), last_seen_at: at(2, 1), ended_at: at(2, 1) }));
    const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
    expect(b.sessionTime.map((r) => r.day)).toEqual([DAY]);
  });
});

describe('buildRollups agents and people', () => {
  it('counts agents by harness, type and how deep their chain is', async () => {
    const w = world();
    await w.fdb.upsertSession(session({ id: 'c1', harness: 'claude-code', last_seen_at: at(2, 11), started_at: at(2, 9) }));
    await w.fdb.upsertSession(session({ id: 'o1', harness: 'opencode', last_seen_at: at(2, 11), started_at: at(2, 9) }));
    await w.fdb.upsertAgent(agent('c1', 'a1', { type: 'Explore' }));
    await w.fdb.upsertAgent(agent('c1', 'a2', { type: 'Explore', parent_id: 'a1' }));
    await w.fdb.upsertAgent(agent('c1', 'a3', { type: 'Plan', parent_id: 'a2' }));
    await w.fdb.upsertAgent(agent('c1', 'a4', { type: 'Plan' }));
    await w.fdb.upsertAgent(agent('o1', 'b1', { type: 'general' }));
    await w.fdb.upsertAgent(agent('o1', 'b2', { type: 'general', parent_id: 'b1' }));
    const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
    const got = b.agentTypes.filter((r) => r.day === DAY).map((r) => `${r.harness}/${r.type}/${r.depth}=${r.agents}`).sort();
    expect(got).toEqual(['claude-code/Explore/1=1', 'claude-code/Explore/2=1', 'claude-code/Plan/1=1', 'claude-code/Plan/3=1', 'opencode/general/1=1', 'opencode/general/2=1']);
  });

  it('counts sessions for each person, harness and day, with the group the person is in', async () => {
    const w = world();
    const platform = await w.people.createGroup('Platform', NOW);
    await w.people.createPerson('Maya', platform.id, NOW - 60 * DAY_MS);
    await w.fdb.upsertSession(session({ id: 's1', owner: 'Maya', harness: 'claude-code', last_seen_at: at(2, 11), started_at: at(2, 9) }));
    await w.fdb.upsertSession(session({ id: 's2', owner: 'Maya', harness: 'claude-code', last_seen_at: at(2, 12), started_at: at(2, 9) }));
    await w.fdb.upsertSession(session({ id: 's3', owner: 'Maya', harness: 'opencode', last_seen_at: at(2, 12), started_at: at(2, 9) }));
    await w.fdb.upsertSession(session({ id: 's4', owner: null, harness: 'claude-code', last_seen_at: at(1, 12), started_at: at(1, 9) }));
    const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
    const got = b.personDays.map((r) => `${r.day}|${r.owner}|${r.group}|${r.harness}=${r.sessions}`).sort();
    expect(got).toEqual([`${addDays(TODAY, -1)}|||claude-code=1`, `${DAY}|Maya|Platform|claude-code=2`, `${DAY}|Maya|Platform|opencode=1`].sort());
  });
});

describe('peaksByHour', () => {
  it('is the most sessions live at once in each local hour, for each harness and for all together', async () => {
    const w = world();
    await w.fdb.upsertSession(session({ id: 'c1', harness: 'claude-code', last_seen_at: at(2, 11), started_at: at(2, 9) }));
    await w.fdb.upsertSession(session({ id: 'c2', harness: 'claude-code', last_seen_at: at(2, 11), started_at: at(2, 9) }));
    await w.fdb.upsertSession(session({ id: 'o1', harness: 'opencode', last_seen_at: at(2, 11), started_at: at(2, 9) }));
    const m = 60_000;
    // c1 09:30 to 10:30 (two hours), c2 10:00 to 10:45, o1 10:15 to 10:20
    for (const [id, from, to] of [['c1', at(2, 9) + 30 * m, at(2, 10) + 30 * m], ['c2', at(2, 10), at(2, 10) + 45 * m], ['o1', at(2, 10) + 15 * m, at(2, 10) + 20 * m]] as const) {
      await w.fdb.upsertSample(sample(id, from));
      await w.fdb.upsertSample(sample(id, to));
    }
    const got = (await peaksByHour(w.fdb)).map((r) => `${r.day}|${r.hour}|${r.harness || 'all'}=${r.peak}`);
    expect(got).toEqual([
      `${DAY}|9|all=1`, `${DAY}|9|claude-code=1`,
      `${DAY}|10|all=3`, `${DAY}|10|claude-code=2`, `${DAY}|10|opencode=1`,
    ]);
  });

  it('gives a session that spans midnight a piece on each day', async () => {
    const w = world();
    await w.fdb.upsertSession(session({ id: 'n1', last_seen_at: at(1, 1), started_at: at(2, 23) }));
    await w.fdb.upsertSample(sample('n1', at(2, 23) + 30 * 60_000));
    await w.fdb.upsertSample(sample('n1', at(1, 0) + 30 * 60_000));
    const got = (await peaksByHour(w.fdb)).filter((r) => r.harness === '').map((r) => `${r.day}|${r.hour}=${r.peak}`);
    expect(got).toEqual([`${DAY}|23=1`, `${addDays(TODAY, -1)}|0=1`]);
  });
});

describe('writeRollups session time', () => {
  it('writes the four tables, and a second run gives the same rows', async () => {
    const w = world();
    await w.fdb.upsertSession(session({ id: 'c1', owner: 'Maya', harness: 'claude-code', last_seen_at: at(2, 11), started_at: at(2, 9) }));
    await w.fdb.putSessionWait(wait('c1', { permission_ms: 5000, permission_n: 1 }));
    await w.fdb.upsertAgent(agent('c1', 'a1'));
    await w.fdb.upsertSample(sample('c1', at(2, 9) + 60_000));
    await w.fdb.upsertSample(sample('c1', at(2, 9) + 120_000));
    const policy = { sessionsMs: 30 * DAY_MS };
    await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), policy);
    const tables = ['session_time_daily', 'agents_daily', 'person_sessions_daily', 'hour_peaks_daily'] as const;
    const first = await Promise.all(tables.map((t) => w.fdb.rollupRows(t, '2026-01-01', '2026-12-31')));
    expect(first.map((rows) => rows.length)).toEqual([1, 1, 1, 2]);
    await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), policy);
    expect(await Promise.all(tables.map((t) => w.fdb.rollupRows(t, '2026-01-01', '2026-12-31')))).toEqual(first);
  });

  it('never lowers the stored peak of an hour when the samples that made it are gone', async () => {
    const w = world();
    await w.fdb.upsertSession(session({ id: 'c1', last_seen_at: at(2, 11), started_at: at(2, 9) }));
    await w.fdb.upsertSample(sample('c1', at(2, 9) + 60_000));
    await w.fdb.upsertSample(sample('c1', at(2, 9) + 120_000));
    await w.fdb.upsertHourPeaks([{ day: DAY, harness: '', hour: 9, peak: 7 }]);
    await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), { sessionsMs: 30 * DAY_MS });
    const rows = await w.fdb.rollupRows('hour_peaks_daily', DAY, DAY);
    expect(rows.find((r) => r.hour === 9 && r.harness === '')?.peak).toBe(7);
  });

  it('holds only names, counts and times: no prompt, text, path or tool input', () => {
    const w = world();
    const columns = (t: string): string[] => (w.storage.sqliteHandle.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns('session_waits')).toEqual(['session_id', 'permission_ms', 'permission_n', 'question_ms', 'question_n', 'plan_ms', 'plan_n', 'tracked_since', 'open_kind', 'open_since']);
    expect(columns('agents_daily')).toEqual(['day', 'harness', 'type', 'depth', 'agents']);
    expect(columns('person_sessions_daily')).toEqual(['day', 'owner', 'group_name', 'harness', 'sessions']);
    expect(columns('hour_peaks_daily')).toEqual(['day', 'harness', 'hour', 'peak']);
    expect(columns('session_time_daily')).toEqual(['day', 'harness', 'sessions', 'duration_s', 'max_duration_s', 'tracked_sessions', 'tracked_s', 'permission_s', 'permission_n', 'question_s', 'question_n', 'plan_s', 'plan_n']);
  });

  it('removes a session\'s wait record with the session', async () => {
    const w = world();
    await w.fdb.upsertSession(session({ id: 'gone' }));
    await w.fdb.putSessionWait(wait('gone', { plan_ms: 1, plan_n: 1 }));
    expect(await w.fdb.getSessionWait('gone')).toMatchObject({ plan_ms: 1 });
    await w.fdb.deleteSession('gone');
    expect(await w.fdb.getSessionWait('gone')).toBeUndefined();
  });
});
