// Contract cases for the report and rollup queries behind Admin > Reporting (#890): the thirteen daily rollup tables (three are the tool counts of #720, four the session time, agents, people and hours of #722, two the cost and context of #723), the stored sessions
// the reports read, the people and counts beside them, and the Admin log. One scenario runs over every adapter
// (`sameOnAll`). Several rows share a day, an owner or a time on purpose, so the order of ties is part of what is compared.
import { it, expect } from 'vitest';
import { sameOnAll, type Openers } from './contractSame.js';
import { session } from './contract.js';
import type { AgentRow, SessionWaitRow } from './rows.js';
import type { RollupTable } from './reportQueries.js';

const T0 = 1_800_000_000_000;
const TABLES: RollupTable[] = ['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily', 'tools_daily', 'tool_sessions_daily', 'harness_versions_daily', 'tool_stats_daily', 'session_time_daily', 'agents_daily', 'person_sessions_daily', 'hour_peaks_daily', 'cost_daily', 'tool_cost_daily'];
const usage = (day: string, owner: string, model: string, over: object = {}) => ({
  day, owner, group: 'Crew', model, project: 'acme', sessions: 1, agents: 2, costUsd: 1.25, unpricedSessions: 0, tokIn: 1, tokOut: 2, tokCr: 3, tokCw: 4, ...over,
});

