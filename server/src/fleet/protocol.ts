// Podium wire protocol: the Report the reporter mod POSTs (SPEC 6.2), the view types the server
// sends to the UI (SPEC 7.4), and a hand-written validator that enforces the limits in SPEC 7.7.
// The Report types, limits and helpers themselves are in plugin/core/protocol.ts, the one copy the server,
// the UI and the reporters share; this file re-exports them so the server's imports stay as they were.

import { parseBuild } from './parseBuild.js';
import { CAPABILITY_KEYS, KnownEffort, ReportVersion, Capabilities, HarnessInfo, PEER_DROP_WORDS, acceptsFor, ActivityEntry, ActivityEvent, ActivityKind, AgentReport, AgentStatus, Ask, AskClose, AskCloseOutcome, AskKind, AskOption, AskQuestion, BackgroundKind, backgroundSummary, BackgroundTask, BackgroundWait, ChangedFile, ContextFill, CostSource, Delivery, DELIVERY_KINDS, DELIVERY_RESULTS, DeliveryKind, DeliveryResult, DiffRequest, Effort, EventKind, Failure, FailureClass, FILE_DIFF_STATUSES, FileDiffReply, FileDiffStatus, FilesReport, FileStatus, GitInfo, idleOnBackground, LEVEL_KINDS, LoopReport, MachineInfo, MAIN_LOOP, ModelUsage, PEER_ANSWERS, PEER_LEVELS, PEER_LIMITS, PEER_RESULTS, PeerAnswer, PeerDelivery, PeerLevel, PeerParty, PeerRequest, PeerRequestKind, PeerResult, Plan, PLAN_MODES, PlanMode, PlanStep, PODIUM_COMMANDS, PodiumCommand, QuestionAnswer, RateLimit, RECORDING_DEFAULTS, RECORDING_KINDS, RECORDING_LIMITS, RECORDING_RANGES, RECORDING_STATES, RecordingAdminRow, RecordingBatch, RecordingBatchReply, RecordingConsent, RecordingEntry, RecordingGrant, RecordingKind, RecordingLimit, RecordingLoopInfo, RecordingPage, RecordingRow, RecordingSettings, RecordingStartRequest, RecordingState, RecordingView, Report, ReportReply, RESPOND_KINDS, RESPOND_LEVELS, RESPOND_LIMIT_NAMES, RESPOND_LIMITS, RespondInfo, RespondKind, RespondLevel, RespondLimit, SessionReport, TokenCounts, UsageTokens } from '../../../plugin/core/protocol.js';
export * from '../../../plugin/core/protocol.js';

/** A plan step as the server stores and serves it. `doneSeq` is added by the server (#454), never sent by a reporter: 1 for the first step seen to finish, 2 for the next. Absent on a step not done, or done when the plan was first seen. */
export interface PlanStepView extends PlanStep {
  doneSeq?: number;
}

export interface PlanView extends Omit<Plan, 'steps'> {
  steps: PlanStepView[];
}

/** Limits for a file's diff on request (#319, SPEC 6.4). The mod keeps its own copy of the ones it uses, in hooks/fileDiff.ts. */
export const FILE_DIFF_LIMITS = {
  /** Lines and bytes the mod sends; more is cut at a line boundary. */
  lines: 2000,
  bytes: 200_000,
  /** Bytes of `git diff` the mod reads before it answers `too-large`. */
  readBytes: 5_000_000,
  /** The most the server takes in an answer. */
  answerBytes: 300_000,
  /** How long the server holds the browser's request, and the most requests it lists in one reply. */
  holdSeconds: 15,
  pending: 4,
} as const;

