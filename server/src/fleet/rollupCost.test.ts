// What sessions cost and how they ended in the daily rollups (#723): cost and calls by harness, model and effort, the token split, how full the context
// was at the end, sessions that compacted or continued after /clear, and the sessions that called each tool. Counts, tokens and names only.
import { describe, it, expect } from 'vitest';
import { addDays, buildRollups, contextEnd, costFn, dayStart, writeRollups } from './rollups.js';
import { DAY_MS, NOW, TODAY, agent, at, session, world } from '../storage/sqlite/rollupFixtures.js';

const counts = (o: Record<string, number>): string => JSON.stringify(o);
const DAY = addDays(TODAY, -2);

async function populate(w: ReturnType<typeof world>): Promise<void> {
  const add = (s: Parameters<typeof session>[0]) => w.fdb.upsertSession(session(s));
  // Claude Code on opus: a priced session that ended nearly full and compacted on its own, and one that ended half full.
  await add({ id: 'c1', model: 'opus', effort: 'high', last_seen_at: at(2, 11), started_at: at(2, 9), harness: 'claude-code', cost_usd: 4, context_percent: 91, tok_in: 100, tok_out: 20, tok_cr: 300, tok_cw: 50 });
  await add({ id: 'c2', model: 'opus', effort: 'high', last_seen_at: at(2, 12), started_at: at(2, 9), harness: 'claude-code', cost_usd: 2, context_percent: 50, tok_in: 10, tok_out: 5, tok_cr: 30, tok_cw: 5 });
  // a session that continued after /clear, on a model with no price, with no context size
  await add({ id: 'c3', model: 'mystery', effort: null, last_seen_at: at(2, 13), started_at: at(2, 9), harness: 'claude-code', cost_usd: null, context_percent: null, cleared_from: 'c1', tok_in: 7, tok_out: 1, tok_cr: 0, tok_cw: 0 });
  await add({ id: 'o1', model: 'opus', effort: 'high', last_seen_at: at(2, 14), started_at: at(2, 9), harness: 'opencode', cost_usd: 1, context_percent: 49.9, tok_in: 1, tok_out: 1, tok_cr: 1, tok_cw: 0 });
  await w.fdb.upsertAgent(agent('c1', 'a1', { tool_counts_json: counts({ Bash: 3, Edit: 1 }) }));
  await w.fdb.upsertAgent(agent('c2', 'a2', { tool_counts_json: counts({ Bash: 2 }) }));
  await w.fdb.upsertAgent(agent('c3', 'a3', { tool_counts_json: counts({ Bash: 5 }) }));
  await w.fdb.upsertAgent(agent('o1', 'a4', { tool_counts_json: counts({ Bash: 4 }) }));
  // one automatic compaction and one by hand: only the automatic one counts
  await w.fdb.insertEvent({ id: 'e1', session_id: 'c1', agent_id: null, t: at(2, 10), kind: 'compact', text: '', data_json: JSON.stringify({ trigger: 'auto' }) });
  await w.fdb.insertEvent({ id: 'e2', session_id: 'c2', agent_id: null, t: at(2, 10), kind: 'compact', text: '', data_json: JSON.stringify({ trigger: 'manual' }) });
}

describe('contextEnd', () => {
  it('is low under 50, mid from 50 to 80 and high above 80, and unknown with no number', () => {
    expect([null, Number.NaN, 0, 49.9, 50, 80, 80.1, 100].map(contextEnd)).toEqual(['unknown', 'unknown', 'low', 'low', 'mid', 'mid', 'high', 'high']);
  });
});

describe('buildRollups cost', () => {
  it('adds up sessions, calls, priced cost, tokens, context at the end, compactions and clears per harness, model and effort', async () => {
    const w = world();
    await populate(w);
    const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
    const rows = b.costDays.filter((r) => r.day === DAY).map((r) => ({ ...r, day: '' })).sort((a, c) => `${a.harness}/${a.model}`.localeCompare(`${c.harness}/${c.model}`));
    expect(rows).toEqual([
      { day: '', harness: 'claude-code', model: 'mystery', effort: '', sessions: 1, pricedSessions: 0, calls: 5, pricedCalls: 0, costUsd: 0, callCostUsd: 0, tokIn: 7, tokOut: 1, tokCr: 0, tokCw: 0, endedLow: 0, endedMid: 0, endedHigh: 0, endedUnknown: 1, compacted: 0, cleared: 1 },
      { day: '', harness: 'claude-code', model: 'opus', effort: 'high', sessions: 2, pricedSessions: 2, calls: 6, pricedCalls: 6, costUsd: 6, callCostUsd: 6, tokIn: 110, tokOut: 25, tokCr: 330, tokCw: 55, endedLow: 0, endedMid: 1, endedHigh: 1, endedUnknown: 0, compacted: 1, cleared: 0 },
      { day: '', harness: 'opencode', model: 'opus', effort: 'high', sessions: 1, pricedSessions: 1, calls: 4, pricedCalls: 4, costUsd: 1, callCostUsd: 1, tokIn: 1, tokOut: 1, tokCr: 1, tokCw: 0, endedLow: 1, endedMid: 0, endedHigh: 0, endedUnknown: 0, compacted: 0, cleared: 0 },
    ]);
  });

  it('counts the sessions that called each tool with what they cost, and leaves an unpriced session out of the cost', async () => {
    const w = world();
    await populate(w);
    const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
    const rows = b.toolCosts.filter((r) => r.day === DAY).map((r) => `${r.harness}/${r.tool}: ${r.sessions} sessions, ${r.pricedSessions} priced, $${r.costUsd}, ${r.calls} calls`).sort();
    expect(rows).toEqual([
      'claude-code/Bash: 3 sessions, 2 priced, $6, 10 calls',
      'claude-code/Edit: 1 sessions, 1 priced, $4, 1 calls',
      'opencode/Bash: 1 sessions, 1 priced, $1, 4 calls',
    ]);
  });

  it('keeps a priced session with no tool counts out of the cost per call: its spend is in the total and not in the spend that stands behind the calls', async () => {
    const w = world();
    await populate(w);
    // stored before tool counts were kept: no agent holds any, so it is not a session of zero calls
    await w.fdb.upsertSession(session({ id: 'old', model: 'opus', effort: 'high', last_seen_at: at(2, 15), started_at: at(2, 9), harness: 'claude-code', cost_usd: 10 }));
    const b = await buildRollups(w.fdb, costFn(w.deps.pricing()), dayStart(addDays(TODAY, -5)));
    const row = b.costDays.find((r) => r.day === DAY && r.harness === 'claude-code' && r.model === 'opus')!;
    expect(row).toMatchObject({ sessions: 3, pricedSessions: 3, costUsd: 16, callCostUsd: 6, calls: 6, pricedCalls: 6 });
  });

  it('writes them, and a second run gives the same rows', async () => {
    const w = world();
    await populate(w);
    const policy = { sessionsMs: 30 * DAY_MS };
    await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), policy);
    const first = [await w.fdb.rollupRows('cost_daily', addDays(TODAY, -5), TODAY), await w.fdb.rollupRows('tool_cost_daily', addDays(TODAY, -5), TODAY)];
    expect(first[0]).toHaveLength(3);
    expect(first[1]).toHaveLength(3);
    await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), policy);
    expect([await w.fdb.rollupRows('cost_daily', addDays(TODAY, -5), TODAY), await w.fdb.rollupRows('tool_cost_daily', addDays(TODAY, -5), TODAY)]).toEqual(first);
  });
});
