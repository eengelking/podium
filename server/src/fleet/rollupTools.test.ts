// The tool counts in the daily rollups (#720): calls per tool and harness, how big each session was, and which harness versions ran.
// Names and counts only. The builder reads through the store, so one scenario here holds on every adapter that passes the contract.
import { describe, it, expect } from 'vitest';
import { addDays, buildRollups, callsBucket, costFn, dayStart, writeRollups } from './rollups.js';
import { DAY_MS, NOW, TODAY, agent, at, session, world } from '../storage/sqlite/rollupFixtures.js';

const counts = (o: Record<string, number>): string => JSON.stringify(o);

async function populateTools(w: ReturnType<typeof world>): Promise<void> {
  const add = (s: Parameters<typeof session>[0]) => w.fdb.upsertSession(session(s));
  // Claude Code: one session with two agents (their counts add up) and one that made no tool calls at all.
  await add({ id: 'c1', owner: 'Priya', last_seen_at: at(2, 11), started_at: at(2, 9), harness: 'claude-code', engine_version: '2.1.319' });
  await add({ id: 'c2', owner: 'Priya', last_seen_at: at(2, 12), started_at: at(2, 9), harness: 'claude-code', engine_version: '2.1.305' });
  // OpenCode: the same tool names, a different harness.
  await add({ id: 'o1', owner: 'Dana', last_seen_at: at(2, 13), started_at: at(2, 9), harness: 'opencode', engine_version: '1.4.2' });
  await w.fdb.upsertAgent(agent('c1', 'a1', { tool_counts_json: counts({ Bash: 3, Read: 1, mcp__github__search_code: 4 }) }));
  await w.fdb.upsertAgent(agent('c1', 'a2', { tool_counts_json: counts({ Bash: 2 }) }));
  await w.fdb.upsertAgent(agent('o1', 'a3', { tool_counts_json: counts({ Bash: 4, Edit: 1 }) }));
  const raw = w.storage.sqliteHandle;
  for (const [key, owner] of [['m1', 'Priya'], ['m2', 'Priya'], ['m3', 'Dana']] as const) {
    raw.prepare("INSERT INTO reporters (key, kind, machine_id, owner, reporter_version, engine_version, first_seen_at, last_seen_at) VALUES (?, 'mod', ?, ?, '1.2.2', '2.1.301', 1, 2)").run(key, key, owner);
  }
  raw.prepare("INSERT INTO reporter_sessions (reporter_key, session_id) VALUES ('m1', 'c1'), ('m2', 'c2'), ('m3', 'o1')").run();
}

describe('callsBucket', () => {
  it('is the number itself up to 100, then the next ten up to 1,000, then the next hundred', () => {
    expect([0, 1, 57, 100, 101, 110, 999, 1000, 1001, 1100, 12_345].map(callsBucket)).toEqual([0, 1, 57, 100, 110, 110, 1000, 1000, 1100, 1100, 12_400]);
    expect(callsBucket(-3)).toBe(0);
    expect(callsBucket(7.9)).toBe(7);
  });
});

describe('buildRollups tool counts', () => {
  it('adds a session\'s agents together and keeps each harness apart', async () => {
    const w = world();
    await populateTools(w);
    const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
    const day = addDays(TODAY, -2);
    const rows = b.tools.filter((t) => t.day === day).map((t) => `${t.harness}/${t.tool}=${t.calls}`).sort();
    expect(rows).toEqual(['claude-code/Bash=5', 'claude-code/Read=1', 'claude-code/mcp__github__search_code=4', 'opencode/Bash=4', 'opencode/Edit=1']);
  });

  it('sizes each session that has tool counts, and leaves out one with none, which is not a session with zero calls', async () => {
    const w = world();
    await populateTools(w);
    // a session with no tool counts at all: one stored before they were kept, or one that called no tool
    await w.fdb.upsertSession(session({ id: 'c0', owner: 'Priya', last_seen_at: at(2, 14), started_at: at(2, 9), harness: 'claude-code' }));
    const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
    const day = addDays(TODAY, -2);
    const sizes = b.toolSessions.filter((t) => t.day === day).map((t) => `${t.harness}/${t.bucket}=${t.sessions}`).sort();
    expect(sizes).toEqual(['claude-code/10=1', 'opencode/5=1']);
  });

  it('counts the reporters on each version of each harness', async () => {
    const w = world();
    await populateTools(w);
    const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
    const day = addDays(TODAY, -2);
    const versions = b.harnessVersions.filter((v) => v.day === day).map((v) => `${v.harness}/${v.version}=${v.reporters}`).sort();
    expect(versions).toEqual(['claude-code/2.1.305=1', 'claude-code/2.1.319=1', 'opencode/1.4.2=1']);
  });

  it('ignores a count that is not a positive number, and a column that is not JSON', async () => {
    const w = world();
    await w.fdb.upsertSession(session({ id: 'x', last_seen_at: at(1), started_at: at(1, 9) }));
    await w.fdb.upsertAgent(agent('x', 'x1', { tool_counts_json: '{"Bash":"many","Read":-2,"Edit":2}' }));
    await w.fdb.upsertAgent(agent('x', 'x2', { tool_counts_json: 'not json' }));
    const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -3)));
    expect(b.tools.map((t) => `${t.tool}=${t.calls}`)).toEqual(['Edit=2']);
  });
});

