// Report types for the Podium reporter (SPEC 6.2). Types only.
// The block between the PROTOCOL markers is identical to the one in server/src/fleet/protocol.ts;
// a server test compares the two after whitespace normalization, so edit both together.

// <protocol:begin>
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'aborted';

export type FailureClass =
  | 'Tool error'
  | 'Blocked by permission'
  | 'Model API error'
  | 'Refusal'
  | 'Context window exhausted'
  | 'Aborted'
  | 'Unknown';

export type EventKind =
  | 'start' | 'end' | 'spawn' | 'skill' | 'done' | 'fail' | 'blow' | 'compact' | 'plan' | 'wait' | 'note';

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** `cacheWrite` is the 5-minute cache write; `cacheWrite1h` the 1-hour one (0 when the reporter cannot split them). */
export interface UsageTokens extends TokenCounts {
  cacheWrite1h: number;
}

/**
 * One model's token totals, so the server prices them with the Admin's prices (issue #117). `tier` is `long`
 * for requests whose prompt (input + cache reads + cache writes) is over 100,000 tokens.
 */
export interface ModelUsage {
  model: string;
  tier: 'std' | 'long';
  tokens: UsageTokens;
}

export interface ContextFill {
  tokens: number | null;
  window: number | null;
  percent: number | null;
}