export function reportCases(o: Openers): void {
  it('agrees on every adapter for the rollup tables: writing, reading a range with several rows a day, stats, and deleting', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const f = s.fleet;
      await rec('empty stats', Promise.all(TABLES.map((tb) => f.rollupStats(tb))));
      await rec('empty oldest', Promise.all(TABLES.map((tb) => f.rollupOldestDay(tb))));
      // five rows on one day: owner, group, model and project differ, and none of them is the first stored
      await f.insertUsage([
        usage('2026-10-02', 'zed', 'opus'), usage('2026-10-02', 'Ann', 'sonnet'), usage('2026-10-02', 'ann', 'haiku'),
        usage('2026-10-02', 'ann', 'haiku', { project: 'Acme' }), usage('2026-10-01', 'bob', 'opus'), usage('2026-10-03', 'bob', 'opus', { costUsd: 0.1 + 0.2 }),
      ]);
      await f.insertSessionsDaily([
        { day: '2026-10-02', outcome: 'done', model: 'opus', effort: 'high', plan: 'max', sessions: 2, durationS: 60, maxDurationS: 50, agents: 3, blowouts: 1, maxContextPct: 40.5 },
        { day: '2026-10-02', outcome: 'aborted', model: 'opus', effort: 'low', plan: 'pro', sessions: 1, durationS: 5, maxDurationS: 5, agents: 0, blowouts: 0, maxContextPct: 3 },
        { day: '2026-10-02', outcome: 'done', model: 'haiku', effort: 'low', plan: 'pro', sessions: 1, durationS: 5, maxDurationS: 5, agents: 0, blowouts: 0, maxContextPct: 3 },
      ]);
      await f.insertFailures([
        { day: '2026-10-02', owner: 'ann', cls: 'timeout', tool: 'Bash', count: 2 }, { day: '2026-10-02', owner: 'Ann', cls: 'denied', tool: 'Read', count: 1 },
        { day: '2026-10-02', owner: 'ann', cls: 'timeout', tool: '', count: 4 },
      ]);
      // the tool counts (#720): names and counts only, one row per harness and tool, per harness and size of session, per harness and version
      await f.insertToolsDaily([
        { day: '2026-10-02', harness: 'opencode', tool: 'Bash', calls: 4 }, { day: '2026-10-02', harness: 'claude-code', tool: 'mcp__github__search_code', calls: 7 },
        { day: '2026-10-02', harness: 'claude-code', tool: 'Bash', calls: 9 }, { day: '2026-10-02', harness: 'claude-code', tool: 'bash', calls: 1 }, { day: '2026-10-01', harness: 'claude-code', tool: 'Read', calls: 3 },
      ]);
      await f.insertToolSessionsDaily([
        { day: '2026-10-02', harness: 'opencode', bucket: 12, sessions: 1 }, { day: '2026-10-02', harness: 'claude-code', bucket: 12, sessions: 2 }, { day: '2026-10-02', harness: 'claude-code', bucket: 0, sessions: 1 },
        { day: '2026-10-01', harness: 'claude-code', bucket: 300, sessions: 1 },
      ]);
      await f.insertHarnessVersionsDaily([
        { day: '2026-10-02', harness: 'opencode', version: '1.4.2', reporters: 1 }, { day: '2026-10-02', harness: 'claude-code', version: '2.1.319', reporters: 2 },
        { day: '2026-10-02', harness: 'claude-code', version: '2.1.305', reporters: 1 }, { day: '2026-10-01', harness: 'claude-code', version: '2.1.305', reporters: 3 },
      ]);
      // what each tool did (#721): counts only, one row per harness and tool, the call lengths as JSON of bucket to calls
      await f.insertToolStatsDaily([
        { day: '2026-10-02', harness: 'opencode', tool: 'Bash', failed: 1, asked: 0, allowed: 0, denied: 0, podium: 0, timesJson: '{}' },
        { day: '2026-10-02', harness: 'claude-code', tool: 'Bash', failed: 2, asked: 4, allowed: 3, denied: 1, podium: 2, timesJson: '{"10":5,"30":3}' },
        { day: '2026-10-02', harness: 'claude-code', tool: 'bash', failed: 0, asked: 1, allowed: 1, denied: 0, podium: 0, timesJson: '{"7":1}' },
        { day: '2026-10-01', harness: 'claude-code', tool: 'Read', failed: 0, asked: 0, allowed: 0, denied: 0, podium: 0, timesJson: '{"2":9}' },
      ]);
      // how long sessions ran and waited, which agents they launched, who ran sessions and the peak of each hour (#722): names, counts and times only
      const time = (day: string, harness: string, over: object = {}) => ({ day, harness, sessions: 2, durationS: 120, maxDurationS: 90, trackedSessions: 1, trackedS: 60, permissionS: 10, permissionN: 2, questionS: 5, questionN: 1, planS: 0, planN: 0, ...over });
      await f.insertSessionTimeDaily([time('2026-10-02', 'opencode'), time('2026-10-02', 'claude-code'), time('2026-10-02', 'Claude-code', { sessions: 1 }), time('2026-10-01', 'claude-code', { trackedSessions: 0, trackedS: 0 })]);
      await f.insertAgentsDaily([
        { day: '2026-10-02', harness: 'opencode', type: 'general', depth: 1, agents: 2 }, { day: '2026-10-02', harness: 'claude-code', type: 'Explore', depth: 2, agents: 1 },
        { day: '2026-10-02', harness: 'claude-code', type: 'Explore', depth: 1, agents: 3 }, { day: '2026-10-02', harness: 'claude-code', type: 'explore', depth: 1, agents: 1 }, { day: '2026-10-01', harness: 'claude-code', type: '', depth: 10, agents: 1 },
      ]);
      await f.insertPersonSessionsDaily([
        { day: '2026-10-02', owner: 'zed', group: '', harness: 'opencode', sessions: 1 }, { day: '2026-10-02', owner: 'Ann', group: 'Crew', harness: 'claude-code', sessions: 2 }, { day: '2026-10-02', owner: 'ann', group: 'Crew', harness: 'claude-code', sessions: 1 },
        { day: '2026-10-02', owner: 'ann', group: 'Crew', harness: 'opencode', sessions: 4 }, { day: '2026-10-01', owner: '', group: '', harness: 'claude-code', sessions: 1 },
      ]);
      // what sessions cost and how they ended, by harness, model and effort, and by tool (#723): ties on every key but one, and a model with no price (cost 0, none priced)
      const cost = (day: string, harness: string, model: string, effort: string, over: object = {}) => ({ day, harness, model, effort, sessions: 2, pricedSessions: 2, calls: 10, pricedCalls: 10, costUsd: 0.1 + 0.2, callCostUsd: 0.25, tokIn: 5, tokOut: 6, tokCr: 7, tokCw: 8, endedLow: 1, endedMid: 0, endedHigh: 1, endedUnknown: 0, compacted: 1, cleared: 0, ...over });
      await f.insertCostDaily([
        cost('2026-10-02', 'opencode', 'opus', 'high'), cost('2026-10-02', 'claude-code', 'opus', 'low'), cost('2026-10-02', 'claude-code', 'Opus', 'low', { sessions: 1 }), cost('2026-10-02', 'claude-code', 'opus', 'high'),
        cost('2026-10-02', 'claude-code', 'mystery', '', { pricedSessions: 0, pricedCalls: 0, costUsd: 0, callCostUsd: 0, cleared: 1 }), cost('2026-10-01', 'claude-code', 'opus', 'high'),
      ]);
      await f.insertToolCostDaily([
        { day: '2026-10-02', harness: 'opencode', tool: 'Bash', sessions: 2, pricedSessions: 2, costUsd: 0.5, calls: 9 }, { day: '2026-10-02', harness: 'claude-code', tool: 'Bash', sessions: 3, pricedSessions: 1, costUsd: 0.25, calls: 12 },
        { day: '2026-10-02', harness: 'claude-code', tool: 'bash', sessions: 1, pricedSessions: 1, costUsd: 0.1 + 0.2, calls: 1 }, { day: '2026-10-01', harness: 'claude-code', tool: 'Edit', sessions: 1, pricedSessions: 0, costUsd: 0, calls: 4 },
      ]);
      await f.upsertHourPeaks([{ day: '2026-10-02', harness: '', hour: 14, peak: 3 }, { day: '2026-10-02', harness: 'opencode', hour: 14, peak: 1 }, { day: '2026-10-02', harness: 'claude-code', hour: 9, peak: 2 }, { day: '2026-10-01', harness: '', hour: 0, peak: 1 }]);
      await rec('hour peaks stored', f.rollupRows('hour_peaks_daily', '2026-10-01', '2026-10-31'));
      await f.upsertHourPeaks([{ day: '2026-10-02', harness: '', hour: 14, peak: 2 }, { day: '2026-10-02', harness: 'opencode', hour: 14, peak: 5 }]);
      await rec('hour peak never goes down, and a higher one is kept', f.rollupRows('hour_peaks_daily', '2026-10-02', '2026-10-02'));
      const fleetDay = (day: string, peakLive: number) => ({ day, activePeople: 2, activeReporters: 3, sessionsStarted: 5, peakLive, reporterVersions: { '1.0.0': 2, '0.9.0': 1 }, engineVersions: {} });
      await f.upsertFleetDays([{ day: fleetDay('2026-10-02', 3), peak: 3 }, { day: fleetDay('2026-10-01', 1), peak: 1 }]);
      await rec('peak stored', f.storedPeak('2026-10-02'));
      await f.upsertFleetDays([{ day: fleetDay('2026-10-02', 2), peak: 2 }]);
      await rec('peak never goes down', f.storedPeak('2026-10-02'));
      await rec('peak (no run)', f.storedPeak('2026-09-01'));
      for (const tb of TABLES) await rec(`rows ${tb}`, f.rollupRows(tb, '2026-10-01', '2026-10-31'));
      for (const tb of TABLES) await rec(`rows ${tb} (one day)`, f.rollupRows(tb, '2026-10-02', '2026-10-02'));
      await rec('rows (no match)', f.rollupRows('usage_daily', '2027-01-01', '2027-01-02'));
      await rec('stats', Promise.all(TABLES.map((tb) => f.rollupStats(tb))));
      await rec('oldest', Promise.all(TABLES.map((tb) => f.rollupOldestDay(tb))));
      await rec('days before', f.rollupDaysBefore('2026-10-03'));
      await rec('days before (all)', f.rollupDaysBefore('2027-01-01'));
      await rec('delete before', f.deleteRollupsBefore('2026-10-02'));
      await rec('stats (after delete before)', Promise.all(TABLES.map((tb) => f.rollupStats(tb))));
      await f.deleteRollupsFrom('2026-10-03');
      await rec('stats (after delete from)', Promise.all(TABLES.map((tb) => f.rollupStats(tb))));
      await rec('rows (after)', f.rollupRows('usage_daily', '2026-10-01', '2026-10-31'));
    });
    expect((t.get('rows usage_daily') as unknown[]).length).toBe(6);
    expect((t.get('rows tools_daily') as unknown[]).length).toBe(5);
    expect((t.get('rows harness_versions_daily') as unknown[]).length).toBe(4);
    expect((t.get('rows tool_stats_daily') as unknown[]).length).toBe(4);
    expect((t.get('rows session_time_daily') as unknown[]).length).toBe(4);
    expect((t.get('rows agents_daily') as unknown[]).length).toBe(5);
    expect((t.get('rows person_sessions_daily') as unknown[]).length).toBe(5);
    expect((t.get('rows cost_daily') as unknown[]).length).toBe(6);
    expect((t.get('rows tool_cost_daily') as unknown[]).length).toBe(4);
    expect(t.get('peak never goes down')).toBe(3);
    const hours = t.get('hour peak never goes down, and a higher one is kept') as { harness: string; hour: number; peak: number }[];
    expect(hours.map((r) => `${r.harness || 'all'}/${r.hour}=${r.peak}`)).toEqual(['all/14=3', 'claude-code/9=2', 'opencode/14=5']);
  });

  it('agrees on every adapter for the stored sessions a report reads, the people beside them, and the Admin log', async () => {
    const agent = (sessionId: string, id: string): AgentRow => ({
      session_id: sessionId, id, parent_id: null, kind: 'sub', type: 'Explore', name: null, description: 'look', model: null, effort: null, effort_source: null,
      status: 'done', started_at: T0, ended_at: T0 + 1, context_tokens: null, context_window: null, context_percent: null, tok_in: 1, tok_out: 2, tok_cr: 3, tok_cw: 4,
      cost_usd_est: null, skills_json: null, last_tool: null, tool_calls: 0, tool_counts_json: null, tool_stats_json: null, usage_json: null, blowouts: 0, steps_done: null, steps_total: null,
      prompt_excerpt: null, answer_excerpt: null, failure_json: null, model_label: null, model_provider: null,
    });
    const t = await sameOnAll(o, async (s, rec) => {
      const f = s.fleet;
      await rec('no sessions: oldest', f.oldestSessionSeen());
      await rec('no sessions: spans', f.sampleSpans());
      await rec('no sessions: spans by harness', f.sampleSpansByHarness());
      await rec('no sessions: waits', f.waitsSince(0));
      await rec('no sessions: agent links', f.agentLinksSince(0));
      await rec('no wait record', f.getSessionWait('s1'));
      await rec('no people', f.knownPeople());
      await rec('no reporters', f.countReporters());
      const crew = await s.people.createGroup('Crew', T0);
      const { person } = await s.people.createPerson('ann', crew.id, T0);
      await s.people.createPerson('bob', null, T0);
      await s.people.touch(person.id, '203.0.113.1', T0 + 50);
      await s.people.createPerson('Ann-two', null, T0);
      await s.people.createGroup('Empty', T0);
      // sessions seen at the same moment, so the order of ties is part of the answer
      for (const [id, owner, seenAt] of [['s3', 'ann', T0 + 30], ['s1', 'ann', T0 + 30], ['s2', 'bob', T0 + 30], ['old', null, T0 - 10], ['s4', 'ghost', T0 + 31]] as const) {
        await f.upsertSession(session({ id, owner, last_seen_at: seenAt, started_at: seenAt - 5 }));
      }
      const counted = (a: AgentRow, counts: object, stats?: object): AgentRow => ({ ...a, tool_counts_json: JSON.stringify(counts), tool_stats_json: stats ? JSON.stringify(stats) : null });
      // agents that were launched by another agent, and one whose parent is not stored (#722)
      for (const a of [counted(agent('s1', 'x1'), { Bash: 3, Read: 1 }, { Bash: { failed: 1, times: { '10': 2 } } }), counted(agent('s1', 'x2'), { Bash: 2, mcp__github__search_code: 4 }), agent('s2', 'x3'), { ...agent('s1', 'x4'), parent_id: 'x1', type: 'Plan' }, { ...agent('s2', 'x5'), parent_id: 'gone' }]) await f.upsertAgent(a);
      await f.upsertSample({ session_id: 's1', t: 10, tokens_total: 1, tokens_delta: 1, peak_context: 1, running_agents: 0, cost_usd: null });
      await f.upsertSample({ session_id: 's1', t: 90, tokens_total: 2, tokens_delta: 1, peak_context: 1, running_agents: 0, cost_usd: null });
      await f.upsertSample({ session_id: 's2', t: 20, tokens_total: 2, tokens_delta: 1, peak_context: 1, running_agents: 0, cost_usd: null });
      await s.reporters.record({ kind: 'mod', machineId: 'rk1', machineName: 'box', source: '203.0.113.1', owner: 'ann', credential: 'person', version: '0.1.0', engineVersion: null, sessionId: 's1' }, T0);
      await s.reporters.record({ kind: 'mod', machineId: 'rk2', machineName: 'box2', source: '203.0.113.2', owner: 'ann', credential: 'person', version: '0.2.0', engineVersion: null, sessionId: 's1' }, T0);
      await s.reporters.record({ kind: 'mod', machineId: 'rk3', machineName: 'box3', source: '203.0.113.3', owner: 'bob', credential: 'person', version: '0.2.0', engineVersion: null, sessionId: 's2' }, T0);
      await f.insertEvent({ id: 'ev1', session_id: 's1', agent_id: null, t: T0, kind: 'failure', text: 'bad', data_json: JSON.stringify({ cls: 'timeout', tool: 'Bash' }) });
      await rec('oldest', f.oldestSessionSeen());
      await rec('sessions since', f.sessionsSince(T0));
      await rec('sessions since (everything)', f.sessionsSince(0));
      await rec('agent counts', f.agentCountsSince(T0));
      await rec('reporter keys', f.reporterKeysSince(T0));
      await rec('failure rows', f.failureRowsSince(T0));
      await rec('tool counts', f.toolCountsSince(T0));
      await rec('tool counts (nothing that recent)', f.toolCountsSince(T0 + 1_000_000));
      await rec('tool stats', f.toolStatsSince(T0));
      await rec('tool stats (nothing that recent)', f.toolStatsSince(T0 + 1_000_000));
      await rec('sample spans', f.sampleSpans());
      await rec('sample spans by harness', f.sampleSpansByHarness());
      // waiting on the person (#722): a record is written, read back, changed in place, and goes with its session
      const waitRow = (id: string, over: Partial<SessionWaitRow> = {}): SessionWaitRow => ({ session_id: id, permission_ms: 1500, permission_n: 2, question_ms: 0, question_n: 0, plan_ms: 40, plan_n: 1, tracked_since: T0, open_kind: null, open_since: null, ...over });
      await f.putSessionWait(waitRow('s1'));
      await f.putSessionWait(waitRow('s3', { open_kind: 'question', open_since: T0 + 9 }));
      await f.putSessionWait(waitRow('old'));
      await rec('wait record', f.getSessionWait('s1'));
      await f.putSessionWait(waitRow('s1', { permission_ms: 9000, permission_n: 3, open_kind: 'plan', open_since: T0 + 5 }));
      await rec('wait record (changed in place)', f.getSessionWait('s1'));
      await rec('waits since', f.waitsSince(T0));
      await rec('waits since (nothing that recent)', f.waitsSince(T0 + 1_000_000));
      await rec('agent links', f.agentLinksSince(T0));
      await f.deleteSession('old');
      await rec('wait record (its session deleted)', f.getSessionWait('old'));
      await rec('owner group names', f.ownerGroupNames());
      await rec('known people', f.knownPeople());
      await rec('reporters', f.countReporters());
      await rec('groups', f.countGroups());
      for (const [i, kind] of ['a', 'b', 'a', 'c', 'a'].entries()) await s.people.log(kind, `detail ${i}`, 'src', T0 + (i < 3 ? 10 : 20), i % 2 ? 'ed' : null);
      await rec('admin log', f.adminLogRows(T0, T0 + 100, undefined, 10));
      await rec('admin log (kind)', f.adminLogRows(T0, T0 + 100, 'a', 10));
      await rec('admin log (limit)', f.adminLogRows(T0, T0 + 100, undefined, 2));
      await rec('admin log (range)', f.adminLogRows(T0 + 15, T0 + 100, undefined, 10));
      await rec('admin log (none)', f.adminLogRows(T0 + 200, T0 + 300, undefined, 10));
    });
    expect((t.get('sessions since') as unknown[]).length).toBeGreaterThan(0);
    // the agent with no counts (x3) is left out, and the two that have them come back in a fixed order
    expect(t.get('tool stats')).toEqual([{ id: 's1', s: '{"Bash":{"failed":1,"times":{"10":2}}}' }]);
    expect(t.get('tool counts')).toEqual([{ id: 's1', c: '{"Bash":3,"Read":1}' }, { id: 's1', c: '{"Bash":2,"mcp__github__search_code":4}' }]);
    expect(t.get('wait record (its session deleted)')).toBeUndefined();
    expect((t.get('waits since') as { session_id: string }[]).map((r) => r.session_id)).toEqual(['s1', 's3']);
    expect((t.get('agent links') as { agent: string; parent: string | null }[]).filter((r) => r.parent !== null).map((r) => `${r.agent}<${r.parent}`)).toEqual(['x4<x1', 'x5<gone']);
  });
}