/** USD per million tokens for one model (issue #117). `cacheWrite` is the 5-minute rate, `cacheWrite1h` the 1-hour rate. */
export interface ModelPriceSet {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

/** One row of Admin > Settings > Model prices: the price in force, and the built-in one it can be reset to. */
export interface ModelPriceRow {
  /** The key the row is saved under: a built-in row's key, or an Admin-added model id. */
  key: string;
  label: string;
  /** A row Podium ships a price for; an Admin-added model id is not. */
  builtin: boolean;
  /** The Admin changed something on this row. */
  overridden: boolean;
  std: ModelPriceSet;
  /** Prices for a prompt over 100,000 tokens; only some models have a second set. */
  long?: ModelPriceSet;
  builtinStd?: ModelPriceSet;
  builtinLong?: ModelPriceSet;
}

export interface ModelPricesView {
  /** The date the built-in table was taken from Anthropic's pricing sheet. */
  asOf: string;
  models: ModelPriceRow[];
}

// ---------------------------------------------------------------------------------------------
// View types (server -> UI). The UI imports these with `import type`.
// ---------------------------------------------------------------------------------------------

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other';

export type SessionStatusView = 'running' | 'waiting' | 'stale' | 'done';

export interface AgentView extends Omit<AgentReport, 'promptText' | 'answerText' | 'activity'> {
  modelFamily: ModelFamily;
  /** Length of the full prompt / answer the server holds, null when it has none (served by the text endpoint). */
  promptChars: number | null;
  answerChars: number | null;
}

export interface BlowoutLogEntry {
  t: number;
  agentId: string | null;
  kind: string;
  tokensBefore: number | null;
  tokensAfter: number | null;
}

/** `outdated`: below the supported range, update the mod. `newer`: above it, upgrade the server. `unknown`: unreadable, no warning. */
export type ReporterCompat = 'ok' | 'outdated' | 'newer' | 'unknown';

/** The versions of one reporter a server reads correctly (major.minor compared; patch ignored). The server holds one range per reporter name (#852). */
export interface ReporterSupport {
  min: string;
  max: string;
}

export interface SessionView {
  id: string;
  name: string;
  /** `mod`: the reporter mod (full detail); `hooks`: classic settings hooks only (no usage, cost, plan). */
  reporter: 'mod' | 'hooks';
  /** The mod's version as it reported it; null for a hooks-only session, which has no mod. */
  reporterVersion: string | null;
  /** The commit hash of a dev build of the mod (#400); null for a release, a hooks-only session and a mod that does not send one. */
  reporterBuild: string | null;
  /** The reporter that sent it (`podium-reporter` for Claude Code), which the version warning names (#852). */
  reporterName: string;
  /** How that version sits against that reporter's own range on this server. Always `unknown` for hooks. */
  compat: ReporterCompat;
  project: string;
  /** The session's working directory, home shortened to `~`. */
  cwd: string;
  repoName: string | null;
  /** The command that continues the session in a terminal, from the harness's template; null when the harness has none (#853). */
  resumeCommand: string | null;
  /** The command that starts a copy of the conversation in a new session (#352); null when the harness has none (#853). */
  forkCommand: string | null;
  git: GitInfo | null;
  model: string | null;
  modelFamily: ModelFamily;
  effort: string | null;
  status: SessionStatusView;
  waitReason: 'permission' | 'input' | null;
  waitNote: string | null;
  endReason: string | null;
  startedAt: number;
  lastSeenAt: number;
  secondsSinceSeen: number;
  /** When a heartbeat-lost session leaves the wall on its own (epoch ms); null while it is not stale. */
  dropAt: number | null;
  context: ContextFill;
  costUsd: number | null;
  tokensTotal: number;
  blowouts: {
    orchestrator: number;
    agents: number;
    total: number;
    level: 0 | 1 | 2;
    loopsHit: number;
    loopsTotal: number;
    log: BlowoutLogEntry[];
  };
  /** How many times Claude Code compacted the session on its own, any loop, counted from its stored compact events (#805). Shown as the Comp pill. */
  compactions: number;
  plan: PlanView | null;
  /** The main loop's steps, tools and skills; null from a reporter older than 0.4.0 and for a hooks-only session. */
  loop: LoopReport | null;
  /** The files the session changed; null from a reporter older than 0.6.0 and for a hooks-only session. */
  files: FilesReport | null;
  /** What the session is idle on: background work or a scheduled wake-up. null when it waits on nothing. Not a wait on the person. */
  background: BackgroundWait | null;
  /** Whether any client is attached; null from a reporter older than 0.7.0 and for a hooks-only session, which counts as attached. */
  attached: boolean | null;
  /** When a session nobody is attached to leaves the wall: the first detached report plus DETACHED_HIDE_AFTER_MS. null while attached or unknown. */
  hideAt: number | null;
  /** Who the server decided this session belongs to, from the token: a person's name, `Admin` for the admin secret, null when auth is off or the session predates tokens. */
  owner: string | null;
  /** The group the owner is in, from Admin; null for Admin, no owner, or a person with no group. */
  ownerGroup: string | null;
  /** The machine the session runs on, as the reporter sent it; null when it sent none (no userName, or older than 0.9.0). */
  machine: MachineInfo | null;
  /**
   * Whether the reporter's activityFeed option is on (#118). null when the server does not know: a reporter older
   * than 0.13.0, a settings-hooks session, or no report since the server started. Held in memory, not stored.
   */
  activityFeed: boolean | null;
  /** Whether the reporter's activityOutput option is on (#431); null as for `activityFeed`. Held in memory. */
  activityOutput: boolean | null;
  /** Whether the reporter's fileDiff option is on (#319); null as for `activityFeed`. Held in memory. */
  fileDiff: boolean | null;
  /** Whether the reporter's fileDiffPreload option is on (#631); null as for `fileDiff`. Held in memory. */
  fileDiffPreload: boolean | null;
  /** Report.session.respond (#206); null for a reporter older than 0.14.0, a settings-hooks session, or no report since the server started (held in memory). */
  respond: RespondInfo | null;
  /** The session's asks, open or closed in the last 10 minutes, without their content (served only to the owner or an Admin). */
  asks: AskSummary[];
  /** The harness that runs the session; `claude-code` for a session from before it was stored (#851). */
  harness: string;
  /** Who worked out `costUsd`: `harness` when the harness reported it, which the console labels as the harness's figure; `estimate` when Podium priced it. */
  costSource: CostSource;
  /** The session this one continues after a /clear. */
  clearedFrom: string | null;
  /** The session's recording, for the notice everyone sees (#353): absent or null when nothing is chosen or kept. Carries no text. */
  recording?: RecordingView | null;
  agents: AgentView[];
  series: { tokensPerSec: number[]; peakContext: number[]; running: number[]; blowoutSecondsAgo: number[] };
}

/** Where an ask stands: open, an answer taken but not yet confirmed, an approval Claude Code did not take, or closed. */
export type AskState = 'open' | 'pending' | 'not-taken' | 'closed';

/** An ask as the state and the stream carry it: no question, plan or tool input (#206). */
export interface AskSummary {
  id: string;
  kind: AskKind;
  agentId: string | null;
  openedAt: number;
  /** The questions in a question ask (the Respond button's number); 1 otherwise. */
  count: number;
  state: AskState;
}

/** How an ask closed, as the modal shows it. `podium` is an answer from Podium that the session took. */
export type AskOutcome = 'podium' | 'terminal' | 'closed' | 'ended';

/** One delivery as the modal reads it back: what was sent, by whom, and what became of it. */
export interface DeliveryView extends Delivery {
  result: DeliveryResult | null;
  /** Whether the signed-in person sent it. */
  mine: boolean;
  /** Whether the mod has been handed it (it can no longer be discarded). */
  handedOver: boolean;
}

/** GET /api/fleet/respond/sessions/:id/asks/:askId: the whole ask, for its owner or an Admin. */
export interface AskDetail {
  ask: Ask;
  state: AskState;
  delivery: DeliveryView | null;
  closed: { outcome: AskOutcome; at: number; by: string | null; answer: string | null; planApproved: boolean } | null;
  lastSeenAt: number;
}

/** GET /api/fleet/respond/me. */
export interface RespondMe {
  /** Authentication on and the Admin's respond flag on. */
  enabled: boolean;
  signedIn: boolean;
  /** The signed-in person's name, or `Admin`. */
  name: string | null;
  /** The admin secret, or a person in Administrators. */
  admin: boolean;
}

/** One stored activity event as the UI shows it: the event plus who it is about. */
export interface ActivityView {
  id: string;
  sessionId: string;
  sessionName: string;
  modelFamily: ModelFamily;
  agentId: string | null;
  t: number;
  kind: EventKind;
  text: string;
  data: Record<string, unknown> | null;
}

export interface Kpis {
  live: number;
  running: number;
  waiting: number;
  stale: number;
  agentsRunning: number;
  /** Agents queued, not started yet: what the Board's Subagents waiting tile counts (#450). */
  agentsWaiting: number;
  agentsTotal: number;
  planDone: number;
  planTotal: number;
  costToday: number;
  /** Live sessions on a model with no price (not a Claude model); their cost is left out of `costToday`. */
  unpricedSessions: number;
  tokensLastMinute: number;
  blowoutsTotal: number;
  sessionsAtLevel2: number;
  /** Fleet cost per minute for the last 60 minutes, oldest first (USD). */
  costPerMinute: number[];
  /** Fleet tokens per second for the last 60 seconds, oldest first. */
  tokensPerSec: number[];
  /** `costToday` split by owner (null for sessions with no owner), with each owner's group, largest first. */
  costTodayByOwner: OwnerSpend[];
}

/** One owner's share of today's estimated spend. */
export interface OwnerSpend {
  owner: string | null;
  group: string | null;
  costUsd: number;
}

/** The server's lifecycle timings, so the UI can say when a stale session will be dropped. */
export interface LifecycleConfig {
  staleAfterMs: number;
  dropAfterMs: number;
  lingerMs: number;
  detachedHideAfterMs: number;
}

/** The wall's display settings, set in Admin > Settings (SPEC 8.1). Notices default on; background sessions and machine titles default off. */
export interface WallSettingsView {
  /** One switch per informational notice, by id. */
  notices: Record<string, boolean>;
  showBackgroundSessions: boolean;
  /** Title each card `machine | session` instead of the session's name alone (#480). */
  cardTitleMachine: boolean;
  /**
   * A Podium release newer than this server that nobody has closed the notice for (#499), with the link to its notes. Null when
   * there is none, the Release check is off or the last check failed. An older server sends no field, which reads as null.
   */
  update?: UpdateNotice | null;
}

/** A release newer than the running server: its MAJOR.MINOR.PATCH (no leading v) and the link to its release notes. */
export interface UpdateNotice {
  latest: string;
  url: string;
}

export interface StateBody {
  serverTime: number;
  config: LifecycleConfig;
  sessions: SessionView[];
  kpis: Kpis;
  clearedToday: number;
  events: ActivityView[];
  /** The server's own version and the reporter range it supports, for the mismatch notice. `build` is the commit hash of a dev build (#400), null for a release. */
  server: { version: string; build: string | null; reporterSupport: ReporterSupport };
  wall: WallSettingsView;
  /** The Admin's feature flags by id (Admin > Settings > Feature flags), each on unless the Admin turned it off. */
  features: Record<string, boolean>;
}

export type RemovedReason = 'done' | 'dropped' | 'deleted';

/** One ended or dropped session, as GET /api/fleet/history lists it. */
export interface HistoryRow {
  id: string;
  name: string;
  project: string;
  model: string | null;
  modelFamily: ModelFamily;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  costUsd: number | null;
  /** The harness that ran the session, and who worked out `costUsd` (#853), as in SessionView. */
  harness: string;
  costSource: CostSource;
  blowouts: number;
  agents: number;
  endReason: string | null;
  /** The session this one continues after a /clear, and the one that continued it (#206). */
  clearedFrom: string | null;
  clearedInto: string | null;
  /**
   * A recording of the session is kept (#353): until when its oldest part goes. Present only for a viewer who may know of it (the
   * session's owner or an Admin) and only while there is a recording; absent otherwise.
   */
  recording?: { keptUntil: number | null };
}

// ---------------------------------------------------------------------------------------------
// Validation (SPEC 7.7). Hand-written: strings are clamped, arrays over their limit are rejected.
// ---------------------------------------------------------------------------------------------

export const LIMITS = {
  /** Commands a v2 report may declare (#850). */
  commands: 64,
  name: 80,
  text: 240,
  excerpt: 400,
  /** promptText / answerText: the 20,000-character cap plus room for the mod's cut-off marker. */
  fullText: 20_100,
  waitNote: 160,
  call: 300,
  line: 240,
  outputLines: 12,
  evidenceLines: 5,
  id: 200,
  path: 1024,
  short: 120,
  agents: 200,
  events: 100,
  planSteps: 100,
  skills: 50,
  toolNames: 100,
  usageModels: 40,
  backgroundTasks: 20,
  backgroundDescription: 120,
  rateLimits: 10,
  blowoutLog: 50,
  files: 200,
  filePath: 300,
  machineName: 64,
  /** One loop's activity feed (#118): entries kept, characters per entry, and characters over the whole report. */
  activityEntries: 20,
  activityText: 300,
  activityChars: 60_000,
  /** A Bash entry's command and its output (#431): the 20,000-character cap plus room for the mod's cut-off marker, as `fullText`. */
  activityDetail: 20_100,
  /** Characters of commands and output over the whole report (#431), apart from `activityChars`. Under the 512 KB body limit with the summaries and full text. */
  activityDetailChars: 200_000,
} as const;

/** Room past a respond limit for the reporter's "[cut off at N characters]" marker. */
const CUT_MARKER_ROOM = 60;

export type ValidateResult = { ok: true; report: Report } | { ok: false; error: string; path: string };

class Invalid extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

// Control characters other than tab are removed from every string.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/g;

// The full prompt and answer keep their line breaks: only the other control characters go.
// eslint-disable-next-line no-control-regex
const CONTROL_KEEP_NEWLINE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function clampText(v: string, max: number): string {
  const clean = v.replace(CONTROL_KEEP_NEWLINE, ' ');
  return clean.length > max ? clean.slice(0, max) : clean;
}

function clampStr(v: string, max: number): string {
  const clean = v.replace(CONTROL, ' ');
  return clean.length > max ? clean.slice(0, max) : clean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (!isObj(v)) throw new Invalid(path, 'expected an object');
  return v;
}

function str(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string') throw new Invalid(path, 'expected a string');
  return clampStr(v, max);
}

function text(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string') throw new Invalid(path, 'expected a string');
  return clampText(v, max);
}

function strOrNull(v: unknown, path: string, max: number): string | null {
  if (v === null || v === undefined) return null;
  return str(v, path, max);
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Invalid(path, 'expected a finite number');
  return v;
}

function numOrNull(v: unknown, path: string): number | null {
  if (v === null || v === undefined) return null;
  return num(v, path);
}

function int(v: unknown, path: string): number {
  const n = num(v, path);
  if (n < 0) throw new Invalid(path, 'expected a non-negative number');
  return Math.round(n);
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new Invalid(path, 'expected a boolean');
  return v;
}

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new Invalid(path, `expected one of ${allowed.join(', ')}`);
  }
  return v as T;
}