export interface GitInfo {
  branch: string | null;
  detached: boolean;
  isWorktree: boolean;
  worktreePath: string | null;
  ahead: number;
  behind: number;
  dirty: number;
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** One file the session changed. `added` and `removed` are null for a binary file. */
export interface ChangedFile {
  path: string;
  status: FileStatus;
  added: number | null;
  removed: number | null;
  /** The old path of a renamed file. */
  from: string | null;
}

/**
 * What the session changed in its repository: the files (at most 200, by path) and the totals over
 * all of them. `since` says what the diff is against: the commit HEAD was at when the session began,
 * the merge base with the upstream branch when that commit is gone, or HEAD alone.
 */
export interface FilesReport {
  files: ChangedFile[];
  total: number;
  added: number;
  removed: number;
  since: 'start' | 'upstream' | 'worktree';
}

export interface RateLimit {
  kind: string;
  percentUsed: number;
  resetsAt: string | null;
}

export interface PlanStep {
  id: string;
  text: string;
  state: 'pending' | 'active' | 'done' | 'blocked';
  activeText: string | null;
  ownerAgentId: string | null;
  ownerLabel: string | null;
}

export interface Plan {
  title: string | null;
  source: 'TaskCreate' | 'TodoWrite' | 'podium_plan';
  steps: PlanStep[];
}

export interface Failure {
  class: FailureClass;
  at: number;
  tool: string | null;
  call: string | null;
  exitCode: number | null;
  outputTail: string[];
  evidence: string[];
  explanation: string | null;
  retriedAs: string | null;
}

/**
 * What the orchestrator's main loop reports about its own work, in the shapes an AgentReport uses for
 * the fields of the same name. Calls made by agents it launched are not counted here.
 */
export interface LoopReport {
  skills: string[];
  lastTool: string | null;
  toolCalls: number;
  toolCounts: Record<string, number>;
  steps: { done: number; total: null };
}

/** The loop key of the orchestrator's own feed, in the report reply's `watch` list and the activity route (#118). Engine agent ids never start with `@`. */
export const MAIN_LOOP = '@orchestrator';

/** The status of one file's diff, as the mod answers a request for it (#319, SPEC 6.4). */
export const FILE_DIFF_STATUSES = ['ok', 'binary', 'withheld', 'too-large', 'unavailable'] as const;
export type FileDiffStatus = (typeof FILE_DIFF_STATUSES)[number];

/** A diff the session's owner is waiting for, in the report reply's `diffs` list. */
export interface DiffRequest {
  id: string;
  path: string;
}

/** The mod's answer to a DiffRequest. `text` is a unified diff, redacted by the mod, and null for any status but `ok`. */
export interface FileDiffReply {
  path: string;
  status: FileDiffStatus;
  text: string | null;
  /** The mod cut the diff at a line or byte limit. */
  truncated: boolean;
  shownLines: number;
  totalLines: number;
  /** How many values the mod replaced with [redacted]. */
  redactions: number;
  /** What the diff is against: the short starting commit, the upstream merge base, or "worktree". null when there is none. */
  base: string | null;
}

/** `reasoning` is reserved for the model's thinking; the reporter does not send it. */
export type ActivityKind = 'tool' | 'text' | 'reasoning';

/**
 * One entry of a loop's activity feed (#118): a tool call (the tool's name, a space, and a short summary of its
 * arguments) or the text the model wrote in one step. Redacted and cut to 300 characters by the reporter. Sent only
 * with the `activityFeed` option on, and only for a loop the server's reply lists as watched.
 */
export interface ActivityEntry {
  at: number;
  kind: ActivityKind;
  text: string;
}

export interface AgentReport {
  id: string;
  parentId: string | null;
  kind: 'subagent' | 'fork' | 'teammate';
  type: string;
  name: string | null;
  description: string;
  model: string | null;
  effort: Effort | null;
  effortSource: 'requested' | 'observed' | 'inherited' | 'unknown';
  status: AgentStatus;
  startedAt: number;
  endedAt: number | null;
  context: ContextFill;
  tokens: TokenCounts;
  costUsdEst: number | null;
  /** Tokens per model and prompt-size tier. Absent when the reporter is too old to send it. */
  usageByModel?: ModelUsage[];
  skills: string[];
  lastTool: string | null;
  toolCalls: number;
  /** Finished calls per tool name. null when the reporter is too old to send it. */
  toolCounts: Record<string, number> | null;
  blowouts: number;
  steps: { done: number; total: number | null } | null;
  promptExcerpt: string;
  answerExcerpt: string | null;
  /**
   * The whole task prompt and final answer, redacted, line breaks kept. Sent only when the reporter's
   * `fullPrompts` option is on, and only once per text (the server keeps what it was given).
   */
  promptText?: string;
  answerText?: string;
  /** The agent's last 20 activity entries, oldest first: only while someone watches it, with the `activityFeed` option on (0.13.0 and later). */
  activity?: ActivityEntry[];
  failure: Failure | null;
}

export interface ActivityEvent {
  id: string;
  t: number;
  kind: EventKind;
  agentId: string | null;
  text: string;
  data: Record<string, unknown> | null;
}

/** What a session idle between turns is still waiting on: background work in flight, or a scheduled wake-up (#119). */
export type BackgroundKind = 'shell' | 'agent' | 'monitor' | 'workflow' | 'wakeup' | 'other';

export interface BackgroundTask {
  type: BackgroundKind;
  /** A short description; never a whole shell command. */
  description: string;
  status: string;
}

export interface BackgroundWait {
  tasks: BackgroundTask[];
  /** When the next scheduled wake-up fires (epoch ms); null when there is none or its time is unknown. */
  wakeAt: number | null;
}

export interface SessionReport {
  id: string;
  name: string;
  status: 'running' | 'waiting' | 'done';
  waitReason: 'permission' | 'input' | null;
  waitNote: string | null;
  endReason: string | null;
  resumeId: string | null;
  startedAt: number;
  cwd: string;
  projectRoot: string | null;
  repoName: string | null;
  git: GitInfo | null;
  model: string | null;
  effort: Effort | null;
  context: ContextFill;
  costUsd: number | null;
  tokens: TokenCounts;
  /** Tokens per model and tier for the whole session, agents included. Absent when the reporter is too old to send it. */
  usageByModel?: ModelUsage[];
  rateLimits: RateLimit[];
  blowouts: number;
  plan: Plan | null;
  /** The main loop's steps, tools and skills. null when the reporter is too old to send it. */
  loop: LoopReport | null;
  /** The files the session changed. null when the reporter is too old to send it. */
  files: FilesReport | null;
  /** Whether any client (a terminal, a phone) is attached. false for a background session left running after /exit. null when unknown: a reporter too old to send it. */
  attached: boolean | null;
  /** Background work the session is idle on. Absent from a reporter older than 0.11.0 and when there is none. */
  background?: BackgroundWait | null;
  /** Whether the reporter's `activityFeed` option is on. Absent from a reporter older than 0.13.0. */
  activityFeed?: boolean;
  /** Whether the reporter's `fileDiff` option is on (#319). Absent from a reporter older than the release that adds it. */
  fileDiff?: boolean;
  /** The main loop's last 20 activity entries, as on an agent: only while someone watches the orchestrator. */
  activity?: ActivityEntry[];
  /** Whether and how far the session can be answered from Podium (#206). Absent from a reporter older than 0.14.0. */
  respond?: RespondInfo;
  /** The asks open now, at most 8; sent only while the last reply said `respond: true`. */
  asks?: Ask[];
  /** The session id this one continues after a /clear (SPEC 5.8). */
  clearedFrom?: string | null;
  /** Whether the reporter's `peers` option is on (#347). Absent from a reporter older than the release that adds it, whose sessions are never listed as peers. */
  peers?: boolean;
  /** Whether the reporter's `sessionRecording` option is on (#353): the owner's consent to be recorded. Absent from a reporter older than the release that adds it. */
  sessionRecording?: boolean;
}

export interface Report {
  v: 1;
  sentAt: number;
  /** `build` is the commit hash of a dev build of the mod (#400). A release, and a mod that predates it, leave it out. */
  reporter: { name: 'podium-reporter'; version: string; engineVersion: string | null; hostSurface: string | null; build?: string | null };
  session: SessionReport;
  agents: AgentReport[];
  events: ActivityEvent[];
  /** The person this reporter is configured as. The server checks it against the token's owner and refuses a mismatch. Omitted or null when none is set. */
  userName?: string | null;
  /** The machine the session runs on. Sent only with a userName, so nothing identifying leaves an unnamed reporter. Omitted or null from a reporter older than 0.9.0. */
  machine?: MachineInfo | null;
}

/** Which machine a session runs on: its host name, and a random id the reporter keeps so two machines with one host name stay apart. */
export interface MachineInfo {
  name: string;
  id: string;
  /** The machine's OS and version as the mod read it, such as `macOS 27.0.1` (#347). Free text, never parsed; absent or null when it could not be read. */
  os?: string | null;
}
/** "1 shell, 1 agent": the counts of a background wait by kind. The activity feed's wait row is read from it. */
export function backgroundSummary(b: BackgroundWait): string {
  const n = new Map<string, number>();
  for (const t of b.tasks) n.set(t.type, (n.get(t.type) ?? 0) + 1);
  return [...n].map(([k, c]) => `${c} ${k}`).join(', ');
}

/** A waiting session whose only wait is on background work or a wake-up, not on the person (#119). */
export function idleOnBackground<T extends { status: string; waitReason: string | null; background?: BackgroundWait | null }>(s: T): s is T & { background: BackgroundWait } {
  return s.status === 'waiting' && s.waitReason === null && !!s.background;
}

// ---- Responding (#206, SPEC 5.3, 6.2, 7.1) --------------------------------------------------

/** The reporter's `respond` option: what this session accepts from Podium. */
export type RespondLevel = 'off' | 'questions' | 'questions-and-plans' | 'everything';
export const RESPOND_LEVELS: readonly RespondLevel[] = ['off', 'questions', 'questions-and-plans', 'everything'];

/** One kind of answer a session can take from Podium. */
export type RespondKind = 'question' | 'plan-approve' | 'plan-feedback' | 'permission' | 'message' | 'command';
export const RESPOND_KINDS: readonly RespondKind[] = ['question', 'plan-approve', 'plan-feedback', 'permission', 'message', 'command'];

/** Why a kind the level allows is missing from `accepts`. */
export type RespondLimit = 'no-permission-hooks' | 'not-interactive';
export const RESPOND_LIMIT_NAMES: readonly RespondLimit[] = ['no-permission-hooks', 'not-interactive'];

/** The kinds each level allows. Each level allows what the one before it does. */
export const LEVEL_KINDS: Record<RespondLevel, readonly RespondKind[]> = {
  off: [],
  questions: ['question', 'message'],
  'questions-and-plans': ['question', 'message', 'plan-approve', 'plan-feedback'],
  everything: ['question', 'message', 'plan-approve', 'plan-feedback', 'permission', 'command'],
};

/** Whether and how far a session can be answered from Podium (Report.session.respond). */
export interface RespondInfo {
  level: RespondLevel;
  /** What the session takes now: the level's kinds, less what `limits` removes; empty while the activityFeed option is off. */
  accepts: RespondKind[];
  limits: RespondLimit[];
}

/** The kinds a level allows once the limits are applied. */
export function acceptsFor(level: RespondLevel, limits: readonly RespondLimit[], activityFeed: boolean): RespondKind[] {
  if (!activityFeed || limits.includes('not-interactive')) return [];
  const drop: RespondKind[] = limits.includes('no-permission-hooks') ? ['plan-approve', 'permission'] : [];
  return LEVEL_KINDS[level].filter((k) => !drop.includes(k));
}

export type AskKind = 'question' | 'plan' | 'permission';

export interface AskOption {
  label: string;
  description: string;
  preview: string | null;
}

export interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}

