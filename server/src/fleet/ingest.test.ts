import { describe, it, expect, beforeEach } from 'vitest';
import { openSqliteStorage, type SqliteStorage } from '../storage/sqlite/index.js';
import { repriced } from './derive.js';
import { ingestReport } from './ingest.js';
import { Pricing } from './pricing.js';
import type { Report } from './protocol.js';
import { fixtureReport } from './testing.js';

let storage: SqliteStorage;
let f: SqliteStorage['fleet'];
beforeEach(() => {
  storage = openSqliteStorage(':memory:');
  f = storage.fleet;
});

const T0 = 1_791_648_000_000;

function withTokens(r: Report, input: number): Report {
  return { ...r, agents: [], session: { ...r.session, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 } } };
}

describe('ingestReport', () => {
  it('creates the session, its agents, events and blowout rows', async () => {
    const res = await ingestReport(storage, fixtureReport(), T0);
    expect(res.created).toBe(true);
    expect(res.newEvents).toHaveLength(3);
    const s = (await f.getSession(res.sessionId))!;
    expect(s.name).toBe('invoice-v2');
    expect((await f.getAgents(s.id)).map((a) => a.id).sort()).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(await f.countEvents(s.id)).toBe(3);
    const blows = await f.getBlowouts(s.id);
    expect(blows).toHaveLength(1);
    expect(blows[0]).toMatchObject({ agent_id: 'a4', kind: 'auto-compact', tokens_before: 1004000, tokens_after: 300000 });
  });

  it('stores the full prompt and answer apart from the agent, and keeps them when a later report leaves them out', async () => {
    const r = fixtureReport();
    r.agents[0]!.promptText = '# Task\n\nDo it.';
    await ingestReport(storage, r, T0);
    expect(await f.getAgentTexts(r.session.id, r.agents[0]!.id)).toEqual({ prompt: '# Task\n\nDo it.', answer: null });
    const later = fixtureReport();
    later.agents[0]!.answerText = '## Done';
    await ingestReport(storage, later, T0 + 1000);
    expect(await f.getAgentTexts(r.session.id, r.agents[0]!.id)).toEqual({ prompt: '# Task\n\nDo it.', answer: '## Done' });
    expect(await f.getAgentTexts(r.session.id, 'nope')).toBeNull();
    const rows = await f.getAgents(r.session.id);
    expect(rows.find((a) => a.id === r.agents[0]!.id)).toMatchObject({ prompt_chars: 14, answer_chars: 7 });
    expect(rows.find((a) => a.id === r.agents[1]!.id)).toMatchObject({ prompt_chars: null, answer_chars: null });
  });

  it('deleting the session deletes its texts', async () => {
    const r = fixtureReport();
    r.agents[0]!.promptText = 'x';
    await ingestReport(storage, r, T0);
    await f.deleteSession(r.session.id);
    expect(await f.getAgentTexts(r.session.id, r.agents[0]!.id)).toBeNull();
  });

  it('stores per-model usage for the session and each agent, and null for a reporter that sends none (#117)', async () => {
    const usage = [{ model: 'claude-sonnet-5-5', tier: 'std' as const, tokens: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cacheWrite1h: 1 } }];
    const r = fixtureReport();
    r.session.usageByModel = usage;
    r.agents[0]!.usageByModel = usage;
    delete r.agents[1]!.usageByModel;
    await ingestReport(storage, r, T0);
    expect(JSON.parse((await f.getSession(r.session.id))!.usage_json!)).toEqual(usage);
    const rows = await f.getAgents(r.session.id);
    expect(JSON.parse(rows.find((a) => a.id === r.agents[0]!.id)!.usage_json!)).toEqual(usage);
    expect(rows.find((a) => a.id === r.agents[1]!.id)!.usage_json).toBeNull();
  });

  it('stores the per-tool counts, and null for a reporter that sends none', async () => {
    const r = fixtureReport();
    delete (r.agents[1] as { toolCounts?: unknown }).toolCounts;
    await ingestReport(storage, r, T0);
    const rows = await f.getAgents(r.session.id);
    const json = (id: string) => rows.find((a) => a.id === id)!.tool_counts_json;
    expect(JSON.parse(json('a1')!)).toEqual({ Grep: 14, Read: 11, Glob: 6 });
    expect(json(r.agents[1]!.id)).toBeNull();
  });

  it('stores the main loop block, and null for a reporter that sends none', async () => {
    const r = fixtureReport();
    await ingestReport(storage, r, T0);
    expect(JSON.parse((await f.getSession(r.session.id))!.loop_json!)).toMatchObject({ toolCalls: 19, steps: { done: 23, total: null } });
    const old = fixtureReport();
    old.session.loop = null;
    await ingestReport(storage, old, T0 + 1000);
    expect((await f.getSession(old.session.id))!.loop_json).toBeNull();
  });

  it('stores the changed files, and null for a reporter that sends none', async () => {
    const r = fixtureReport();
    await ingestReport(storage, r, T0);
    expect(JSON.parse((await f.getSession(r.session.id))!.files_json!)).toMatchObject({ total: 4, added: 85, removed: 119, since: 'start' });
    const old = fixtureReport();
    old.session.files = null;
    await ingestReport(storage, old, T0 + 1000);
    expect((await f.getSession(old.session.id))!.files_json).toBeNull();
  });

  it('links a session to the one it continues after a /clear, and keeps the link when a later report leaves it out (#206)', async () => {
    const old = fixtureReport();
    await ingestReport(storage, { ...old, session: { ...old.session, status: 'done', endReason: 'clear' } }, T0);
    const next = { ...old, session: { ...old.session, id: 'after-clear', clearedFrom: old.session.id } };
    await ingestReport(storage, next, T0 + 1000);
    expect((await f.getSession('after-clear'))!.cleared_from).toBe(old.session.id);
    expect(await f.clearedInto(old.session.id)).toBe('after-clear');
    await ingestReport(storage, { ...old, session: { ...old.session, id: 'after-clear' } }, T0 + 2000);
    expect((await f.getSession('after-clear'))!.cleared_from).toBe(old.session.id);
    expect((await f.getSession(old.session.id))!.cleared_from).toBeNull();
    expect(await f.clearedInto('after-clear')).toBeNull();
  });

  it('is idempotent: a repeat changes only last_seen_at', async () => {
    const r = fixtureReport();
    await ingestReport(storage, r, T0);
    const before = { ...(await f.getSession(r.session.id))! };
    const agentsBefore = await f.getAgents(r.session.id);
    const res = await ingestReport(storage, r, T0 + 3000);
    expect(res.newEvents).toHaveLength(0);
    const after = (await f.getSession(r.session.id))!;
    expect(after.last_seen_at).toBe(T0 + 3000);
    expect({ ...after, last_seen_at: before.last_seen_at }).toEqual(before);
    expect(await f.getAgents(r.session.id)).toEqual(agentsBefore);
    expect(await f.countEvents()).toBe(3);
    expect(await f.countBlowouts()).toBe(1);
  });

  describe('start time (#43)', () => {
    const at = (r: Report, startedAt: number): Report => ({ ...r, session: { ...r.session, startedAt } });

    it('keeps the reported start when it is near the first sighting', async () => {
      const r = at(fixtureReport(), T0 - 30_000);
      await ingestReport(storage, r, T0);
      expect((await f.getSession(r.session.id))!.started_at).toBe(T0 - 30_000);
    });

    it('uses its own first-seen time when the report claims a start long before it was first seen', async () => {
      const r = at(fixtureReport(), T0 - 20 * 60_000);
      await ingestReport(storage, r, T0);
      expect((await f.getSession(r.session.id))!.started_at).toBe(T0);
    });

    it('does not let two sessions that report the same start share it', async () => {
      const a = at(fixtureReport(), T0 - 3_600_000);
      const b = { ...a, session: { ...a.session, id: 'other-session' } };
      await ingestReport(storage, a, T0);
      await ingestReport(storage, b, T0 + 5 * 60_000);
      expect((await f.getSession(a.session.id))!.started_at).toBe(T0);
      expect((await f.getSession('other-session'))!.started_at).toBe(T0 + 5 * 60_000);
    });

    it('uses its own first-seen time when the report claims a start in the future', async () => {
      const r = at(fixtureReport(), T0 + 20 * 60_000);
      await ingestReport(storage, r, T0);
      expect((await f.getSession(r.session.id))!.started_at).toBe(T0);
    });

    it('keeps the stored start when later reports change their claim', async () => {
      const r = at(fixtureReport(), T0 - 10_000);
      await ingestReport(storage, r, T0);
      await ingestReport(storage, at(r, T0 + 1_000), T0 + 3_000);
      expect((await f.getSession(r.session.id))!.started_at).toBe(T0 - 10_000);
    });
  });

  it('keeps an agent a later report omits, and aborts running agents when the session ends', async () => {
    const r = fixtureReport();
    await ingestReport(storage, r, T0);
    const later: Report = { ...r, agents: r.agents.filter((a) => a.id !== 'a2'), events: [] };
    await ingestReport(storage, later, T0 + 1000);
    expect((await f.getAgents(r.session.id)).find((a) => a.id === 'a2')?.status).toBe('running');
    const done: Report = { ...later, session: { ...later.session, status: 'done', endReason: 'other' } };
    await ingestReport(storage, done, T0 + 2000);
    const agents = await f.getAgents(r.session.id);
    expect(agents.find((a) => a.id === 'a2')).toMatchObject({ status: 'aborted', ended_at: T0 + 2000 });
    expect(agents.find((a) => a.id === 'a4')?.status).toBe('aborted');
    expect(agents.find((a) => a.id === 'a1')?.status).toBe('done');
    expect(agents.find((a) => a.id === 'a3')?.status).toBe('failed');
  });

  it('sets ended_at on done and clears it when the session reports running again', async () => {
    const r = fixtureReport();
    const done: Report = { ...r, session: { ...r.session, status: 'done' } };
    const res = await ingestReport(storage, done, T0);
    expect(res.ended).toBe(true);
    expect((await f.getSession(r.session.id))?.ended_at).toBe(T0);
    // a repeated done report keeps the first end time
    await ingestReport(storage, done, T0 + 5000);
    expect((await f.getSession(r.session.id))?.ended_at).toBe(T0);
    const back = await ingestReport(storage, r, T0 + 9000);
    expect(back.revived).toBe(true);
    expect(await f.getSession(r.session.id)).toMatchObject({ ended_at: null, status: 'running' });
  });

  it('revives a dropped session', async () => {
    const r = fixtureReport();
    await ingestReport(storage, r, T0);
    await f.setDropped(r.session.id, T0 + 80_000);
    const res = await ingestReport(storage, r, T0 + 90_000);
    expect(res.revived).toBe(true);
    expect((await f.getSession(r.session.id))?.dropped_at).toBeNull();
  });

  it('samples: deltas against the previous second, never negative, one row per second', async () => {
    const r = fixtureReport();
    await ingestReport(storage, withTokens(r, 1000), T0);
    await ingestReport(storage, withTokens(r, 4000), T0 + 1000);
    let rows = await f.samplesSince(r.session.id, 0);
    expect(rows.map((x) => [x.tokens_total, x.tokens_delta])).toEqual([[1000, 0], [4000, 3000]]);
    await ingestReport(storage, withTokens(r, 2000), T0 + 2000);
    rows = await f.samplesSince(r.session.id, 0);
    expect(rows[2]).toMatchObject({ tokens_total: 2000, tokens_delta: 0 });
    // two reports inside the same second leave one sample, recomputed against the second before
    await ingestReport(storage, withTokens(r, 5000), T0 + 3100);
    await ingestReport(storage, withTokens(r, 6000), T0 + 3900);
    rows = await f.samplesSince(r.session.id, 0);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({ tokens_total: 6000, tokens_delta: 4000 });
  });

  it('samples peak context over the session and running agents, and the running count', async () => {
    const r = fixtureReport();
    await ingestReport(storage, r, T0);
    const [s] = await f.samplesSince(r.session.id, 0);
    expect(s!.peak_context).toBeCloseTo(0.93);
    expect(s!.running_agents).toBe(2);
    expect(s!.cost_usd).toBe(12.84);
  });

  it('uses server time, not the reporter clock, for last_seen_at', async () => {
    const r = { ...fixtureReport(), sentAt: 42 };
    const res = await ingestReport(storage, r, T0);
    expect((await f.getSession(r.session.id))?.last_seen_at).toBe(T0);
    expect(res.clockSkewMs).toBe(42 - T0);
  });
});

