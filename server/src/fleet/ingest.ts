// Report -> rows, events, blowouts and samples (SPEC 7.3 steps 1-4). One transaction per report.
import type { AgentReport, Plan, PlanStepView, PlanView, Report, TokenCounts } from './protocol.js';
import { SAME_USAGE, type AgentRow, type EventRow, type SampleRow, type SessionRow } from '../storage/rows.js';
import type { Storage } from '../storage/types.js';
import { family } from './derive.js';

// An older reporter prices a non-Claude model as Sonnet; Podium has no price for it, so drop the figure. A non-Claude model has no ledger price, and a loop that has not reported a model yet has no spend worth showing
// as $0.00: both stay unknown (null) here. The Admin's prices apply on read, from the usage (issue #117).
// A cost the harness reported is kept as it came, for any model and including 0, which can be a subscription plan rather than free (#851): Podium's
// price table applies only to the models it knows.
const priced = (model: string | null, usd: number | null, harnessCost = false): number | null =>
  harnessCost ? usd : model ? (family(model) === 'other' ? null : usd) : usd || null;

export interface IngestResult {
  sessionId: string;
  /** Events this report added (already-stored ids are skipped). */
  newEvents: EventRow[];
  /** The report carried status 'done'. */
  ended: boolean;
  /** The session had ended or been dropped and reports as live again. */
  revived: boolean;
  /** The session was not stored before this report. */
  created: boolean;
  /** The stored session had already ended (status 'done') before this report. */
  wasDone: boolean;
  /** sentAt − serverTime, kept for debugging only. */
  clockSkewMs: number;
}

export function tokenSum(t: TokenCounts | { tok_in: number; tok_out: number; tok_cr: number; tok_cw: number }): number {
  if ('input' in t) return t.input + t.output + t.cacheRead + t.cacheWrite;
  return t.tok_in + t.tok_out + t.tok_cr + t.tok_cw;
}