function oneOfOrNull<T extends string>(v: unknown, path: string, allowed: readonly T[]): T | null {
  if (v === null || v === undefined) return null;
  return oneOf(v, path, allowed);
}

/** Calls per tool name: names clipped, counts non-negative integers, the most used `max` names kept. */
function countsOrNull(v: unknown, path: string, max: number): Record<string, number> | null {
  if (v === null || v === undefined) return null;
  const merged = new Map<string, number>();
  for (const [k, n] of Object.entries(obj(v, path))) {
    const name = clampStr(k, LIMITS.short);
    merged.set(name, (merged.get(name) ?? 0) + int(n, `${path}.${k}`));
  }
  const top = [...merged].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, max);
  return Object.fromEntries(top);
}

function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) throw new Invalid(path, 'expected an array');
  if (v.length > max) throw new Invalid(path, `at most ${max} items allowed`);
  return v;
}

const EFFORTS: readonly KnownEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const AGENT_KINDS = ['subagent', 'fork', 'teammate'] as const;
const PLAN_SOURCES = ['TaskCreate', 'TodoWrite', 'podium_plan'] as const;

/** A closed list for a v1 report, a free non-empty string (clamped) for a v2 one (#850); null stays null. */
function listOrFree<T extends string>(version: ReportVersion, v: unknown, path: string, allowed: readonly T[]): string | null {
  if (version === 1) return oneOfOrNull(v, path, allowed);
  if (v === null || v === undefined) return null;
  const out = str(v, path, LIMITS.short);
  if (out === '') throw new Invalid(path, 'must not be empty');
  return out;
}

/** Same, for a value that cannot be null. */
function listOrFreeReq<T extends string>(version: ReportVersion, v: unknown, path: string, allowed: readonly T[]): string {
  const out = listOrFree(version, v, path, allowed);
  if (out === null) throw new Invalid(path, version === 1 ? `expected one of ${allowed.join(', ')}` : 'expected a string');
  return out;
}
const AGENT_STATUSES: readonly AgentStatus[] = ['queued', 'running', 'done', 'failed', 'aborted'];
const EVENT_KINDS: readonly EventKind[] = ['start', 'end', 'spawn', 'skill', 'done', 'fail', 'blow', 'compact', 'plan', 'wait', 'note'];
const FAILURE_CLASSES: readonly FailureClass[] = [
  'Tool error',
  'Blocked by permission',
  'Model API error',
  'Refusal',
  'Context window exhausted',
  'Aborted',
  'Unknown',
];

