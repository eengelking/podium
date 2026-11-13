// Admin > Reporting > Tools (#721): failure rate, permission prompts and call duration per tool, for every harness, through the Admin API.
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminRouter } from '../admin/adminRouter.js';
import { toCsv, type ReportDeps, type ReportReply } from './reports.js';
import { addDays, costFn, writeRollups } from './rollups.js';
import { DAY_MS, NOW, TODAY, agent, at, session, world, type World } from '../storage/sqlite/rollupFixtures.js';
import { bucketMs } from './protocol.js';

const SECRET = 'the-admin-secret-0123456789';
const H = { 'X-Podium-Admin': '1' };

async function api(w: World, reports: ReportDeps = w.deps) {
  await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), { sessionsMs: 30 * DAY_MS });
  const app = express();
  app.use('/api/admin', createAdminRouter({ secret: SECRET, storage: w.storage, people: w.people, reports, now: () => NOW }));
  const agentReq = request.agent(app);
  await agentReq.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET });
  return { get: (path: string) => agentReq.get(`/api/admin/reports/${path}`).set(H) };
}

const d3 = addDays(TODAY, -3);

/** Three sessions three days ago (two Claude Code, one OpenCode) and one Claude Code session today, which the report reads live. */
async function filled(): Promise<World> {
  const w = world();
  const add = async (id: string, daysAgo: number, harness: string, counts: object, stats: object | null, failure: object | null = null) => {
    await w.fdb.upsertSession(session({ id, owner: 'Priya', harness, started_at: at(daysAgo, 9), last_seen_at: at(daysAgo, 11), ended_at: at(daysAgo, 11) }));
    await w.fdb.upsertAgent(agent(id, `${id}-a`, { tool_counts_json: JSON.stringify(counts), tool_stats_json: stats ? JSON.stringify(stats) : null, failure_json: failure ? JSON.stringify(failure) : null }));
  };
  await add('c1', 3, 'claude-code', { Bash: 10, mcp__github__search_code: 6 }, { Bash: { failed: 2, asked: 4, allowed: 3, denied: 1, podium: 2, times: { '10': 5, '30': 3 } }, mcp__github__search_code: { failed: 1, times: { '20': 2 } } }, { class: 'command-failed', tool: 'Bash' });
  await add('c2', 3, 'claude-code', { Bash: 30 }, { Bash: { failed: 3, asked: 2, allowed: 1 } });
  await add('o1', 3, 'opencode', { Bash: 4 }, { Bash: { failed: 1 } });
  await add('c3', 0, 'claude-code', { Bash: 5, Edit: 5 }, { Edit: { asked: 1, denied: 1, podium: 1 } });
  return w;
}

const rowsOf = (r: ReportReply, keys: string[]): string[] => r.rows.map((x) => keys.map((k) => String(x[k])).join('|'));

describe('tools: failures', () => {
  it('has the calls, the failed calls and the rate of each tool, per period and harness', async () => {
    const { get } = await api(await filled());
    const r = (await get(`tools?from=${addDays(TODAY, -5)}&to=${TODAY}&by=day&breakdown=failures`)).body as ReportReply;
    expect(r.columns.map((c) => c.key)).toEqual(['period', 'harness', 'server', 'tool', 'calls', 'failed', 'rate', 'stored', 'sessionIds']);
    expect(rowsOf(r, ['period', 'harness', 'server', 'tool', 'calls', 'failed', 'rate'])).toEqual([
      `${d3}|claude-code||Bash|40|5|12.5`, `${d3}|claude-code|github|search_code|6|1|16.7`, `${d3}|opencode||Bash|4|1|25`, `${TODAY}|claude-code||Bash|5|0|0`, `${TODAY}|claude-code||Edit|5|0|0`,
    ]);
    expect(r.total).toEqual({ calls: 60, failed: 7 });
  });

  it('links a tool to the stored sessions that recorded a failure in it, and only that tool in that harness', async () => {
    const { get } = await api(await filled());
    const r = (await get(`tools?from=${addDays(TODAY, -5)}&to=${TODAY}&by=day&breakdown=failures`)).body as ReportReply;
    const bash = r.rows.find((x) => x.period === d3 && x.harness === 'claude-code' && x.tool === 'Bash')!;
    expect(bash.sessionIds).toEqual(['c1']);
    expect(bash.stored).toBe(1);
    const other = r.rows.find((x) => x.period === d3 && x.harness === 'opencode')!;
    expect(other.sessionIds).toBeUndefined();
    expect(other.stored).toBe(0);
  });

  it('shows counts and no link to a viewer who may not open the session', async () => {
    const w = await filled();
    const { get } = await api(w, { ...w.deps, mayOpenSession: (id: string) => id !== 'c1' });
    const r = (await get(`tools?from=${addDays(TODAY, -5)}&to=${TODAY}&by=day&breakdown=failures`)).body as ReportReply;
    const bash = r.rows.find((x) => x.period === d3 && x.harness === 'claude-code' && x.tool === 'Bash')!;
    expect(bash.sessionIds).toBeUndefined();
    expect(bash.stored).toBe(1);
    expect(bash.failed).toBe(5);
  });

  it('narrows to one harness', async () => {
    const { get } = await api(await filled());
    const r = (await get(`tools?from=${addDays(TODAY, -5)}&to=${TODAY}&by=week&breakdown=failures&harness=opencode`)).body as ReportReply;
    expect(r.rows.every((x) => x.harness === 'opencode')).toBe(true);
    expect(r.total).toEqual({ calls: 4, failed: 1 });
  });

  it('exports a harness column in the CSV', async () => {
    const { get } = await api(await filled());
    const r = (await get(`tools?from=${addDays(TODAY, -5)}&to=${TODAY}&by=day&breakdown=failures`)).body as ReportReply;
    expect(toCsv(r.columns, r.rows).split('\r\n')[0]).toContain('Harness');
  });
});

