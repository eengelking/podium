// Contract cases for the report and rollup queries behind Admin > Reporting (#890): the four daily rollup tables, the stored sessions
// the reports read, the people and counts beside them, and the Admin log. One scenario runs over the adapter and over the reference
// (`sameOnBoth`). Several rows share a day, an owner or a time on purpose, so the order of ties is part of what is compared.
import { it, expect } from 'vitest';
import { sameOnBoth, type Openers } from './contractSame.js';
import { session } from './contract.js';
import type { AgentRow } from './rows.js';
import type { RollupTable } from './reportQueries.js';

const T0 = 1_800_000_000_000;
const TABLES: RollupTable[] = ['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily'];
const usage = (day: string, owner: string, model: string, over: object = {}) => ({
  day, owner, group: 'Crew', model, project: 'acme', sessions: 1, agents: 2, costUsd: 1.25, unpricedSessions: 0, tokIn: 1, tokOut: 2, tokCr: 3, tokCw: 4, ...over,
});

export function reportCases(o: Openers): void {
  it('matches the reference for the rollup tables: writing, reading a range with several rows a day, stats, and deleting', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
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
    expect(t.get('peak never goes down')).toBe(3);
  });

  it('matches the reference for the stored sessions a report reads, the people beside them, and the Admin log', async () => {
    const agent = (sessionId: string, id: string): AgentRow => ({
      session_id: sessionId, id, parent_id: null, kind: 'sub', type: 'Explore', name: null, description: 'look', model: null, effort: null, effort_source: null,
      status: 'done', started_at: T0, ended_at: T0 + 1, context_tokens: null, context_window: null, context_percent: null, tok_in: 1, tok_out: 2, tok_cr: 3, tok_cw: 4,
      cost_usd_est: null, skills_json: null, last_tool: null, tool_calls: 0, tool_counts_json: null, usage_json: null, blowouts: 0, steps_done: null, steps_total: null,
      prompt_excerpt: null, answer_excerpt: null, failure_json: null,
    });
    const t = await sameOnBoth(o, async (s, rec) => {
      const f = s.fleet;
      await rec('no sessions: oldest', f.oldestSessionSeen());
      await rec('no sessions: spans', f.sampleSpans());
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
      for (const a of [agent('s1', 'x1'), agent('s1', 'x2'), agent('s2', 'x3')]) await f.upsertAgent(a);
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
      await rec('sample spans', f.sampleSpans());
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
  });
}