function tokens(v: unknown, path: string): TokenCounts {
  const o = obj(v, path);
  return {
    input: int(o.input, `${path}.input`),
    output: int(o.output, `${path}.output`),
    cacheRead: int(o.cacheRead, `${path}.cacheRead`),
    cacheWrite: int(o.cacheWrite, `${path}.cacheWrite`),
  };
}

/** Absent stays absent: an older reporter sends none, and the server falls back to the cost it was sent. */
function usageByModel(v: unknown, path: string): { usageByModel?: ModelUsage[] } {
  if (v === undefined || v === null) return {};
  return {
    usageByModel: arr(v, path, LIMITS.usageModels).map((r, i) => {
      const p = `${path}[${i}]`;
      const o = obj(r, p);
      const t = obj(o.tokens, `${p}.tokens`);
      return {
        model: str(o.model, `${p}.model`, LIMITS.short),
        tier: oneOf(o.tier, `${p}.tier`, ['std', 'long'] as const),
        tokens: {
          input: int(t.input, `${p}.tokens.input`),
          output: int(t.output, `${p}.tokens.output`),
          cacheRead: int(t.cacheRead, `${p}.tokens.cacheRead`),
          cacheWrite: int(t.cacheWrite, `${p}.tokens.cacheWrite`),
          cacheWrite1h: t.cacheWrite1h === undefined || t.cacheWrite1h === null ? 0 : int(t.cacheWrite1h, `${p}.tokens.cacheWrite1h`),
        },
      };
    }),
  };
}

function context(v: unknown, path: string): ContextFill {
  const o = obj(v, path);
  const percent = numOrNull(o.percent, `${path}.percent`);
  return {
    tokens: numOrNull(o.tokens, `${path}.tokens`),
    window: numOrNull(o.window, `${path}.window`),
    percent: percent === null ? null : Math.max(0, Math.min(100, percent)),
  };
}

function git(v: unknown, path: string): GitInfo | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  return {
    branch: strOrNull(o.branch, `${path}.branch`, LIMITS.short),
    detached: bool(o.detached, `${path}.detached`),
    isWorktree: bool(o.isWorktree, `${path}.isWorktree`),
    worktreePath: strOrNull(o.worktreePath, `${path}.worktreePath`, LIMITS.path),
    ahead: int(o.ahead, `${path}.ahead`),
    behind: int(o.behind, `${path}.behind`),
    dirty: int(o.dirty, `${path}.dirty`),
  };
}

function plan(v: unknown, path: string, version: ReportVersion): Plan | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  const steps = arr(o.steps, `${path}.steps`, LIMITS.planSteps).map((s, i) => {
    const p = `${path}.steps[${i}]`;
    const so = obj(s, p);
    return {
      id: str(so.id, `${p}.id`, LIMITS.id),
      text: str(so.text, `${p}.text`, LIMITS.text),
      state: oneOf(so.state, `${p}.state`, ['pending', 'active', 'done', 'blocked'] as const),
      activeText: strOrNull(so.activeText, `${p}.activeText`, LIMITS.text),
      ownerAgentId: strOrNull(so.ownerAgentId, `${p}.ownerAgentId`, LIMITS.id),
      ownerLabel: strOrNull(so.ownerLabel, `${p}.ownerLabel`, LIMITS.short),
    };
  });
  return {
    title: strOrNull(o.title, `${path}.title`, LIMITS.text),
    source: listOrFreeReq(version, o.source, `${path}.source`, PLAN_SOURCES),
    steps,
  };
}

function lines(v: unknown, path: string, keep: number, fromEnd: boolean): string[] {
  if (!Array.isArray(v)) throw new Invalid(path, 'expected an array');
  if (v.length > 1000) throw new Invalid(path, 'at most 1000 items allowed');
  const all = v.map((l, i) => str(l, `${path}[${i}]`, LIMITS.line));
  return fromEnd ? all.slice(-keep) : all.slice(0, keep);
}

function failure(v: unknown, path: string): Failure | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  const exit = numOrNull(o.exitCode, `${path}.exitCode`);
  return {
    class: oneOf(o.class, `${path}.class`, FAILURE_CLASSES),
    at: num(o.at, `${path}.at`),
    tool: strOrNull(o.tool, `${path}.tool`, LIMITS.short),
    call: strOrNull(o.call, `${path}.call`, LIMITS.call),
    exitCode: exit === null ? null : Math.round(exit),
    outputTail: lines(o.outputTail, `${path}.outputTail`, LIMITS.outputLines, true),
    evidence: lines(o.evidence, `${path}.evidence`, LIMITS.evidenceLines, false),
    explanation: strOrNull(o.explanation, `${path}.explanation`, LIMITS.excerpt),
    retriedAs: strOrNull(o.retriedAs, `${path}.retriedAs`, LIMITS.id),
  };
}

function agent(v: unknown, path: string, version: ReportVersion): AgentReport {
  const o = obj(v, path);
  let steps: AgentReport['steps'] = null;
  if (o.steps !== null && o.steps !== undefined) {
    const so = obj(o.steps, `${path}.steps`);
    const total = numOrNull(so.total, `${path}.steps.total`);
    steps = { done: int(so.done, `${path}.steps.done`), total: total === null ? null : Math.max(0, Math.round(total)) };
  }
  return {
    id: str(o.id, `${path}.id`, LIMITS.id),
    parentId: strOrNull(o.parentId, `${path}.parentId`, LIMITS.id),
    kind: listOrFreeReq(version, o.kind, `${path}.kind`, AGENT_KINDS),
    type: str(o.type, `${path}.type`, LIMITS.short),
    name: strOrNull(o.name, `${path}.name`, LIMITS.name),
    description: str(o.description, `${path}.description`, LIMITS.text),
    model: strOrNull(o.model, `${path}.model`, LIMITS.short),
    ...modelFields(o, path, version),
    effort: listOrFree(version, o.effort, `${path}.effort`, EFFORTS),
    effortSource: oneOf(o.effortSource, `${path}.effortSource`, ['requested', 'observed', 'inherited', 'unknown'] as const),
    status: oneOf(o.status, `${path}.status`, AGENT_STATUSES),
    startedAt: num(o.startedAt, `${path}.startedAt`),
    endedAt: numOrNull(o.endedAt, `${path}.endedAt`),
    context: context(o.context, `${path}.context`),
    tokens: tokens(o.tokens, `${path}.tokens`),
    costUsdEst: (() => {
      const c = numOrNull(o.costUsdEst, `${path}.costUsdEst`);
      return c === null ? null : Math.max(0, c);
    })(),
    ...usageByModel(o.usageByModel, `${path}.usageByModel`),
    skills: arr(o.skills, `${path}.skills`, LIMITS.skills).map((s, i) => str(s, `${path}.skills[${i}]`, LIMITS.short)),
    lastTool: strOrNull(o.lastTool, `${path}.lastTool`, LIMITS.short),
    toolCalls: int(o.toolCalls, `${path}.toolCalls`),
    toolCounts: countsOrNull(o.toolCounts, `${path}.toolCounts`, LIMITS.toolNames),
    blowouts: int(o.blowouts, `${path}.blowouts`),
    steps,
    promptExcerpt: str(o.promptExcerpt, `${path}.promptExcerpt`, LIMITS.excerpt),
    answerExcerpt: strOrNull(o.answerExcerpt, `${path}.answerExcerpt`, LIMITS.excerpt),
    ...(o.promptText === undefined || o.promptText === null ? {} : { promptText: text(o.promptText, `${path}.promptText`, LIMITS.fullText) }),
    ...(o.answerText === undefined || o.answerText === null ? {} : { answerText: text(o.answerText, `${path}.answerText`, LIMITS.fullText) }),
    ...activity(o.activity, `${path}.activity`),
    failure: failure(o.failure, `${path}.failure`),
  };
}