describe('writeRollups tool counts', () => {
  it('writes them, and a second run gives the same rows', async () => {
    const w = world();
    await populateTools(w);
    const policy = { sessionsMs: 30 * DAY_MS };
    await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), policy);
    const first = await w.fdb.rollupRows('tools_daily', '2026-01-01', '2026-12-31');
    expect(first.length).toBe(5);
    await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), policy);
    expect(await w.fdb.rollupRows('tools_daily', '2026-01-01', '2026-12-31')).toEqual(first);
    // c2 has no tool counts, so it is not sized
    expect((await w.fdb.rollupRows('tool_sessions_daily', '2026-01-01', '2026-12-31')).length).toBe(2);
    expect((await w.fdb.rollupRows('harness_versions_daily', '2026-01-01', '2026-12-31')).length).toBe(3);
  });

  it('holds only names and counts: the columns of the three tables are a day, a harness, a name or a size, and a count', () => {
    const w = world();
    const columns = (t: string): string[] => (w.storage.sqliteHandle.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns('tools_daily')).toEqual(['day', 'harness', 'tool', 'calls']);
    expect(columns('tool_sessions_daily')).toEqual(['day', 'harness', 'bucket', 'sessions']);
    expect(columns('harness_versions_daily')).toEqual(['day', 'harness', 'version', 'reporters']);
  });
});

describe('buildRollups tool stats (#721)', () => {
  const loop = (counts: object, stats?: object): string => JSON.stringify({ skills: [], lastTool: null, toolCalls: 0, toolCounts: counts, ...(stats ? { toolStats: stats } : {}), steps: { done: 0, total: null } });
  const bashStats = { failed: 2, asked: 3, allowed: 2, denied: 1, podium: 1, times: { '10': 4, '30': 2 } };

  async function populateStats(w: ReturnType<typeof world>): Promise<void> {
    await w.fdb.upsertSession(session({ id: 'c1', owner: 'Priya', last_seen_at: at(2, 11), started_at: at(2, 9), harness: 'claude-code', loop_json: loop({ Bash: 6, Edit: 2 }, { Bash: bashStats }) }));
    await w.fdb.upsertAgent(agent('c1', 'a1', { tool_counts_json: counts({ Bash: 3 }), tool_stats_json: JSON.stringify({ Bash: { failed: 1, times: { '10': 1 } }, Read: { allowed: 0 } }) }));
    await w.fdb.upsertSession(session({ id: 'o1', owner: 'Dana', last_seen_at: at(2, 13), started_at: at(2, 9), harness: 'opencode', loop_json: loop({ Bash: 1 }) }));
  }

  it('adds the main loop to its agents, for the calls and for the stats, and keeps each harness apart', async () => {
    const w = world();
    await populateStats(w);
    const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
    const day = addDays(TODAY, -2);
    expect(b.tools.filter((t) => t.day === day).map((t) => `${t.harness}/${t.tool}=${t.calls}`).sort()).toEqual(['claude-code/Bash=9', 'claude-code/Edit=2', 'opencode/Bash=1']);
    expect(b.toolStats.filter((t) => t.day === day)).toEqual([{ day, harness: 'claude-code', tool: 'Bash', failed: 3, asked: 3, allowed: 2, denied: 1, podium: 1, timesJson: '{"10":5,"30":2}' }]);
    // the session is sized by all its calls, the main loop's and its agents'
    expect(b.toolSessions.filter((t) => t.day === day && t.harness === 'claude-code').map((t) => t.bucket)).toEqual([11]);
  });

  it('writes them, and a second run gives the same rows', async () => {
    const w = world();
    await populateStats(w);
    const policy = { sessionsMs: 30 * DAY_MS };
    await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), policy);
    const first = await w.fdb.rollupRows('tool_stats_daily', '2026-01-01', '2026-12-31');
    expect(first.length).toBe(1);
    await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), policy);
    expect(await w.fdb.rollupRows('tool_stats_daily', '2026-01-01', '2026-12-31')).toEqual(first);
  });

  it('ignores a stat that is not a positive number, a bucket that is not a number and a column that is not JSON', async () => {
    const w = world();
    await w.fdb.upsertSession(session({ id: 'x', last_seen_at: at(1), started_at: at(1, 9) }));
    await w.fdb.upsertAgent(agent('x', 'x1', { tool_counts_json: counts({ Bash: 1 }), tool_stats_json: '{"Bash":{"failed":"many","asked":-2,"allowed":2,"times":{"7":3,"x":1,"8":-1}}}' }));
    await w.fdb.upsertAgent(agent('x', 'x2', { tool_stats_json: 'not json' }));
    const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -3)));
    expect(b.toolStats.map((t) => `${t.tool}: failed ${t.failed}, asked ${t.asked}, allowed ${t.allowed}, ${t.timesJson}`)).toEqual(['Bash: failed 0, asked 0, allowed 2, {"7":3}']);
  });

  it('holds only names and counts: the columns are a day, a harness, a tool, counts and the call lengths', () => {
    const w = world();
    const columns = (t: string): string[] => (w.storage.sqliteHandle.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns('tool_stats_daily')).toEqual(['day', 'harness', 'tool', 'failed', 'asked', 'allowed', 'denied', 'podium', 'times_json']);
  });
});
