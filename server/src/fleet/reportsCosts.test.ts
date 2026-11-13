// Admin > Reporting cost, tokens, model and effort mix and context at the end (#723), for every harness, through the Admin API.
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminRouter } from '../admin/adminRouter.js';
import { toCsv, type ReportReply } from './reports.js';
import { addDays, costFn, writeRollups } from './rollups.js';
import { DAY_MS, NOW, TODAY, agent, at, session, world, type World } from '../storage/sqlite/rollupFixtures.js';

const SECRET = 'the-admin-secret-0123456789';
const H = { 'X-Podium-Admin': '1' };

async function api(w: World) {
  await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), { sessionsMs: 30 * DAY_MS });
  const app = express();
  app.use('/api/admin', createAdminRouter({ secret: SECRET, storage: w.storage, people: w.people, reports: w.deps, now: () => NOW }));
  const agentReq = request.agent(app);
  await agentReq.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET });
  return { get: (path: string) => agentReq.get(`/api/admin/reports/${path}`).set(H) };
}

/**
 * Three days ago, Claude Code: two priced opus sessions (4 and 2 dollars, 4 and 2 tool calls) and one on a model with no price (3 calls). One OpenCode session on
 * opus (1 dollar, 4 calls). Five days ago a priced sonnet session. Today a priced opus session, read live.
 */
async function filled(): Promise<World> {
  const w = world();
  const add = (id: string, daysAgo: number, over: Parameters<typeof session>[0] extends infer S ? Partial<S> : never) =>
    w.fdb.upsertSession(session({ id, started_at: at(daysAgo, 9), last_seen_at: at(daysAgo, 10), ended_at: at(daysAgo, 10), ...over }));
  await add('c1', 3, { model: 'opus', effort: 'high', cost_usd: 4, context_percent: 91, tok_in: 100, tok_out: 20, tok_cr: 300, tok_cw: 100 });
  await add('c2', 3, { model: 'opus', effort: 'low', cost_usd: 2, context_percent: 30, tok_in: 100, tok_out: 10, tok_cr: 100, tok_cw: 0 });
  await add('c3', 3, { model: 'mystery', effort: null, cost_usd: null, context_percent: null, cleared_from: 'c1' });
  await add('o1', 3, { model: 'opus', effort: 'high', cost_usd: 1, harness: 'opencode', context_percent: 60, tok_in: 50, tok_out: 5, tok_cr: 50, tok_cw: 0 });
  await add('c0', 5, { model: 'sonnet', effort: 'low', cost_usd: 1.5, context_percent: 10 });
  await add('c4', 0, { model: 'opus', effort: 'high', cost_usd: 3, context_percent: 85 });
  for (const [id, tool, n] of [['c1', 'Bash', 3], ['c1', 'Edit', 1], ['c2', 'Bash', 2], ['c3', 'Bash', 3], ['o1', 'Bash', 4], ['c0', 'Read', 2], ['c4', 'Bash', 6]] as const) {
    await w.fdb.upsertAgent(agent(id, `${id}-${tool}`, { tool_counts_json: JSON.stringify({ [tool]: n }) }));
  }
  return w;
}