function event(v: unknown, path: string): ActivityEvent {
  const o = obj(v, path);
  let data: Record<string, unknown> | null = null;
  if (o.data !== null && o.data !== undefined) {
    data = obj(o.data, `${path}.data`);
    if (JSON.stringify(data).length > 4096) throw new Invalid(`${path}.data`, 'at most 4096 characters of data allowed');
  }
  return {
    id: str(o.id, `${path}.id`, LIMITS.id),
    t: num(o.t, `${path}.t`),
    kind: oneOf(o.kind, `${path}.kind`, EVENT_KINDS),
    agentId: strOrNull(o.agentId, `${path}.agentId`, LIMITS.id),
    text: str(o.text, `${path}.text`, LIMITS.text),
    data,
  };
}

function loop(v: unknown, path: string): LoopReport | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  const steps = obj(o.steps, `${path}.steps`);
  return {
    skills: arr(o.skills, `${path}.skills`, LIMITS.skills).map((s, i) => str(s, `${path}.skills[${i}]`, LIMITS.short)),
    lastTool: strOrNull(o.lastTool, `${path}.lastTool`, LIMITS.short),
    toolCalls: int(o.toolCalls, `${path}.toolCalls`),
    toolCounts: countsOrNull(o.toolCounts, `${path}.toolCounts`, LIMITS.toolNames) ?? {},
    steps: { done: int(steps.done, `${path}.steps.done`), total: null },
  };
}

const FILE_STATUSES: readonly FileStatus[] = ['added', 'modified', 'deleted', 'renamed'];

function intOrNull(v: unknown, path: string): number | null {
  return v === null || v === undefined ? null : int(v, path);
}

/** Keeps the first LIMITS.files entries rather than rejecting a longer list; `total` never falls below what is listed. */
function filesReport(v: unknown, path: string): FilesReport | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  const listed = arr(o.files, `${path}.files`, 1000).slice(0, LIMITS.files);
  const files = listed.map((f, i) => {
    const p = `${path}.files[${i}]`;
    const fo = obj(f, p);
    return {
      path: str(fo.path, `${p}.path`, LIMITS.filePath),
      status: oneOf(fo.status, `${p}.status`, FILE_STATUSES),
      added: intOrNull(fo.added, `${p}.added`),
      removed: intOrNull(fo.removed, `${p}.removed`),
      from: strOrNull(fo.from, `${p}.from`, LIMITS.filePath),
      ...(fo.rev === undefined || fo.rev === null ? {} : { rev: str(fo.rev, `${p}.rev`, 64) }),
    };
  });
  return {
    files,
    total: Math.max(int(o.total, `${path}.total`), files.length),
    added: int(o.added, `${path}.added`),
    removed: int(o.removed, `${path}.removed`),
    since: oneOf(o.since, `${path}.since`, ['start', 'upstream', 'worktree'] as const),
  };
}

/**
 * The harness and cost source of a session report (#851), each left out when the report does not say. In a v2 report the
 * harness block is the one source of the id, so a session `harness` that names another one is an error (#850).
 */
function harnessFields(o: Record<string, unknown>, path: string, harnessId: string | null): { harness?: string; costSource?: CostSource } {
  const harness = o.harness === undefined || o.harness === null ? null : str(o.harness, `${path}.harness`, LIMITS.short);
  if (harness === '') throw new Invalid(`${path}.harness`, 'must not be empty');
  if (harnessId !== null && harness !== null && harness !== harnessId) throw new Invalid(`${path}.harness`, 'must match $.harness.id');
  const costSource = oneOfOrNull(o.costSource, `${path}.costSource`, ['harness', 'estimate'] as const);
  const id = harnessId ?? harness;
  return { ...(id === null ? {} : { harness: id }), ...(costSource === null ? {} : { costSource }) };
}

/** The `harness` block of a v2 report (#850). */
function harnessBlock(v: unknown, path: string): HarnessInfo {
  const o = obj(v, path);
  // Checked as sent: `str` clamps, and a clamped id would let two long ids collide.
  const id = typeof o.id === 'string' ? o.id : str(o.id, `${path}.id`, 0);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Invalid(`${path}.id`, 'expected 1 to 32 letters, digits, - or _');
  const name = str(o.name, `${path}.name`, LIMITS.name).trim();
  if (!name) throw new Invalid(`${path}.name`, 'must not be empty');
  return { id, name, version: str(o.version, `${path}.version`, LIMITS.short), surface: strOrNull(o.surface, `${path}.surface`, LIMITS.short) };
}

/** The `capabilities` block of a v2 report (#850): a boolean per key the reporter supports, and its commands. Unknown keys are dropped. */
function capabilitiesBlock(v: unknown, path: string): Capabilities {
  const o = obj(v, path);
  const out: Capabilities = { commands: [] };
  for (const key of CAPABILITY_KEYS) {
    if (o[key] !== undefined) out[key] = bool(o[key], `${path}.${key}`);
  }
  if (o.commands !== undefined) {
    const seen = arr(o.commands, `${path}.commands`, LIMITS.commands).map((c, i) => {
      const cmd = str(c, `${path}.commands[${i}]`, LIMITS.short).trim();
      if (!cmd) throw new Invalid(`${path}.commands[${i}]`, 'must not be empty');
      return cmd;
    });
    out.commands = [...new Set(seen)];
  }
  return out;
}

/** A model's provider and label (v2 only, #850); a field that is omitted stays omitted, null stays null. v1 never carries them. */
function modelFields(o: Record<string, unknown>, path: string, version: ReportVersion): { modelProvider?: string | null; modelLabel?: string | null } {
  if (version === 1) return {};
  const out: { modelProvider?: string | null; modelLabel?: string | null } = {};
  if (o.modelProvider !== undefined) out.modelProvider = strOrNull(o.modelProvider, `${path}.modelProvider`, LIMITS.short);
  if (o.modelLabel !== undefined) out.modelLabel = strOrNull(o.modelLabel, `${path}.modelLabel`, LIMITS.short);
  return out;
}