function json(v: unknown): string | null {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

/** How far a reported start may sit from the moment the server first heard of the session before it is not believed. */
export const START_TOLERANCE_MS = 2 * 60_000;

/**
 * A session's start time. Once stored it never changes. On the first report the reporter's claim is kept when it is
 * close to the first sighting; otherwise (#43: the engine can hand every session under its background daemon one
 * shared host-level value) the session started when the server first heard of it.
 */
function startedAt(claimed: number, prev: SessionRow | undefined, serverTime: number): number {
  if (prev) return prev.started_at;
  return Math.abs(claimed - serverTime) <= START_TOLERANCE_MS ? claimed : serverTime;
}

/** Two plans are the same plan when they share a source and title and agree on the text of every step id they have in common (#465). */
function samePlan(a: PlanView, b: Plan): boolean {
  if (a.source !== b.source || a.title !== b.title) return false;
  const texts = new Map(a.steps.map((x) => [x.id, x.text]));
  const shared = b.steps.filter((x) => texts.has(x.id));
  return shared.length > 0 && shared.every((x) => texts.get(x.id) === x.text);
}

/**
 * Numbers the steps in the order the server saw them finish (#454), so the Plan list can end with the done steps in that order.
 * A step keeps its number while it stays done and loses it when reopened. Steps already done in the first plan seen get none.
 * `prevJson` is the last plan stored for the session; a different plan (see `samePlan`) starts over (#465).
 */
function stampDoneOrder(plan: Plan | null, prevJson: string | null | undefined): PlanView | null {
  if (!plan || !plan.steps.some((x) => x.state === 'done')) return plan;
  let before: PlanView | null = null;
  try {
    before = prevJson ? (JSON.parse(prevJson) as PlanView) : null;
  } catch {
    before = null;
  }
  if (before && !samePlan(before, plan)) before = null;
  const seen = new Map((before?.steps ?? []).map((x) => [x.id, x]));
  let next = Math.max(0, ...(before?.steps ?? []).map((x) => x.doneSeq ?? 0)) + 1;
  // A reporter's plan never carries doneSeq (the parser keeps only the wire fields), so x is copied as it came.
  const steps = plan.steps.map((x: PlanStepView) => {
    if (x.state !== 'done' || !before) return x;
    const old = seen.get(x.id);
    if (old?.state === 'done') return old.doneSeq === undefined ? x : { ...x, doneSeq: old.doneSeq };
    return { ...x, doneSeq: next++ };
  });
  return { ...plan, steps };
}

/** Whether the session's cost is the harness's own figure: what this report says, else what the last one said. */
function harnessCost(s: Report['session'], prev: SessionRow | undefined): boolean {
  return s.costSource ? s.costSource === 'harness' : prev?.cost_source === 'harness';
}

function sessionRow(r: Report, prev: SessionRow | undefined, serverTime: number, owner: string | null): SessionRow {
  const s = r.session;
  const done = s.status === 'done';
  const fromHarness = harnessCost(s, prev);
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    wait_reason: s.waitReason,
    wait_note: s.waitNote,
    end_reason: s.endReason,
    resume_id: s.resumeId,
    started_at: startedAt(s.startedAt, prev, serverTime),
    last_seen_at: serverTime,
    ended_at: done ? (prev?.status === 'done' && prev.ended_at !== null ? prev.ended_at : serverTime) : null,
    dropped_at: null,
    cwd: s.cwd,
    project_root: s.projectRoot,
    repo_name: s.repoName,
    git_json: json(s.git),
    model: s.model,
    effort: s.effort,
    context_tokens: s.context.tokens,
    context_window: s.context.window,
    context_percent: s.context.percent,
    cost_usd: priced(s.model, s.costUsd, fromHarness),
    tok_in: s.tokens.input,
    tok_out: s.tokens.output,
    tok_cr: s.tokens.cacheRead,
    tok_cw: s.tokens.cacheWrite,
    rate_limits_json: json(s.rateLimits),
    blowouts: s.blowouts,
    plan_json: json(stampDoneOrder(s.plan, prev?.plan_json ?? prev?.plan_kept_json)),
    // While a report carries no plan, the last one is kept here so the finish order survives the gap (#465).
    plan_kept_json: s.plan ? null : prev?.plan_json ?? prev?.plan_kept_json ?? null,
    reporter_version: r.reporter.version,
    reporter_build: r.reporter.build ?? null,
    engine_version: r.reporter.engineVersion,
    loop_json: json(s.loop),
    files_json: json(s.files),
    background_json: json(s.background ?? null),
    // The harness's figure is the whole cost, so no usage is kept to reprice it from (a mixed session would lose the share of a model Podium has no price for).
    usage_json: fromHarness ? null : json(s.usageByModel ?? null),
    attached: s.attached == null ? null : s.attached ? 1 : 0,
    // The clock starts at the first report with nobody attached and keeps running while that stays true.
    detached_at: s.attached === false ? (prev?.attached === 0 && prev.detached_at !== null ? prev.detached_at : serverTime) : null,
    owner: owner ?? prev?.owner ?? null,
    // A settings hook carries no machine, so a session keeps the one its reporter last sent.
    machine_json: r.machine ? JSON.stringify(r.machine) : prev?.machine_json ?? null,
    // Set once: a later report that leaves it out (an older reporter, a hook) keeps the link.
    cleared_from: s.clearedFrom ?? prev?.cleared_from ?? null,
    // Set by the first report that names them; a later one that leaves them out (a hook) keeps them.
    harness: s.harness ?? prev?.harness ?? 'claude-code',
    cost_source: fromHarness ? 'harness' : null,
  };
}