/**
 * One thing a session waits on its person for that Podium can answer. Its id is the tool call's `tool_use_id`.
 * Redacted by the reporter, and cut to RESPOND_LIMITS with a visible marker.
 */
export interface Ask {
  id: string;
  kind: AskKind;
  /** The loop that asked: set for a subagent's permission prompt; null for the main loop. */
  agentId: string | null;
  openedAt: number;
  questions?: AskQuestion[];
  plan?: { text: string; filePath: string | null };
  /** The tool and its arguments; `cut` when anything was cut off, and then Podium cannot allow it. */
  tool?: { name: string; input: Record<string, unknown>; cut: boolean };
}

export const RESPOND_LIMITS = {
  asks: 8,
  questions: 4,
  options: 4,
  question: 1000,
  header: 40,
  label: 200,
  description: 1000,
  preview: 4000,
  plan: 40_000,
  toolInput: 20_000,
  /** A typed answer, a deny reason, a close's answer summary. */
  answer: 2000,
  /** A message, a reply in place of an answer, plan feedback. */
  message: 20_000,
  /** Messages and commands waiting for one session. */
  deliveries: 20,
  /** The longest a held request for an answer waits, in seconds ($.http.fetch gives up at 30). */
  holdSeconds: 20,
} as const;

/** What a delivery carries. `reply` is a message sent in place of an answer. */
export type DeliveryKind = 'question' | 'reply' | 'plan-approve' | 'plan-feedback' | 'allow-once' | 'deny' | 'message' | 'command';
export const DELIVERY_KINDS: readonly DeliveryKind[] = ['question', 'reply', 'plan-approve', 'plan-feedback', 'allow-once', 'deny', 'message', 'command'];