function session(v: unknown, path: string, version: ReportVersion, harnessId: string | null): SessionReport {
  const o = obj(v, path);
  const id = str(o.id, `${path}.id`, LIMITS.id);
  if (!id) throw new Invalid(`${path}.id`, 'must not be empty');
  const bg = background(o.background, `${path}.background`);
  return {
    id,
    name: str(o.name, `${path}.name`, LIMITS.name),
    status: oneOf(o.status, `${path}.status`, ['running', 'waiting', 'done'] as const),
    waitReason: oneOfOrNull(o.waitReason, `${path}.waitReason`, ['permission', 'input'] as const),
    waitNote: strOrNull(o.waitNote, `${path}.waitNote`, LIMITS.waitNote),
    endReason: strOrNull(o.endReason, `${path}.endReason`, LIMITS.short),
    resumeId: strOrNull(o.resumeId, `${path}.resumeId`, LIMITS.id),
    startedAt: num(o.startedAt, `${path}.startedAt`),
    cwd: str(o.cwd, `${path}.cwd`, LIMITS.path),
    projectRoot: strOrNull(o.projectRoot, `${path}.projectRoot`, LIMITS.path),
    repoName: strOrNull(o.repoName, `${path}.repoName`, LIMITS.short),
    git: git(o.git, `${path}.git`),
    model: strOrNull(o.model, `${path}.model`, LIMITS.short),
    ...modelFields(o, path, version),
    effort: listOrFree(version, o.effort, `${path}.effort`, EFFORTS),
    context: context(o.context, `${path}.context`),
    costUsd: (() => {
      const c = numOrNull(o.costUsd, `${path}.costUsd`);
      return c === null ? null : Math.max(0, c);
    })(),
    tokens: tokens(o.tokens, `${path}.tokens`),
    ...harnessFields(o, path, harnessId),
    ...usageByModel(o.usageByModel, `${path}.usageByModel`),
    rateLimits: arr(o.rateLimits, `${path}.rateLimits`, LIMITS.rateLimits).map((r, i) => {
      const p = `${path}.rateLimits[${i}]`;
      const ro = obj(r, p);
      return {
        kind: str(ro.kind, `${p}.kind`, LIMITS.short),
        percentUsed: num(ro.percentUsed, `${p}.percentUsed`),
        resetsAt: strOrNull(ro.resetsAt, `${p}.resetsAt`, LIMITS.short),
      };
    }),
    blowouts: int(o.blowouts, `${path}.blowouts`),
    plan: plan(o.plan, `${path}.plan`, version),
    loop: loop(o.loop, `${path}.loop`),
    files: filesReport(o.files, `${path}.files`),
    attached: o.attached === undefined || o.attached === null ? null : bool(o.attached, `${path}.attached`),
    ...(bg ? { background: bg } : {}),
    ...(o.activityFeed === undefined || o.activityFeed === null ? {} : { activityFeed: bool(o.activityFeed, `${path}.activityFeed`) }),
    ...(o.activityOutput === undefined || o.activityOutput === null ? {} : { activityOutput: bool(o.activityOutput, `${path}.activityOutput`) }),
    ...(o.fileDiff === undefined || o.fileDiff === null ? {} : { fileDiff: bool(o.fileDiff, `${path}.fileDiff`) }),
    ...(o.fileDiffPreload === undefined || o.fileDiffPreload === null ? {} : { fileDiffPreload: bool(o.fileDiffPreload, `${path}.fileDiffPreload`) }),
    ...activity(o.activity, `${path}.activity`),
    ...respondInfo(o.respond, `${path}.respond`),
    ...(o.asks === undefined || o.asks === null ? {} : { asks: asks(o.asks, `${path}.asks`) }),
    ...(o.clearedFrom === undefined ? {} : { clearedFrom: strOrNull(o.clearedFrom, `${path}.clearedFrom`, LIMITS.id) }),
    ...(o.peers === undefined || o.peers === null ? {} : { peers: bool(o.peers, `${path}.peers`) }),
    ...(o.sessionRecording === undefined || o.sessionRecording === null ? {} : { sessionRecording: bool(o.sessionRecording, `${path}.sessionRecording`) }),
  };
}

/** Report.session.respond. `accepts` is kept only where the level allows it, so a reporter cannot claim more than its level. */
function respondInfo(v: unknown, path: string): { respond?: RespondInfo } {
  if (v === undefined || v === null) return {};
  const o = obj(v, path);
  const level = oneOf(o.level, `${path}.level`, RESPOND_LEVELS);
  const accepts = arr(o.accepts, `${path}.accepts`, RESPOND_KINDS.length).map((k, i) => oneOf(k, `${path}.accepts[${i}]`, RESPOND_KINDS));
  const limits = arr(o.limits, `${path}.limits`, RESPOND_LIMIT_NAMES.length).map((k, i) => oneOf(k, `${path}.limits[${i}]`, RESPOND_LIMIT_NAMES));
  const allowed = LEVEL_KINDS[level];
  return { respond: { level, accepts: [...new Set(accepts)].filter((k) => allowed.includes(k)), limits: [...new Set(limits)] } };
}

function asks(v: unknown, path: string): Ask[] {
  return arr(v, path, RESPOND_LIMITS.asks).map((a, i) => ask(a, `${path}[${i}]`));
}

/** One ask (6.2): strings clamped to their limits (with room for the cut-off marker), lists over their limit rejected. */
function ask(v: unknown, path: string): Ask {
  const o = obj(v, path);
  const id = str(o.id, `${path}.id`, LIMITS.id);
  if (!id) throw new Invalid(`${path}.id`, 'must not be empty');
  const kind = oneOf(o.kind, `${path}.kind`, ['question', 'plan', 'permission'] as const);
  const out: Ask = { id, kind, agentId: strOrNull(o.agentId, `${path}.agentId`, LIMITS.id), openedAt: num(o.openedAt, `${path}.openedAt`) };
  const room = (n: number) => n + CUT_MARKER_ROOM;
  if (kind === 'question') {
    const qs = arr(o.questions, `${path}.questions`, RESPOND_LIMITS.questions);
    if (!qs.length) throw new Invalid(`${path}.questions`, 'expected at least one question');
    out.questions = qs.map((q, i) => {
      const p = `${path}.questions[${i}]`;
      const qo = obj(q, p);
      const opts = arr(qo.options, `${p}.options`, RESPOND_LIMITS.options);
      if (!opts.length) throw new Invalid(`${p}.options`, 'expected at least one option');
      return {
        question: text(qo.question, `${p}.question`, room(RESPOND_LIMITS.question)),
        header: str(qo.header, `${p}.header`, RESPOND_LIMITS.header),
        multiSelect: bool(qo.multiSelect, `${p}.multiSelect`),
        options: opts.map((op, j) => {
          const pp = `${p}.options[${j}]`;
          const oo = obj(op, pp);
          const preview = oo.preview === undefined || oo.preview === null ? null : text(oo.preview, `${pp}.preview`, room(RESPOND_LIMITS.preview));
          return { label: str(oo.label, `${pp}.label`, room(RESPOND_LIMITS.label)), description: text(oo.description, `${pp}.description`, room(RESPOND_LIMITS.description)), preview };
        }),
      };
    });
  } else if (kind === 'plan') {
    const po = obj(o.plan, `${path}.plan`);
    out.plan = { text: text(po.text, `${path}.plan.text`, room(RESPOND_LIMITS.plan)), filePath: strOrNull(po.filePath, `${path}.plan.filePath`, LIMITS.path) };
  } else {
    const to = obj(o.tool, `${path}.tool`);
    const input = obj(to.input, `${path}.tool.input`);
    if (JSON.stringify(input).length > room(RESPOND_LIMITS.toolInput)) throw new Invalid(`${path}.tool.input`, `at most ${RESPOND_LIMITS.toolInput} characters of input allowed`);
    out.tool = { name: str(to.name, `${path}.tool.name`, LIMITS.short), input, cut: bool(to.cut, `${path}.tool.cut`) };
  }
  return out;
}