describe('tools: permission prompts', () => {
  it('has asked, allowed, denied, no answer and answered in Podium for each tool', async () => {
    const { get } = await api(await filled());
    const r = (await get(`tools?from=${addDays(TODAY, -5)}&to=${TODAY}&by=day&breakdown=prompts`)).body as ReportReply;
    expect(r.columns.map((c) => c.key)).toEqual(['period', 'harness', 'server', 'tool', 'calls', 'asked', 'allowed', 'denied', 'noAnswer', 'podium']);
    expect(rowsOf(r, ['period', 'harness', 'tool', 'calls', 'asked', 'allowed', 'denied', 'noAnswer', 'podium'])).toEqual([`${d3}|claude-code|Bash|40|6|4|1|1|2`, `${TODAY}|claude-code|Edit|5|1|0|1|0|1`]);
    expect(r.total).toEqual({ calls: 60, asked: 7, allowed: 4, denied: 2, noAnswer: 1, podium: 3 });
  });

  it('never has more answers than asks, whatever a reporter sent', async () => {
    const w = world();
    await w.fdb.upsertSession(session({ id: 'x', last_seen_at: at(1), started_at: at(1, 9) }));
    await w.fdb.upsertAgent(agent('x', 'x1', { tool_counts_json: '{"Bash":3}', tool_stats_json: '{"Bash":{"asked":1,"allowed":2,"denied":2}}' }));
    const { get } = await api(w);
    const r = (await get(`tools?from=${addDays(TODAY, -3)}&to=${TODAY}&by=day&breakdown=prompts`)).body as ReportReply;
    expect(r.rows[0]).toMatchObject({ asked: 1, allowed: 2, denied: 2, noAnswer: 0 });
  });
});

describe('tools: call duration', () => {
  it('reads the median and the 95th percentile from the call lengths, per tool and for the whole period', async () => {
    const { get } = await api(await filled());
    const r = (await get(`tools?from=${addDays(TODAY, -5)}&to=${TODAY}&by=day&breakdown=duration`)).body as ReportReply;
    expect(r.columns.map((c) => c.key)).toEqual(['period', 'harness', 'server', 'tool', 'timed', 'p50Ms', 'p95Ms']);
    expect(rowsOf(r, ['period', 'harness', 'tool', 'timed', 'p50Ms', 'p95Ms'])).toEqual([`${d3}|claude-code|Bash|8|${bucketMs(10)}|${bucketMs(30)}`, `${d3}|claude-code|search_code|2|${bucketMs(20)}|${bucketMs(20)}`]);
    expect(r.total).toEqual({ timed: 10, p50Ms: bucketMs(10), p95Ms: bucketMs(30) });
    // slowest first, and an MCP server has a row of its own beside its tools, read from all its calls and not from its tools' figures
    expect(r.byTool).toEqual([
      { server: '', tool: 'Bash', timed: 8, p50Ms: bucketMs(10), p95Ms: bucketMs(30) },
      { server: 'github', tool: '', timed: 2, p50Ms: bucketMs(20), p95Ms: bucketMs(20) },
      { server: 'github', tool: 'search_code', timed: 2, p50Ms: bucketMs(20), p95Ms: bucketMs(20) },
    ]);
    expect(r.timedHarnesses).toEqual(['claude-code']);
    expect(r.harnesses).toEqual(['claude-code', 'opencode']);
  });

  it('refuses a person filter like the other tool breakdowns, and an unknown breakdown', async () => {
    const { get } = await api(await filled());
    expect((await get('tools?breakdown=duration&person=Priya')).status).toBe(400);
    expect((await get('tools?breakdown=speed')).status).toBe(400);
  });
});