/** One question's answer by position: the chosen options' indexes, a typed answer, or null for skipped. */
export type QuestionAnswer = { options: number[] } | { text: string } | null;

export type PlanMode = 'auto' | 'acceptEdits' | 'default';
export const PLAN_MODES: readonly PlanMode[] = ['auto', 'acceptEdits', 'default'];

export type PodiumCommand = 'clear' | 'compact';
export const PODIUM_COMMANDS: readonly PodiumCommand[] = ['clear', 'compact'];

/** One answer or message sent from Podium, as the server hands it to the mod. */
export interface Delivery {
  id: string;
  /** The ask it answers; null for a message or a command. */
  askId: string | null;
  /** Who sent it: a person's name, or `Admin` for the admin secret. */
  by: string;
  at: number;
  kind: DeliveryKind;
  answers?: QuestionAnswer[];
  mode?: PlanMode;
  text?: string;
  command?: PodiumCommand;
}

/** What became of a delivery, as the mod reports it. */
export type DeliveryResult = 'took' | 'queued' | 'not-taken' | 'refused' | 'closed';
export const DELIVERY_RESULTS: readonly DeliveryResult[] = ['took', 'queued', 'not-taken', 'refused', 'closed'];

/** How an ask closed without an answer from Podium. */
export type AskCloseOutcome = 'terminal' | 'closed' | 'ended';

export interface AskClose {
  outcome: AskCloseOutcome;
  at: number;
  /** A short summary of the terminal's answer: a question's answers joined with "; ", `No, keep planning`, `allowed` or `denied`. */
  answer?: string | null;
  /** True for a plan approved in the terminal (which mode is not known). */
  planApproved?: boolean;
}

// ---- Orchestrator messaging (#347, SPEC 5.3, 6.2, 7.7) --------------------------------------

export const PEER_LIMITS = {
  /** The longest message the server takes; the Admin's limit is at most this. */
  message: 20_000,
  /** An orchestrator's reason when it asks for a right. */
  reason: 1000,
  /** A `to` address, `name@machine`. */
  address: 200,
  /** Peer deliveries in one reply. */
  deliveries: 20,
  /** Open requests in one reply. */
  requests: 20,
  /** The OS string in a report. */
  os: 80,
} as const;