describe('ingestReport with a cost the harness reported (#851)', () => {
  const harnessReport = (session: Partial<Report['session']> = {}): Report => {
    const r = fixtureReport();
    return {
      ...r,
      agents: [],
      session: {
        ...r.session,
        model: 'llama3.1:8b',
        harness: 'opencode',
        costSource: 'harness',
        costUsd: 0.42,
        tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
        ...session,
      },
    };
  };

  it('keeps the harness cost of a model Podium has no price for, and the harness it came from', async () => {
    const r = harnessReport();
    await ingestReport(storage, r, T0);
    expect(await f.getSession(r.session.id)).toMatchObject({ cost_usd: 0.42, harness: 'opencode', cost_source: 'harness' });
  });

  it('keeps an agent\'s cost when the session\'s cost is the harness\'s', async () => {
    const base = harnessReport();
    const r: Report = { ...base, agents: fixtureReport().agents.map((a) => ({ ...a, model: 'llama3.1:8b', costUsdEst: 0.1 })) };
    await ingestReport(storage, r, T0);
    expect((await f.getAgents(r.session.id)).every((a) => a.cost_usd_est === 0.1)).toBe(true);
  });

  it('keeps a reported cost of 0 as 0, labeled as the harness\'s figure', async () => {
    const r = harnessReport({ costUsd: 0 });
    await ingestReport(storage, r, T0);
    expect(await f.getSession(r.session.id)).toMatchObject({ cost_usd: 0, cost_source: 'harness' });
  });

  it('does not reprice a mixed session from its usage: the harness figure is the whole cost', async () => {
    const usage = [
      { model: 'claude-opus-4-5', tier: 'std' as const, tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } },
      { model: 'llama3.1:8b', tier: 'std' as const, tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } },
    ];
    const r = harnessReport({ costUsd: 1.1, usageByModel: usage });
    await ingestReport(storage, r, T0);
    const row = (await f.getSession(r.session.id))!;
    expect(row.usage_json).toBeNull();
    expect(repriced(new Pricing({}), row.usage_json, row.cost_usd)).toBe(1.1);
  });

  it('leaves a Claude Code report as it was: the Claude Code harness and Podium\'s own estimate', async () => {
    const r = fixtureReport();
    await ingestReport(storage, r, T0);
    expect(await f.getSession(r.session.id)).toMatchObject({ cost_usd: r.session.costUsd, harness: 'claude-code', cost_source: null });
  });

  it('still drops the estimate of a non-Claude model when the reporter does not say the harness reported it', async () => {
    const r = harnessReport({ costSource: 'estimate' });
    await ingestReport(storage, r, T0);
    expect(await f.getSession(r.session.id)).toMatchObject({ cost_usd: null, cost_source: null, harness: 'opencode' });
  });

  it('keeps the harness a later report leaves out', async () => {
    const r = harnessReport();
    await ingestReport(storage, r, T0);
    const later: Report = { ...r, session: { ...r.session, harness: undefined, costSource: undefined, costUsd: 0.5 } };
    await ingestReport(storage, later, T0 + 1000);
    expect((await f.getSession(r.session.id))!.harness).toBe('opencode');
  });
});