function agentRow(sessionId: string, a: AgentReport, fromHarness: boolean): AgentRow {
  return {
    session_id: sessionId,
    id: a.id,
    parent_id: a.parentId,
    kind: a.kind,
    type: a.type,
    name: a.name,
    description: a.description,
    model: a.model,
    effort: a.effort,
    effort_source: a.effortSource,
    status: a.status,
    started_at: a.startedAt,
    ended_at: a.endedAt,
    context_tokens: a.context.tokens,
    context_window: a.context.window,
    context_percent: a.context.percent,
    tok_in: a.tokens.input,
    tok_out: a.tokens.output,
    tok_cr: a.tokens.cacheRead,
    tok_cw: a.tokens.cacheWrite,
    cost_usd_est: priced(a.model, a.costUsdEst, fromHarness),
    skills_json: JSON.stringify(a.skills),
    last_tool: a.lastTool,
    tool_calls: a.toolCalls,
    tool_counts_json: a.toolCounts ? JSON.stringify(a.toolCounts) : null,
    usage_json: fromHarness ? null : json(a.usageByModel ?? null),
    blowouts: a.blowouts,
    steps_done: a.steps ? a.steps.done : null,
    steps_total: a.steps ? a.steps.total : null,
    prompt_excerpt: a.promptExcerpt,
    answer_excerpt: a.answerExcerpt,
    failure_json: json(a.failure),
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/** A session already belongs to someone else: the token's owner may not take it over. */
export class OwnerConflict extends Error {}

/**
 * Stores one validated report. `serverTime` (never the reporter's clock) sets last_seen_at.
 * `owner` is the name the server decided from the token; null (auth off) leaves a stored owner alone.
 */
export function ingestReport(storage: Storage, report: Report, serverTime: number, owner: string | null = null): Promise<IngestResult> {
  const f = storage.fleet;
  return storage.tx(async () => {
    const sid = report.session.id;
    const prev = await f.getSession(sid);
    if (owner !== null && prev?.owner && prev.owner !== owner) throw new OwnerConflict('session belongs to another owner');
    const row = sessionRow(report, prev, serverTime, owner);
    await f.upsertSession(row);
    const ended = report.session.status === 'done';
    const revived = !!prev && !ended && (prev.ended_at !== null || prev.dropped_at !== null);

    // 2. Agents: upsert what was reported; never delete one that is missing (a reload may lose it).
    for (const a of report.agents) {
      await f.upsertAgent(agentRow(sid, a, row.cost_source === 'harness'));
      if (a.promptText || a.answerText) {
        await f.upsertAgentTexts(sid, a.id, {
          ...(a.promptText ? { prompt: a.promptText } : {}),
          ...(a.answerText ? { answer: a.answerText } : {}),
        });
      }
    }
    if (ended) await f.abortOpenAgents(sid, serverTime);

    // 3. Events, idempotent by id. A blow event that is new adds a blowouts row.
    const newEvents: EventRow[] = [];
    for (const e of report.events) {
      const ev: EventRow = {
        id: e.id,
        session_id: sid,
        agent_id: e.agentId,
        t: e.t,
        kind: e.kind,
        text: e.text,
        data_json: json(e.data),
      };
      if (!(await f.insertEvent(ev))) continue;
      newEvents.push(ev);
      const kind = e.data && typeof e.data.kind === 'string' ? e.data.kind : null;
      if (e.kind === 'blow' && kind) {
        await f.insertBlowout({
          session_id: sid,
          agent_id: e.agentId,
          t: e.t,
          kind: kind.slice(0, 40),
          tokens_before: numOrNull(e.data?.tokensBefore),
          tokens_after: numOrNull(e.data?.tokensAfter),
        });
      }
    }

    // 4. Sample for this second: totals over every stored agent, delta against the previous second.
    const agents = await f.getAgents(sid);
    const tokensTotal = tokenSum(row) + agents.reduce((n, a) => n + tokenSum(a), 0);
    const second = Math.floor(serverTime / 1000);
    const before = await f.sampleBefore(sid, second);
    const running = agents.filter((a) => a.status === 'running');
    const peakPct = Math.max(row.context_percent ?? 0, ...running.map((a) => a.context_percent ?? 0));
    await f.upsertSample({
      session_id: sid,
      t: second,
      tokens_total: tokensTotal,
      tokens_delta: before ? Math.max(0, tokensTotal - before.tokens_total) : 0,
      peak_context: Math.max(0, Math.min(1, peakPct / 100)),
      running_agents: ended ? 0 : running.length,
      cost_usd: row.cost_usd,
      usage_json: sampleUsage(row.usage_json, prev?.usage_json, before, second),
    });

    return { sessionId: sid, newEvents, ended, revived, created: !prev, wasDone: prev?.status === 'done', clockSkewMs: report.sentAt - serverTime };
  });
}

/**
 * What a sample stores of the session's usage (issue #270). A sample keeps it only when it changed since the last
 * report or when it is the first sample of its minute, so a chart priced from samples finds a value at the start of every
 * minute; the rest store `=`, "as the sample before". NULL stays NULL (no usage sent).
 */
function sampleUsage(usage: string | null, previous: string | null | undefined, before: SampleRow | undefined, second: number): string | null {
  if (usage === null) return null;
  const sameMinute = before !== undefined && Math.floor(before.t / 60) === Math.floor(second / 60);
  return sameMinute && previous === usage ? SAME_USAGE : usage;
}