/** A right one reporter has to another: none, can see, can send with approval (`ask`), can send. Sending includes seeing. */
export type PeerLevel = 'none' | 'see' | 'ask' | 'send';
export const PEER_LEVELS: readonly PeerLevel[] = ['none', 'see', 'ask', 'send'];

/** One orchestrator, as a message names its sender. */
export interface PeerParty {
  name: string;
  machine: string;
  owner: string;
  /** The sender's short session id, for `name@machine#id`; absent from a server older than #500. */
  id?: string;
}

/**
 * Something for this session's orchestrator from the messaging side, in the report reply. `message` is another
 * orchestrator's text, to be framed by the mod (SPEC 5.3); `notice` is Podium's own sentence about one of this
 * orchestrator's messages or requests (dropped, declined, answered), with `from` null. Its result goes to the peer
 * result route, never responding's.
 */
export interface PeerDelivery {
  id: string;
  kind: 'message' | 'notice';
  at: number;
  from: PeerParty | null;
  text: string;
}

/** What became of a peer delivery, as the mod reports it. */
export type PeerResult = 'took' | 'queued' | 'refused';
export const PEER_RESULTS: readonly PeerResult[] = ['took', 'queued', 'refused'];

/** A request the owner answers: an Admin's proposed right, an orchestrator's request for one, a message waiting for approval. */
export type PeerRequestKind = 'proposal' | 'access' | 'message';

/** How an owner answers a request: allow a proposal or an access request, deliver a message, or decline either. */
export type PeerAnswer = 'allow' | 'decline' | 'deliver';
export const PEER_ANSWERS: readonly PeerAnswer[] = ['allow', 'decline', 'deliver'];

/** One open request, as the owner's sessions on the machine it concerns are told of it. A reporter is named by its machine, an orchestrator by its name too. */
export interface PeerRequest {
  id: string;
  kind: PeerRequestKind;
  at: number;
  /** The reporter that would get the right, or the sender of a message. */
  from: { machine: string; name: string | null };
  /** The reporter the right is to, or the receiver of a message. */
  to: { machine: string; name: string | null };
  /** The right proposed or asked for; null for a message. */
  level: PeerLevel | null;
  /** Who asked: `Admin` for a proposal, the orchestrator's name for an access request or a message. */
  by: string;
  /** An orchestrator's reason, for an access request. */
  reason: string | null;
  /** The message's text, for a message waiting for approval. */
  text: string | null;
}

/** The reply to an accepted report. Older servers send only some of it. */
export interface ReportReply {
  ok: true;
  serverTime: number;
  ackedEvents: number;
  sessionId: string;
  liveSessions: number;
  serverVersion: string;
  /** The commit of a dev build of the server (#400); null for a release. Older servers do not send it. */
  serverBuild?: string | null;
  reporterSupport: { min: string; max: string };
  reporterCompat: 'ok' | 'outdated' | 'newer' | 'unknown';
  watch: string[];
  /** Whether the server takes answers for this session now; the mod announces asks only while it is true. */
  respond: boolean;
  /** Messages and commands from Podium waiting for this session, oldest first; empty while `respond` is false. */
  deliveries: Delivery[];
  /** Whether this session's orchestrator can take part in messaging now (#347): authentication on, the Admin's flag on, the session owned by a person, and the `peers` option on. */
  peers?: boolean;
  /** Messages and notices for this orchestrator, oldest first, handed over only while it is idle; empty while `peers` is false. */
  peerDeliveries?: PeerDelivery[];
  /** The owner's open requests about this session's reporter, for a toast and `/podium allow|decline|deliver`; empty while `peers` is false. */
  peerRequests?: PeerRequest[];
  /** Session recording's consent state for this session (#353). Absent from a server older than the release that adds it, which records nothing. */
  recording?: RecordingGrant;
}

/**
 * Session recording (#353, SPEC 6.4 "Session recording"). Everything an orchestrator and the agents under it do, whole, for
 * troubleshooting. Three yes answers are needed before anything leaves the machine: the Admin's `session-recording` flag,
 * a choice by the session's owner or an Admin, and the reporter's `sessionRecording` option (off by default).
 */
