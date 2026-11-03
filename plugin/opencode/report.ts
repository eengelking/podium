// A Root as a v2 report (#855). Pure. The harness block, the capabilities and the session's `harness` come from here;
// everything shared (the report types, redaction, the plan) comes from core.
import { clip, excerpt, LIMITS } from '../core/failures.ts';
import { lastSegment } from '../core/git.ts';
import { toPlan } from '../core/plan.ts';
import type { ActivityEvent, AgentReport, AgentStatus, Ask, Capabilities, MachineInfo, Report, RespondInfo } from '../core/protocol.ts';
import type { Root, Sess } from './state.ts';

export const HARNESS_ID = 'opencode';
const MAX_AGENTS = 200;
const MAX_EVENTS = 100;

export interface ReportMeta {
  now: number;
  /** This reporter's version. */
  version: string;
  /** The OpenCode version, as `session.created` reports it. */
  engineVersion: string | null;
  hostSurface: string | null;
  build?: string | null;
  userName?: string | null;
  machine?: MachineInfo | null;
  /** What the session takes from Podium and the asks open now; absent while answering is off (#858). */
  respond?: { info: RespondInfo; asks: Ask[] } | null;
}

/** What this reporter sends before it is allowed to answer: it watches only. Effort and the context window are not on the bus. */
export const CAPABILITIES: Capabilities = { effort: false, plan: true, agents: true, cost: true, context: false, git: true, respond: false, commands: [] };

/** The capabilities for what the session takes now: `respond` and `/compact` only when something can be answered (#858). OpenCode has no `/clear`. */
export function capabilities(info: RespondInfo | null): Capabilities {
  if (!info || !info.accepts.length) return { ...CAPABILITIES };
  return { ...CAPABILITIES, respond: true, commands: info.accepts.includes('command') ? ['compact'] : [] };
}

function agentStatus(s: Sess): AgentStatus {
  if (s.end === 'running') return s.executing ? 'running' : 'queued';
  return s.end;
}

function agentReport(s: Sess, rootId: string): AgentReport {
  const ctx = s.ctxTokens;
  return {
    id: s.id,
    // An agent the orchestrator launched has no parent, as in a Claude Code report.
    parentId: s.parentId === rootId ? null : s.parentId,
    kind: 'subagent',
    type: s.agent ?? 'subagent',
    name: s.title ? clip(s.title, 80) : null,
    description: excerpt(s.title ?? s.prompt, LIMITS.text),
    model: s.model,
    modelProvider: s.provider,
    effort: null,
    effortSource: 'unknown',
    status: agentStatus(s),
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    context: { tokens: ctx, window: null, percent: null },
    tokens: { ...s.tokens },
    costUsdEst: s.costUsd,
    skills: [],
    lastTool: s.lastTool,
    toolCalls: s.toolCalls,
    toolCounts: { ...s.toolCounts },
    blowouts: 0,
    steps: { done: s.steps, total: null },
    promptExcerpt: excerpt(s.prompt),
    answerExcerpt: s.answer ? excerpt(s.answer) : null,
    failure: s.failure,
  };
}

/** The root's own status: `waiting` for an open permission or question, and between turns, `running` while any session works. */
function status(root: Root): { status: 'running' | 'waiting' | 'done'; waitReason: 'permission' | 'input' | null; waitNote: string | null } {
  if (root.done) return { status: 'done', waitReason: null, waitNote: null };
  const asks = [...root.asks.values()];
  const first = asks.find((a) => a.kind === 'permission') ?? asks[0];
  if (first) return { status: 'waiting', waitReason: first.kind === 'permission' ? 'permission' : 'input', waitNote: first.note };
  const working = [...root.sessions.values()].some((s) => s.executing) || root.compacting;
  return working ? { status: 'running', waitReason: null, waitNote: null } : { status: 'waiting', waitReason: 'input', waitNote: null };
}

/** A full snapshot of the root plus the events given (at most 100). */
export function buildReport(root: Root, events: readonly ActivityEvent[], meta: ReportMeta): Report {
  const main = root.sessions.get(root.id)!;
  const st = status(root);
  const plan = toPlan(root.plan);
  const agents = root.children.map((id) => root.sessions.get(id)).filter((s): s is Sess => !!s).slice(-MAX_AGENTS);
  const cwd = root.cwd ?? '';
  return {
    v: 2,
    sentAt: meta.now,
    harness: { id: HARNESS_ID, name: 'OpenCode', version: meta.engineVersion ?? 'unknown', surface: meta.hostSurface },
    capabilities: capabilities(meta.respond?.info ?? null),
    reporter: { name: 'podium-reporter', version: meta.version, engineVersion: meta.engineVersion, hostSurface: meta.hostSurface, ...(meta.build ? { build: meta.build } : {}) },
    ...(meta.userName && meta.userName.trim() ? { userName: clip(meta.userName.trim(), 80), ...(meta.machine ? { machine: { ...meta.machine } } : {}) } : {}),
    session: {
      id: root.id,
      name: clip(main.title ?? root.id, 80),
      ...st,
      endReason: st.status === 'done' ? root.endReason : null,
      resumeId: null,
      startedAt: root.startedAt,
      cwd,
      projectRoot: cwd || null,
      repoName: cwd ? lastSegment(cwd) : null,
      git: root.git,
      model: main.model,
      modelProvider: main.provider,
      effort: null,
      context: { tokens: main.ctxTokens, window: null, percent: null },
      costUsd: main.costUsd,
      harness: HARNESS_ID,
      costSource: 'harness',
      tokens: { ...main.tokens },
      rateLimits: [],
      blowouts: 0,
      plan: plan ? { ...plan, source: 'todowrite' } : null,
      loop: { skills: [], lastTool: main.lastTool, toolCalls: main.toolCalls, toolCounts: { ...main.toolCounts }, steps: { done: main.steps, total: null } },
      files: null,
      attached: null,
      ...(meta.respond ? { respond: meta.respond.info, asks: meta.respond.asks } : {}),
    },
    agents: agents.map((s) => agentReport(s, root.id)),
    events: events.slice(0, MAX_EVENTS).map((e) => ({ ...e, text: clip(e.text, 240) })),
  };
}