/** Validates one ask as the mod announces it (PUT …/asks/:askId). Never throws. */
export function validateAsk(body: unknown): { ok: true; ask: Ask } | { ok: false; error: string; path: string } {
  try {
    return { ok: true, ask: ask(body, '$') };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message, path: err.path };
    return { ok: false, error: 'invalid ask', path: '$' };
  }
}

/** Validates the mod's answer to a diff request (PUT …/diffs/:requestId, #319). `text` is kept as sent, only a size is enforced. Never throws. */
export function validateFileDiffReply(body: unknown): { ok: true; reply: FileDiffReply } | { ok: false; error: string; path: string } {
  try {
    const o = obj(body, '$');
    const status = oneOf(o.status, '$.status', FILE_DIFF_STATUSES);
    let diffText: string | null = null;
    if (o.text !== undefined && o.text !== null) {
      if (typeof o.text !== 'string') throw new Invalid('$.text', 'expected a string');
      if (o.text.length > FILE_DIFF_LIMITS.answerBytes) throw new Invalid('$.text', `at most ${FILE_DIFF_LIMITS.answerBytes} characters allowed`);
      diffText = o.text;
    }
    if (status === 'ok' && diffText === null) throw new Invalid('$.text', 'a diff with status ok needs its text');
    if (status !== 'ok' && diffText !== null) throw new Invalid('$.text', `a diff with status ${status} has no text`);
    return {
      ok: true,
      reply: {
        path: str(o.path, '$.path', LIMITS.filePath),
        status,
        text: diffText,
        truncated: o.truncated === undefined ? false : bool(o.truncated, '$.truncated'),
        shownLines: o.shownLines === undefined ? 0 : int(o.shownLines, '$.shownLines'),
        totalLines: o.totalLines === undefined ? 0 : int(o.totalLines, '$.totalLines'),
        redactions: o.redactions === undefined ? 0 : int(o.redactions, '$.redactions'),
        base: strOrNull(o.base, '$.base', LIMITS.short),
      },
    };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message, path: err.path };
    return { ok: false, error: 'invalid diff', path: '$' };
  }
}

const ACTIVITY_KINDS: readonly ActivityKind[] = ['tool', 'text', 'reasoning'];

/** A loop's activity feed (#118). Absent stays absent; each entry is cut to its limit, a longer list is rejected. */
function activity(v: unknown, path: string): { activity?: ActivityEntry[] } {
  if (v === undefined || v === null) return {};
  return {
    activity: arr(v, path, LIMITS.activityEntries).map((e, i) => {
      const p = `${path}[${i}]`;
      const o = obj(e, p);
      const kind = oneOf(o.kind, `${p}.kind`, ACTIVITY_KINDS);
      const entry: ActivityEntry = { at: num(o.at, `${p}.at`), kind, text: str(o.text, `${p}.text`, LIMITS.activityText) };
      if (o.id !== undefined && o.id !== null) entry.id = str(o.id, `${p}.id`, LIMITS.id);
      // The command and output belong to a tool call; on any other entry they are dropped, not rejected.
      const tool = kind === 'tool';
      const detail = (key: 'command' | 'output') => {
        const v = o[key];
        if (v === undefined || v === null) return;
        const t = text(v, `${p}.${key}`, LIMITS.activityDetail);
        if (tool) entry[key] = t;
      };
      const flag = (key: 'commandCut' | 'outputCut' | 'done' | 'failed') => {
        const v = o[key];
        if (v === undefined || v === null) return;
        const b = bool(v, `${p}.${key}`);
        if (tool && b) entry[key] = true;
      };
      detail('command');
      detail('output');
      flag('commandCut');
      flag('outputCut');
      flag('done');
      flag('failed');
      if (o.exitCode !== undefined && o.exitCode !== null) {
        const n = int(o.exitCode, `${p}.exitCode`);
        if (tool) entry.exitCode = n;
      }
      return entry;
    }),
  };
}

/**
 * What a Bash entry carries that is a call's output (#431): kept only when the session's `activityOutput` option is on. `done`,
 * `failed` and `exitCode` are not output; they say how the call ended, ride with `activityFeed` alone (#598), and are never
 * dropped here, whatever the budget.
 */
const OUTPUT_FIELDS = ['output', 'outputCut'] as const;

function detailChars(e: ActivityEntry): number {
  return (e.command?.length ?? 0) + (e.output?.length ?? 0);
}

/**
 * Keeps the report's activity within its two budgets. The summaries (`text`) take LIMITS.activityChars: the orchestrator's
 * first, then the agents' in order, and a loop that does not fit loses its feed for this report. Commands and output take
 * LIMITS.activityDetailChars (#431), in the same loop order and newest entry first: an entry that does not fit loses its
 * output, and then its command, and keeps its summary and how the call ended (`done`, `failed`, `exitCode`: a few bytes that
 * do not count). Output is dropped altogether unless the session says its `activityOutput` option is on.
 */
function withinActivityBudget(r: Report): void {
  let left: number = LIMITS.activityChars;
  const fits = (list: ActivityEntry[]) => {
    const n = list.reduce((sum, e) => sum + e.text.length, 0);
    if (n > left) return false;
    left -= n;
    return true;
  };
  if (r.session.activity && !fits(r.session.activity)) delete r.session.activity;
  for (const a of r.agents) if (a.activity && !fits(a.activity)) delete a.activity;

  const outputOn = r.session.activityOutput === true;
  let room: number = LIMITS.activityDetailChars;
  const trim = (list: ActivityEntry[]) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!;
      if (!outputOn) for (const k of OUTPUT_FIELDS) delete e[k];
      if (detailChars(e) <= room) {
        room -= detailChars(e);
        continue;
      }
      for (const k of OUTPUT_FIELDS) delete e[k];
      if (detailChars(e) <= room) room -= detailChars(e);
      else {
        delete e.command;
        delete e.commandCut;
      }
    }
  };
  if (r.session.activity) trim(r.session.activity);
  for (const a of r.agents) if (a.activity) trim(a.activity);
}

const BACKGROUND_KINDS = ['shell', 'agent', 'monitor', 'workflow', 'wakeup', 'other'] as const;