describe('the costs report', () => {
  it('gives the cost per call and per session by model, leaves a model with no price out of every cost, and counts its calls apart', async () => {
    const { get } = await api(await filled());
    const r = (await get(`costs?breakdown=model&from=${addDays(TODAY, -6)}&to=${TODAY}`)).body as ReportReply;
    const byModel = r.models as { model: string; sessions: number; calls: number; spendUsd: number | null; perCallUsd: number | null; perSessionUsd: number | null }[];
    expect(byModel.map((m) => m.model)).toEqual(['opus', 'sonnet', 'mystery']);
    expect(byModel[0]).toMatchObject({ sessions: 4, calls: 16, spendUsd: 10, perCallUsd: 0.625, perSessionUsd: 2.5 });
    expect(byModel[2]).toMatchObject({ sessions: 1, calls: 3, spendUsd: null, perCallUsd: null, perSessionUsd: null });
    expect(r.total).toMatchObject({ sessions: 6, pricedSessions: 5, pricedCalls: 18, unpricedCalls: 3, spendUsd: 11.5 });
    // a row for each harness and model, with the harness named
    expect(r.rows.map((x) => `${x.harness}/${x.model}`)).toEqual(['claude-code/opus', 'claude-code/sonnet', 'opencode/opus', 'claude-code/mystery']);
  });

  it('narrows to one harness and one model', async () => {
    const { get } = await api(await filled());
    const r = (await get(`costs?breakdown=model&harness=opencode&from=${addDays(TODAY, -6)}&to=${TODAY}`)).body as ReportReply;
    expect(r.total).toMatchObject({ sessions: 1, spendUsd: 1, perCallUsd: 0.25 });
    const m = (await get(`costs?breakdown=model&model=sonnet&from=${addDays(TODAY, -6)}&to=${TODAY}`)).body as ReportReply;
    expect(m.total).toMatchObject({ sessions: 1, spendUsd: 1.5 });
  });

  it('gives the average spend of the sessions that called each tool, and says a tool has none of its own', async () => {
    const { get } = await api(await filled());
    const r = (await get(`costs?breakdown=tool&from=${addDays(TODAY, -6)}&to=${TODAY}`)).body as ReportReply;
    const tools = r.tools as { tool: string; sessions: number; avgSpendUsd: number | null; avgCalls: number | null }[];
    // Bash: c1 (4), c2 (2), c3 (no price), o1 (1), c4 (3): five sessions, four priced
    expect(tools[0]).toEqual({ tool: 'Bash', sessions: 5, avgSpendUsd: 2.5, avgCalls: 3.6 });
    expect(r.rows.some((x) => x.tool === 'Bash' && x.harness === 'opencode')).toBe(true);
    expect((await get(`costs?breakdown=tool&model=opus`)).status).toBe(400);
  });

  it('splits tokens and gives a cache hit rate by period, harness and whole', async () => {
    const { get } = await api(await filled());
    const r = (await get(`costs?breakdown=tokens&by=day&from=${addDays(TODAY, -3)}&to=${addDays(TODAY, -3)}`)).body as ReportReply;
    expect(r.rows.map((x) => `${x.harness}: ${x.tokIn}/${x.tokOut}/${x.tokCr}/${x.tokCw} ${x.cacheHitPct}`)).toEqual(['claude-code: 300/80/410/105 50.3', 'opencode: 50/5/50/0 50']);
    expect(r.total).toMatchObject({ tokIn: 350, tokCr: 460, cacheHitPct: 50.3 });
    const empty = (await get(`costs?breakdown=tokens&from=${addDays(TODAY, -40)}&to=${addDays(TODAY, -39)}`)).body as ReportReply;
    expect(empty.total.cacheHitPct).toBeNull();
    expect(empty.partial).toBe(true);
  });

  it('gives the model mix and the effort mix as shares of each period', async () => {
    const { get } = await api(await filled());
    const r = (await get(`costs?breakdown=mix&by=day&from=${addDays(TODAY, -3)}&to=${addDays(TODAY, -3)}`)).body as ReportReply;
    expect((r.combined as { model: string; sessions: number; sharePct: number }[]).map((x) => `${x.model} ${x.sessions} ${x.sharePct}`)).toEqual(['opus 3 75', 'mystery 1 25']);
    const e = (await get(`costs?breakdown=mix&mixof=effort&by=day&from=${addDays(TODAY, -3)}&to=${addDays(TODAY, -3)}`)).body as ReportReply;
    expect(e.mixOf).toBe('effort');
    expect((e.combined as { effort: string; sessions: number }[]).map((x) => `${x.effort} ${x.sessions}`)).toEqual(['high 2', '- 1', 'low 1']);
    expect((await get('costs?breakdown=mix&mixof=plan')).status).toBe(400);
  });

  it('counts sessions by how full the context was at the end, and those that continued after /clear', async () => {
    const { get } = await api(await filled());
    const r = (await get(`costs?breakdown=context&from=${addDays(TODAY, -6)}&to=${TODAY}`)).body as ReportReply;
    expect(r.total).toMatchObject({ sessions: 6, endedLow: 2, endedMid: 1, endedHigh: 2, endedUnknown: 1, endedHighPct: 40, cleared: 1 });
  });

  it('refuses a person or group filter, which these tables do not keep, and an unknown breakdown', async () => {
    const { get } = await api(await filled());
    expect((await get('costs?person=Maya')).status).toBe(400);
    expect((await get('costs?group=Platform')).status).toBe(400);
    expect((await get('costs?breakdown=nope')).status).toBe(400);
  });

  it('exports every breakdown to CSV with a harness column', async () => {
    const { get } = await api(await filled());
    for (const breakdown of ['model', 'tool', 'tokens', 'mix', 'context']) {
      const r = (await get(`costs?breakdown=${breakdown}&from=${addDays(TODAY, -6)}&to=${TODAY}`)).body as ReportReply;
      const csv = toCsv(r.columns, r.rows);
      expect(csv.split('\r\n')[0]).toContain('Harness');
      expect(csv.split('\r\n').length).toBeGreaterThan(2);
    }
  });
});