describe('ingestReport with a model that has no price (#66)', () => {
  it('drops a cost an older reporter priced as Sonnet, and keeps a Claude model\'s cost', async () => {
    const r = fixtureReport();
    const local: Report = {
      ...r,
      agents: r.agents.map((a) => ({ ...a, model: 'llama3.1:8b', costUsdEst: 0.4 })),
      session: { ...r.session, model: 'llama3.1:8b', costUsd: 3.2 },
    };
    await ingestReport(storage, local, T0);
    expect((await f.getSession(r.session.id))!.cost_usd).toBeNull();
    expect((await f.getAgents(r.session.id)).every((a) => a.cost_usd_est === null)).toBe(true);
    const storage2 = openSqliteStorage(':memory:');
    await ingestReport(storage2, r, T0);
    expect((await storage2.fleet.getSession(r.session.id))!.cost_usd).toBe(r.session.costUsd);
  });

  describe('plan finish order (#454)', () => {
    type St = 'pending' | 'active' | 'done' | 'blocked';
    const planOf = (states: Record<string, St>): Report => {
      const r = fixtureReport();
      r.session.plan = {
        title: null,
        source: 'TaskCreate',
        steps: Object.entries(states).map(([id, state]) => ({ id, text: id, state, activeText: null, ownerAgentId: null, ownerLabel: null })),
      };
      return r;
    };
    const seqs = async (): Promise<Record<string, number | undefined>> =>
      Object.fromEntries(
        (JSON.parse((await f.getSession(fixtureReport().session.id))!.plan_json!) as { steps: { id: string; doneSeq?: number }[] }).steps.map((x) => [x.id, x.doneSeq]),
      );

    it('numbers steps in the order they finish, and keeps the number while a step stays done', async () => {
      await ingestReport(storage, planOf({ a: 'active', b: 'pending', c: 'pending' }), T0);
      expect(await seqs()).toEqual({ a: undefined, b: undefined, c: undefined });
      await ingestReport(storage, planOf({ a: 'pending', b: 'pending', c: 'done' }), T0 + 1000);
      await ingestReport(storage, planOf({ a: 'done', b: 'pending', c: 'done' }), T0 + 2000);
      expect(await seqs()).toEqual({ a: 2, b: undefined, c: 1 });
      await ingestReport(storage, planOf({ a: 'done', b: 'active', c: 'done' }), T0 + 3000);
      expect(await seqs()).toEqual({ a: 2, b: undefined, c: 1 });
    });

    it('numbers steps that finish in one report in plan order', async () => {
      await ingestReport(storage, planOf({ a: 'active', b: 'active' }), T0);
      await ingestReport(storage, planOf({ a: 'done', b: 'done' }), T0 + 1000);
      expect(await seqs()).toEqual({ a: 1, b: 2 });
    });

    it('drops the number when a step is reopened, and gives it a new one when it finishes again', async () => {
      await ingestReport(storage, planOf({ a: 'active', b: 'pending' }), T0);
      await ingestReport(storage, planOf({ a: 'done', b: 'active' }), T0 + 1000);
      await ingestReport(storage, planOf({ a: 'pending', b: 'done' }), T0 + 2000);
      expect(await seqs()).toEqual({ a: undefined, b: 2 });
      await ingestReport(storage, planOf({ a: 'done', b: 'done' }), T0 + 3000);
      expect(await seqs()).toEqual({ a: 3, b: 2 });
    });

    it('leaves steps of a plan first seen already part done without a number', async () => {
      await ingestReport(storage, planOf({ a: 'done', b: 'done', c: 'active' }), T0);
      expect(await seqs()).toEqual({ a: undefined, b: undefined, c: undefined });
      await ingestReport(storage, planOf({ a: 'done', b: 'done', c: 'done' }), T0 + 1000);
      expect(await seqs()).toEqual({ a: undefined, b: undefined, c: 1 });
    });

    it('keeps the finish order across a report with no plan (#465)', async () => {
      await ingestReport(storage, planOf({ '1': 'active', '2': 'active', '3': 'pending' }), T0);
      await ingestReport(storage, planOf({ '1': 'done', '2': 'active', '3': 'pending' }), T0 + 1000);
      await ingestReport(storage, planOf({ '1': 'done', '2': 'done', '3': 'pending' }), T0 + 2000);
      const none = fixtureReport();
      none.session.plan = null;
      await ingestReport(storage, none, T0 + 3000);
      await ingestReport(storage, none, T0 + 3500);
      await ingestReport(storage, planOf({ '1': 'done', '2': 'done', '3': 'done' }), T0 + 4000);
      expect(await seqs()).toEqual({ '1': 1, '2': 2, '3': 3 });
    });

    it('starts over when the plan is replaced by one that reuses the step ids (#465)', async () => {
      const renamed = (states: Record<string, St>): Report => {
        const r = planOf(states);
        for (const x of r.session.plan!.steps) x.text = `new ${x.id}`;
        return r;
      };
      await ingestReport(storage, planOf({ a: 'active', b: 'pending', c: 'pending' }), T0);
      await ingestReport(storage, planOf({ a: 'done', b: 'done', c: 'pending' }), T0 + 1000);
      expect(await seqs()).toEqual({ a: 1, b: 2, c: undefined });
      await ingestReport(storage, renamed({ a: 'done', b: 'pending', c: 'pending' }), T0 + 2000);
      expect(await seqs()).toEqual({ a: undefined, b: undefined, c: undefined });
      await ingestReport(storage, renamed({ a: 'done', b: 'pending', c: 'done' }), T0 + 3000);
      await ingestReport(storage, renamed({ a: 'done', b: 'done', c: 'done' }), T0 + 4000);
      expect(await seqs()).toEqual({ a: undefined, b: 2, c: 1 });
    });

    it('treats a plan with a different title or source as another plan (#465)', async () => {
      await ingestReport(storage, planOf({ a: 'active', b: 'pending' }), T0);
      await ingestReport(storage, planOf({ a: 'done', b: 'pending' }), T0 + 1000);
      const titled = planOf({ a: 'done', b: 'done' });
      titled.session.plan!.title = 'Another plan';
      await ingestReport(storage, titled, T0 + 2000);
      expect(await seqs()).toEqual({ a: undefined, b: undefined });
    });

    it('starts over when a report carries a different plan or none', async () => {
      await ingestReport(storage, planOf({ a: 'active' }), T0);
      await ingestReport(storage, planOf({ a: 'done' }), T0 + 1000);
      const none = fixtureReport();
      none.session.plan = null;
      await ingestReport(storage, none, T0 + 2000);
      expect((await f.getSession(none.session.id))!.plan_json).toBeNull();
    });
  });
});