/** What a session idle between turns still waits on (#119). An empty list is no background work at all. */
function background(v: unknown, path: string): BackgroundWait | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  const tasks = arr(o.tasks, `${path}.tasks`, LIMITS.backgroundTasks).map((t, i) => {
    const p = `${path}.tasks[${i}]`;
    const to = obj(t, p);
    return {
      type: oneOf(to.type, `${p}.type`, BACKGROUND_KINDS),
      description: str(to.description, `${p}.description`, LIMITS.backgroundDescription),
      status: str(to.status, `${p}.status`, 40),
    };
  });
  const wakeAt = numOrNull(o.wakeAt, `${path}.wakeAt`);
  return tasks.length ? { tasks, wakeAt } : null;
}

/** A reporter's machine: a host name (clamped) and its own random id (letters, digits, `-` and `_`, at most 32). */
function machine(v: unknown, path: string): MachineInfo | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  const name = str(o.name, `${path}.name`, LIMITS.machineName).trim();
  if (!name) throw new Invalid(`${path}.name`, 'expected a host name');
  const id = str(o.id, `${path}.id`, 64);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Invalid(`${path}.id`, 'expected 1 to 32 letters, digits, - or _');
  const os = strOrNull(o.os, `${path}.os`, PEER_LIMITS.os)?.trim() || null;
  return os ? { name, id, os } : { name, id };
}

/**
 * Validates an untrusted body as a Report. Never throws. Strings are clamped to their limits and
 * stripped of control characters; arrays over their limit, wrong types and unknown enum values are
 * rejected with the path of the first offending field. Unknown fields are dropped.
 */
export function validateReport(body: unknown): ValidateResult {
  try {
    const o = obj(body, '$');
    if (o.v === undefined) throw new Invalid('$.v', 'missing protocol version');
    if (o.v !== 1 && o.v !== 2) throw new Invalid('$.v', 'unsupported protocol version');
    const version: ReportVersion = o.v;
    // v2 names its harness and what it can send; v1 has no block, so it means Claude Code unless the session says otherwise (#851).
    const harness = version === 2 ? harnessBlock(o.harness, '$.harness') : null;
    const capabilities = version === 2 ? capabilitiesBlock(o.capabilities, '$.capabilities') : null;
    const r = obj(o.reporter, '$.reporter');
    const report: Report = {
      v: version,
      sentAt: num(o.sentAt, '$.sentAt'),
      reporter: {
        name: oneOf(r.name, '$.reporter.name', ['podium-reporter'] as const),
        version: str(r.version, '$.reporter.version', LIMITS.short),
        engineVersion: strOrNull(r.engineVersion, '$.reporter.engineVersion', LIMITS.short),
        hostSurface: strOrNull(r.hostSurface, '$.reporter.hostSurface', LIMITS.short),
      },
      session: session(o.session, '$.session', version, harness?.id ?? null),
      agents: arr(o.agents, '$.agents', LIMITS.agents).map((a, i) => agent(a, `$.agents[${i}]`, version)),
      events: arr(o.events, '$.events', LIMITS.events).map((e, i) => event(e, `$.events[${i}]`)),
    };
    if (harness) report.harness = harness;
    if (capabilities) report.capabilities = capabilities;
    const build = parseBuild(r.build);
    if (build !== null) report.reporter.build = build;
    const userName = strOrNull(o.userName, '$.userName', LIMITS.name);
    if (userName !== null) report.userName = userName;
    const m = machine(o.machine, '$.machine');
    if (m !== null) report.machine = m;
    withinActivityBudget(report);
    return { ok: true, report };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message, path: err.path };
    return { ok: false, error: 'invalid report', path: '$' };
  }
}

/** The kinds the mod may send; the server writes `stopped` and `limit` itself. */
const RECORDING_MOD_KINDS: readonly RecordingKind[] = ['prompt', 'text', 'tool', 'result', 'thinking', 'clear', 'compact', 'decision', 'gap'];
/** The kinds whose sender (`by`) the mod names itself, because only the mod knows what it took from Podium. A prompt is marked by the server. */
const RECORDING_BY_KINDS: readonly RecordingKind[] = ['decision', 'clear', 'compact'];

function recordingEntry(v: unknown, path: string): RecordingEntry {
  const o = obj(v, path);
  const kind = oneOf(o.kind, `${path}.kind`, RECORDING_MOD_KINDS);
  const seq = int(o.seq, `${path}.seq`);
  if (seq < 1) throw new Invalid(`${path}.seq`, 'expected a number from 1');
  const entry: RecordingEntry = {
    loop: str(o.loop, `${path}.loop`, LIMITS.id),
    seq,
    at: num(o.at, `${path}.at`),
    kind,
    text: o.text === undefined || o.text === null ? '' : text(o.text, `${path}.text`, RECORDING_LIMITS.text + CUT_MARKER_ROOM),
  };
  if (!entry.loop) throw new Invalid(`${path}.loop`, 'expected a loop');
  const name = strOrNull(o.name, `${path}.name`, LIMITS.short);
  if (name !== null) entry.name = name;
  if (o.callSeq !== undefined && o.callSeq !== null) entry.callSeq = int(o.callSeq, `${path}.callSeq`);
  if (o.failed !== undefined && o.failed !== null) entry.failed = bool(o.failed, `${path}.failed`);
  if (o.cut !== undefined && o.cut !== null) entry.cut = bool(o.cut, `${path}.cut`);
  if (RECORDING_BY_KINDS.includes(kind)) {
    const by = strOrNull(o.by, `${path}.by`, LIMITS.short);
    if (by) entry.by = by;
  }
  if (kind === 'gap') {
    const lost = int(o.lost, `${path}.lost`);
    if (lost < 1) throw new Invalid(`${path}.lost`, 'a gap needs the number of entries lost');
    entry.lost = lost;
  }
  return entry;
}

/** Validates one batch of recorded entries (POST …/recording, #353). Text keeps its line breaks. Never throws. */
export function validateRecordingBatch(body: unknown): { ok: true; batch: RecordingBatch } | { ok: false; error: string; path: string } {
  try {
    const o = obj(body, '$');
    if (o.v !== 1) throw new Invalid('$.v', 'unsupported protocol version');
    return {
      ok: true,
      batch: {
        v: 1,
        sentAt: num(o.sentAt, '$.sentAt'),
        entries: arr(o.entries, '$.entries', RECORDING_LIMITS.entries).map((e, i) => recordingEntry(e, `$.entries[${i}]`)),
      },
    };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message, path: err.path };
    return { ok: false, error: 'invalid recording batch', path: '$' };
  }
}

/** Validates the loops a person chose to record (#353): 1 to 201 distinct loop ids. Never throws. */
export function validateRecordingStart(body: unknown): { ok: true; request: RecordingStartRequest } | { ok: false; error: string; path: string } {
  try {
    const o = obj(body, '$');
    const loops = [...new Set(arr(o.loops, '$.loops', LIMITS.agents + 1).map((l, i) => str(l, `$.loops[${i}]`, LIMITS.id)))];
    if (loops.length === 0 || loops.includes('')) throw new Invalid('$.loops', 'choose at least one loop');
    return { ok: true, request: { loops } };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message, path: err.path };
    return { ok: false, error: 'invalid recording request', path: '$' };
  }
}
