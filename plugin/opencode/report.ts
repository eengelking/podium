// A Root as a v2 report (#855). Pure. The harness block, the capabilities and the session's `harness` come from here;
// everything shared (the report types, redaction, the plan) comes from core.
import { cap, clip, excerpt, LIMITS } from '../core/failures.ts';
import { feedOf, withinActivityBudget, withinDetailBudget, withinSize, withinTextBudget } from '../core/feed.ts';
import { lastSegment } from '../core/git.ts';
import { toPlan } from '../core/plan.ts';
import type { ActivityEvent, AgentReport, AgentStatus, Ask, Capabilities, ContextFill, MachineInfo, ModelUsage, Report, RespondInfo } from '../core/protocol.ts';
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
  /** The `sessionName` option: names a session OpenCode has not named (SPEC 6.6). */
  optionName?: string | null;
  machine?: MachineInfo | null;
  /** What the session takes from Podium and the asks open now; absent while answering is off (#858). */
  respond?: { info: RespondInfo; asks: Ask[] } | null;
  /** The context window of a model, once known. Absent or null: the percent is left out. */
  windowOf?: (provider: string | null, model: string | null) => number | null;
  /** The `PODIUM_FILE_DIFF` consent: the console may ask for one changed file's diff (#319). */
  fileDiff?: boolean;
  /** The `fileDiffPreload` option: with the consent, the console may ask for every changed file's diff while its page is open (#631). */
  fileDiffPreload?: boolean;
  /** The `PODIUM_ACTIVITY_FEED` consent: the feed of each loop the server says is watched goes out, and the report says the option is on (#118). */
  activity?: boolean;
  /** The `PODIUM_ACTIVITY_OUTPUT` consent: a shell call's output goes out with its entry, for a loop the server says a viewer has open (#431). */
  activityOutput?: boolean;
  /** The `PODIUM_FULL_PROMPTS` consent: each agent's whole prompt and answer go out, once. */
  fullText?: boolean;
  /** The `PODIUM_SESSION_RECORDING` consent, which the report states (#353). */
  sessionRecording?: boolean;
  /** The `PODIUM_PEERS` consent: this orchestrator may message the person's others (#347). Stated only when on, so a server that sees no `peers` from a reporter still knows it never offered. */
  peers?: boolean;
}

function pct(tokens: number | null, window: number | null): number | null {
  if (tokens === null || !window) return null;
  return Math.round(Math.min(100, (tokens / window) * 100) * 10) / 10;
}

function contextOf(s: Sess, meta: ReportMeta): ContextFill {
  const window = meta.windowOf?.(s.provider, s.model) ?? null;
  return { tokens: s.ctxTokens, window, percent: pct(s.ctxTokens, window) };
}

/** One row per model and tier, in a stable order, as the server takes them. */
function usageRows(...sets: Record<string, ModelUsage>[]): ModelUsage[] {
  const out = new Map<string, ModelUsage>();
  for (const set of sets) {
    for (const [key, row] of Object.entries(set)) {
      const was = out.get(key)?.tokens;
      out.set(key, { model: cap(row.model, 120), tier: row.tier, tokens: { input: (was?.input ?? 0) + row.tokens.input, output: (was?.output ?? 0) + row.tokens.output, cacheRead: (was?.cacheRead ?? 0) + row.tokens.cacheRead, cacheWrite: (was?.cacheWrite ?? 0) + row.tokens.cacheWrite, cacheWrite1h: 0 } });
    }
  }
  return [...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, r]) => r).slice(0, 40);
}

/** What this reporter sends before it is allowed to answer: it watches only. Effort is the model's variant and the window comes from the model list. */
export const CAPABILITIES: Capabilities = { effort: true, plan: true, agents: true, cost: true, context: true, git: true, respond: false, commands: [] };