export const RECORDING_KINDS = ['prompt', 'text', 'tool', 'result', 'thinking', 'clear', 'compact', 'decision', 'gap', 'stopped', 'limit'] as const;
/**
 * What one recorded entry is. The mod writes `prompt` (a task prompt, a person's prompt or a message from Podium), `text` (what the
 * model wrote), `tool` (a call with its whole input), `result` (that call's whole output, `name` the tool, `failed` when it failed),
 * `thinking` (a mark where the model thought; its text is not available, see SPEC 6.4), `clear` and `compact` (the transcript was
 * emptied or compacted; `by` when Podium ran it), `decision` (an answer or approval sent from Podium and taken by Claude Code: `name`
 * is `question`, `plan` or `permission`, `callSeq` the call it answers, `by` who sent it, `failed` when it refused: a deny, a plan sent
 * back) and `gap` (`lost` entries never reached the server). The server writes `stopped` and `limit` itself.
 */
export type RecordingKind = (typeof RECORDING_KINDS)[number];

/** One recorded entry, as the mod sends it. `(loop, seq)` is the entry's identity: a resend of an entry the server holds is dropped. */
export interface RecordingEntry {
  /** The loop it belongs to: `@orchestrator` (MAIN_LOOP) or an agent id. */
  loop: string;
  /** Counts up from 1 per session and loop, assigned by the mod when the entry happens. */
  seq: number;
  /** When it happened on the machine, epoch ms. */
  at: number;
  kind: RecordingKind;
  /** The whole text, redacted on the machine and cut at RECORDING_LIMITS.text with a visible marker. An empty string for `thinking`, `clear`, `compact` and `gap`. */
  text: string;
  /** The tool's name, for `tool` and `result`. */
  name?: string;
  /** The `seq` of the `tool` entry a `result` answers, in the same loop. */
  callSeq?: number;
  /** A `result` of a call that failed. */
  failed?: boolean;
  /** The text was cut at the limit. */
  cut?: boolean;
  /** For `gap`: how many entries of this loop were dropped on the machine (the queue was full during an outage). */
  lost?: number;
  /** For `decision`, `clear` and `compact`: who sent it from Podium. Taken from the mod for these kinds only; a `prompt` is marked by the server (SPEC 6.4). */
  by?: string;
}

/** What one request to the recording route carries. The mod splits a larger backlog so each request stays within RECORDING_LIMITS.bodyBytes. */
export interface RecordingBatch {
  v: 1;
  sentAt: number;
  /** Oldest first. At most RECORDING_LIMITS.entries. */
  entries: RecordingEntry[];
}

/** The server's answer to a batch. A batch that was accepted is never sent again. */
export interface RecordingBatchReply {
  ok: true;
  /** How many entries were new; the rest were already held. */
  stored: number;
  /** The state after this batch, so a cap reached by it stops the mod at once. */
  recording: RecordingGrant;
}

export const RECORDING_STATES = ['off', 'recording', 'stopped', 'limit'] as const;
/** `off`: nothing is chosen. `recording`: capturing. `stopped`: capture ended and what was recorded is kept. `limit`: the per-session cap or the disk budget stopped it. */
export type RecordingState = (typeof RECORDING_STATES)[number];

/** Which cap stopped a recording. */
export type RecordingLimit = 'session' | 'budget';

/** The three yes answers. Capture needs all three. */
export interface RecordingConsent {
  /** The Admin's `session-recording` flag is on and the server has authentication on. */
  admin: boolean;
  /** Someone with the right (the session's owner or an Admin) chose to record this session. */
  chosen: boolean;
  /** The session's last report said the `sessionRecording` option is on. */
  owner: boolean;
}

/**
 * The consent state in a report's reply (`recording`) and in a batch's. The mod captures only while `state` is `recording` and
 * every `consent` answer is true, and only the loops in `loops`. When `chosen` is true but `owner` is false it captures nothing and
 * tells the owner so in the terminal. It is sent in every reply while a recording is chosen or kept, and `state: "off"` otherwise.
 */
export interface RecordingGrant {
  state: RecordingState;
  consent: RecordingConsent;
  /** The loops to capture (`@orchestrator` or agent ids). A loop that starts later under a recorded session is not in it until chosen. */
  loops: string[];
  limit: RecordingLimit | null;
  /** Who chose it (a person's name, or `Admin`), for the terminal text and the notice. */
  startedBy: string | null;
  startedAt: number | null;
  /** Who stopped it and when, once `state` is `stopped`. */
  stoppedBy: string | null;
  stoppedAt: number | null;
  /** When the oldest part still kept goes, epoch ms; null when nothing is kept. */
  keptUntil: number | null;
  /** The recording's size so far, in bytes. */
  bytes: number;
}