/** The capabilities for what the session takes now: `respond` and `/compact` only when something can be answered (#858). OpenCode has no `/clear`. */
export function capabilities(info: RespondInfo | null): Capabilities {
  if (!info || !info.accepts.length) return { ...CAPABILITIES };
  return { ...CAPABILITIES, respond: true, commands: info.accepts.includes('command') ? ['compact'] : [] };
}

function agentStatus(s: Sess): AgentStatus {
  if (s.end === 'running') return s.executing ? 'running' : 'queued';
  return s.end;
}

function agentReport(s: Sess, rootId: string, meta: ReportMeta): AgentReport {
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
    effort: s.effort,
    effortSource: s.effort ? 'observed' : 'unknown',
    status: agentStatus(s),
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    context: contextOf(s, meta),
    tokens: { ...s.tokens },
    costUsdEst: s.costUsd,
    usageByModel: usageRows(s.usage),
    skills: [...s.skills],
    lastTool: s.lastTool,
    toolCalls: s.toolCalls,
    toolCounts: { ...s.toolCounts },
    blowouts: 0,
    steps: { done: s.steps, total: null },
    promptExcerpt: excerpt(s.prompt),
    answerExcerpt: s.answer ? excerpt(s.answer) : null,
    ...(meta.fullText && s.promptText && !s.promptSent ? { promptText: s.promptText } : {}),
    ...(meta.fullText && s.answerText && !s.answerSent ? { answerText: s.answerText } : {}),
    ...(meta.activity && s.activity.length ? { activity: feedOf(s.activity, meta.activityOutput === true) } : {}),
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
  const report: Report = {
    v: 2,
    sentAt: meta.now,
    harness: { id: HARNESS_ID, name: 'OpenCode', version: meta.engineVersion ?? 'unknown', surface: meta.hostSurface },
    capabilities: capabilities(meta.respond?.info ?? null),
    reporter: { name: 'podium-reporter-opencode', version: meta.version, engineVersion: meta.engineVersion, hostSurface: meta.hostSurface, ...(meta.build ? { build: meta.build } : {}) },
    ...(meta.userName && meta.userName.trim() ? { userName: clip(meta.userName.trim(), 80), ...(meta.machine ? { machine: { ...meta.machine } } : {}) } : {}),
    session: {
      id: root.id,
      name: clip(main.title || meta.optionName?.trim() || root.id, 80),
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
      effort: main.effort,
      context: contextOf(main, meta),
      costUsd: main.costUsd,
      harness: HARNESS_ID,
      costSource: 'harness',
      tokens: { ...main.tokens },
      usageByModel: usageRows(...[...root.sessions.values()].map((s) => s.usage)),
      rateLimits: [],
      blowouts: 0,
      plan: plan ? { ...plan, source: 'todowrite' } : null,
      loop: { skills: [...main.skills], lastTool: main.lastTool, toolCalls: main.toolCalls, toolCounts: { ...main.toolCounts }, steps: { done: main.steps, total: null } },
      files: root.files ? { ...root.files, files: root.files.files.map((f) => ({ ...f, path: clip(f.path, 300), from: f.from === null ? null : clip(f.from, 300) })) } : null,
      fileDiff: meta.fileDiff === true,
      fileDiffPreload: meta.fileDiff === true && meta.fileDiffPreload !== false,
      activityFeed: meta.activity === true,
      activityOutput: meta.activityOutput === true,
      sessionRecording: meta.sessionRecording === true,
      ...(meta.peers ? { peers: true } : {}),
      ...(meta.activity && main.activity.length ? { activity: feedOf(main.activity, meta.activityOutput === true) } : {}),
      attached: null,
      ...(meta.respond ? { respond: meta.respond.info, asks: meta.respond.asks } : {}),
    },
    agents: withinTextBudget(agents.map((s) => agentReport(s, root.id, meta))),
    events: events.slice(0, MAX_EVENTS).map((e) => ({ ...e, text: clip(e.text, 240) })),
  };
  withinDetailBudget(withinActivityBudget(report));
  withinSize(report);
  return report;
}