/** Limits for session recording. Sizes were set from a simulated-traffic measurement (#353, SPEC 6.4 "Measured write load"); the Admin's values are in RECORDING_DEFAULTS. */
export const RECORDING_LIMITS = {
  /** Entries in one batch. */
  entries: 200,
  /** Characters of one entry's text; the mod's cut-off marker comes on top (room for it is added on the server). */
  text: 100_000,
  /** Serialized bytes of one batch, below the 512 KB body limit with room for JSON escaping. */
  bodyBytes: 480_000,
  /** Bytes the mod queues while the server cannot be reached. Past it the oldest entries go and a `gap` entry says how many. */
  queueBytes: 8_000_000,
  /** Rows of one replay page, and the most a request may ask for. */
  page: 200,
} as const;

/** What the Admin sets, one JSON row `recording_settings` in `settings`. Defaults set from measurement (#353). */
export interface RecordingSettings {
  /** How long each part is kept, counted from when it was recorded. */
  keepHours: number;
  /** Disk budget for all recordings, in megabytes. At this size every recording stops, and a new one needs room for one more request (SPEC 7.7). */
  budgetMb: number;
  /** Limit for one session, in megabytes. A recording stops when its session reaches it. */
  sessionMb: number;
}
export const RECORDING_DEFAULTS: RecordingSettings = { keepHours: 6, budgetMb: 4096, sessionMb: 512 };
/** Whole numbers. `keepHours` is at most 7 days. */
export const RECORDING_RANGES = { keepHours: { min: 1, max: 168 }, budgetMb: { min: 64, max: 102_400 }, sessionMb: { min: 8, max: 4096 } } as const;

/** What a person with the right sends to start (or change) a recording: the loops to record from now on. Nothing before it is kept. */
export interface RecordingStartRequest {
  loops: string[];
}

/**
 * One stored entry as the replay reads it. `n` is the server's order; the server's own `stopped` and `limit` entries carry `by`.
 * `seq` is the entry's own number within its loop (the mod's, from 1; 0 and below for a mark the server wrote), which a result's
 * `callSeq` names.
 */
export interface RecordingRow {
  n: number;
  seq: number;
  loop: string;
  at: number;
  kind: RecordingKind;
  text: string;
  name?: string;
  callSeq?: number;
  failed?: boolean;
  cut?: boolean;
  lost?: number;
  by?: string | null;
}

/** A loop the layer and the replay's loop filter name, with whether it is recorded. */
export interface RecordingLoopInfo {
  loop: string;
  name: string;
  recorded: boolean;
}

/** One page of a replay, oldest first: the newest `RECORDING_LIMITS.page` rows, then older ones with `before` = `olderBefore`. */
export interface RecordingPage {
  entries: RecordingRow[];
  /** The `n` to pass as `before` for the next older page, or null. */
  olderBefore: number | null;
  total: number;
  grant: RecordingGrant;
  loops: RecordingLoopInfo[];
  /** The session's owner, for the refusal a viewer who may not read it is shown. */
  owner: string | null;
}

/** A row of the Admin's Recordings table. */
export interface RecordingAdminRow {
  sessionId: string;
  name: string;
  owner: string | null;
  startedBy: string | null;
  state: RecordingState;
  limit: RecordingLimit | null;
  /** How many loops are recorded, and a short label such as "orchestrator and 3 agents". */
  loops: number;
  label: string;
  bytes: number;
  keptUntil: number | null;
}

/**
 * What everyone sees of a recording (#353): the card's band and the orchestrator page's layer. State, who started it, which loops
 * and when it goes; never any text. `SessionView.recording` is this, or null when nothing is chosen or kept.
 */
export interface RecordingView {
  state: Exclude<RecordingState, 'off'>;
  limit: RecordingLimit | null;
  startedBy: string | null;
  startedAt: number | null;
  stoppedBy: string | null;
  stoppedAt: number | null;
  keptUntil: number | null;
  bytes: number;
  /** Every loop of the session, with whether it is recorded; the layer names both groups in words. */
  loops: RecordingLoopInfo[];
  /** Whether the reporter's `sessionRecording` option is on. False while the recording is chosen means nothing is being captured. */
  ownerAllows: boolean;
}

// <protocol:end>
