// The neutral vocabulary of the storage interfaces (#313): row shapes, errors, constants and pure helpers. App code imports them
// from here (or `types.ts`), never from an adapter's folder, so no database adapter is named outside its own folder.
import type { ReporterCompat, PeerLevel, PeerDelivery, PeerRequest, RecordingSettings, RecordingLimit, RecordingState } from '../fleet/protocol.js';
import type { OwnerDefaults, RightRow, SeenReporterRef, OwnerRequestView, EffectiveRight, ReporterRef } from '../fleet/peerTypes.js';
import type { ActivityHistorySettings } from '../fleet/activityHistoryTypes.js';
import type { PeerLimits } from './settings.js';

export type PeopleErrorCode = 'duplicate' | 'invalid' | 'not_found';

export class PeopleError extends Error {
  constructor(readonly code: PeopleErrorCode, message: string) {
    super(message);
  }
}

export const MAX_PAGE_SIZE = 100;

export const DEFAULT_PAGE_SIZE = 50;

/** The owner of a session reported with the admin secret. */
export const ADMIN_OWNER = 'Admin';

/** The built-in group (issue #172) whose members can open Admin with their own token. It cannot be deleted. */
export const ADMINISTRATORS_GROUP = 'Administrators';

/** The actor the Admin log records for a change made with the admin secret. */
export const ADMIN_SECRET_ACTOR = 'Admin secret';

export interface PersonRow {
  id: number;
  name: string;
  keyId: string;
  tokenHash: string;
  groupId: number | null;
  createdAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
  lastReportAt: number | null;
}

export interface PersonListRow extends Omit<PersonRow, 'tokenHash' | 'keyId'> {
  /** `pdm_<key id>`, the way Reporters names a token (#218). The key id only finds a person; it is not a secret. */
  credential: string;
  groupName: string | null;
  machines: string[];
}

export interface GroupListRow {
  id: number;
  name: string;
  createdAt: number;
  members: string[];
  /** True for Administrators: it cannot be deleted, and the admin secret is always a member. */
  builtIn: boolean;
}

export interface LogRow {
  id: number;
  t: number;
  kind: string;
  detail: string;
  source: string;
  /** The person who made the change, 'Admin secret' for the secret; null for a row from before this was recorded. */
  actor: string | null;
}

export interface Paged<T> {
  total: number;
  page: number;
  pageSize: number;
  rows: T[];
}

export interface PageIn {
  page: number;
  pageSize: number;
}

/** A name as it is compared: spaces collapsed, case ignored. */
export const nameKey = (raw: string): string => raw.trim().replace(/ +/g, ' ').toLowerCase();

/** A request's source address without the IPv4-mapped IPv6 prefix. */
export const sourceAddress = (ip: string | undefined): string => (ip ?? 'unknown').replace(/^::ffff:/, '');

/** A reporter heard from within this long is "reporting". */
export const REPORTING_MS = 2 * 60_000;

/** Up to this long since its last report it is "idle"; after that, "silent". */
export const IDLE_MS = 60 * 60_000;

export type ReporterState = 'reporting' | 'idle' | 'silent' | 'restart';

export const REPORTER_STATES: readonly ReporterState[] = ['reporting', 'idle', 'silent', 'restart'];

export type ReporterSort = 'state' | 'name' | 'who' | 'token' | 'ver' | 'last' | 'sessions';

/** The credential the server records for a report made with the admin secret. */
export const ADMIN_SECRET = 'admin secret';

/** The name every reporter sent before a second one existed: the Claude Code reporter, and what a row from before the name was stored holds (#849). */
export const DEFAULT_REPORTER_NAME = 'podium-reporter';

/** What one accepted report says about its sender. Never a token: `credential` is a key id or the words "admin secret". */
export interface ReporterSeen {
  kind: 'mod' | 'hooks';
  /** Which reporter sent it (`reporter.name` of the report). Absent means `DEFAULT_REPORTER_NAME`. A machine running two reporters is two rows (#849). */
  reporterName?: string;
  machineId: string | null;
  machineName: string | null;
  source: string | null;
  owner: string | null;
  credential: string | null;
  version: string;
  engineVersion: string | null;
  sessionId: string;
  /** The machine's OS as the mod read it (#347); absent or null when not sent, and then the stored one is kept. */
  os?: string | null;
  /** The reporter's `peers` option (#347); absent or null from a reporter too old to send it, and then the stored one is kept. */
  peers?: boolean | null;
}

export interface ReporterRow {
  key: string;
  state: ReporterState;
  name: string;
  /** False when the reporter sends no machine name and `name` is made up from its newest project or its address (issue #166). */
  named: boolean;
  who: string;
  /** The token's key id (`pdm_...`) or the words "admin secret"; null when the server had no authentication. Never a token. */
  credential: string | null;
  /** True when it reports with the admin secret instead of a token made for a person (issue #166). Always warned about. */
  adminSecret: boolean;
  version: string;
  /** Which reporter this row is: `podium-reporter` for the Claude Code one (#849). */
  reporterName: string;
  compat: ReporterCompat;
  firstSeenAt: number;
  lastSeenAt: number;
  sessions: number;
  live: number;
  /** The machine's OS as last reported (#347); null when it never sent one. */
  os: string | null;
  /** The `peers` option as last reported (#347); null from a reporter too old to send it. */
  peers: boolean | null;
}

export interface ReporterList extends Paged<ReporterRow> {
  /** When this server started: what "not since restart" is counted from. */
  serverStartedAt: number;
  /** How many reporters use the admin secret, whatever filter is on. */
  adminSecret: number;
  counts: Record<'all' | ReporterState, number>;
}

export interface ReporterDetail extends ReporterRow {
  serverStartedAt: number;
  kind: 'mod' | 'hooks';
  machineId: string | null;
  source: string | null;
  engineVersion: string | null;
  recent: { id: string; name: string; status: string; lastSeenAt: number; costUsd: number | null }[];
  /** How many of its sessions the server still holds, and which page of them `recent` is. */
  recentTotal: number;
  recentPage: number;
  recentPageSize: number;
  rejected: { t: number; reason: string }[];
}

export type IgnoreKind = 'key' | 'address' | 'version';

export const IGNORE_KINDS: readonly IgnoreKind[] = ['key', 'address', 'version'];

export interface IgnoreRule {
  id: number;
  kind: IgnoreKind;
  pattern: string;
  createdAt: number;
}

/** What a rule is matched against: a reporter's key, source address and reporter version. */
export interface IgnoreTarget {
  key: string;
  /** Other keys the same sender is known by, so a rule on the row's key still matches after the sender changes address (#166). */
  otherKeys?: string[];
  source: string | null;
  version: string;
}

export interface ForgetSetting {
  enabled: boolean;
  days: number;
}

export interface SessionRow {
  id: string;
  name: string;
  status: 'running' | 'waiting' | 'done';
  wait_reason: string | null;
  wait_note: string | null;
  end_reason: string | null;
  resume_id: string | null;
  started_at: number;
  last_seen_at: number;
  ended_at: number | null;
  dropped_at: number | null;
  cwd: string;
  project_root: string | null;
  repo_name: string | null;
  git_json: string | null;
  model: string | null;
  effort: string | null;
  context_tokens: number | null;
  context_window: number | null;
  context_percent: number | null;
  cost_usd: number | null;
  tok_in: number;
  tok_out: number;
  tok_cr: number;
  tok_cw: number;
  rate_limits_json: string | null;
  blowouts: number;
  plan_json: string | null;
  /** The last plan stored, while the latest report carries none (#465); NULL otherwise. */
  plan_kept_json?: string | null;
  reporter_version: string | null;
  reporter_build?: string | null;
  engine_version: string | null;
  loop_json: string | null;
  files_json: string | null;
  background_json: string | null;
  usage_json: string | null;
  attached: number | null;
  detached_at: number | null;
  owner: string | null;
  machine_json: string | null;
  /** The session this one continues after a /clear (Report.session.clearedFrom, #206); NULL otherwise. */
  cleared_from: string | null;
  /** The harness that runs the session (#851): `claude-code`, `opencode` and so on. Rows from before it was stored read `claude-code`. */
  harness: string;
  /** `harness` when the cost is the harness's own figure, which Podium never reprices; NULL when Podium priced it from the tokens. */
  cost_source: string | null;
}

export interface AgentRow {
  session_id: string;
  id: string;
  parent_id: string | null;
  kind: string;
  type: string;
  name: string | null;
  description: string;
  model: string | null;
  effort: string | null;
  effort_source: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
  context_tokens: number | null;
  context_window: number | null;
  context_percent: number | null;
  tok_in: number;
  tok_out: number;
  tok_cr: number;
  tok_cw: number;
  cost_usd_est: number | null;
  skills_json: string | null;
  last_tool: string | null;
  tool_calls: number;
  tool_counts_json: string | null;
  usage_json: string | null;
  blowouts: number;
  steps_done: number | null;
  steps_total: number | null;
  prompt_excerpt: string | null;
  answer_excerpt: string | null;
  failure_json: string | null;
  /** Read side only (getAgents): the length of the stored full text, null when there is none. */
  prompt_chars?: number | null;
  answer_chars?: number | null;
}

export interface EventRow {
  id: string;
  session_id: string;
  agent_id: string | null;
  t: number;
  kind: string;
  text: string;
  data_json: string | null;
}

export interface BlowoutRow {
  id: number;
  session_id: string;
  agent_id: string | null;
  t: number;
  kind: string;
  tokens_before: number | null;
  tokens_after: number | null;
}

export interface SampleRow {
  session_id: string;
  t: number;
  tokens_total: number;
  tokens_delta: number;
  peak_context: number;
  running_agents: number;
  cost_usd: number | null;
  /** The session's `usage_json` when the sample was taken; absent or NULL when the reporter sent none. */
  usage_json?: string | null;
}

/** A sample's `usage_json` when the usage is the same as the sample before's (issue #270). */
export const SAME_USAGE = '=';

/** What a cost query reads of a session row. */
export interface CostRow {
  cost_usd: number | null;
  usage_json: string | null;
}

export type CostOf = (row: CostRow) => number | null;

/** One session's share of the spend since some moment (`sessionSpendSince`). */
export interface SessionSpend {
  id: string;
  name: string;
  model: string | null;
  owner: string | null;
  grp: string | null;
  usd: number;
  priced: boolean;
  usageJson: string | null;
  /** When the session was last heard from. */
  lastSeenAt: number;
  /** What the whole session cost with the given prices (not just its share since `since`); null when it has no price. */
  whole: number | null;
}

export interface RetentionPolicy {
  samplesMs: number;
  eventsMs: number;
  sessionsMs: number;
  /** Admin log rows older than this go, except the newest `ADMIN_LOG_KEEP` (#303). */
  adminLogMs: number;
  /** Daily rollup rows older than this go (#484); 395 days when absent. */
  rollupMs?: number;
}

/** How long a daily rollup row is kept by default: a year and a month, so a year-on-year look still has its month (#484). */
export const ROLLUP_KEEP_MS = 395 * 86_400_000;

/** The admin log always keeps this many of its newest rows, however old, so a quiet server keeps some history. */
export const ADMIN_LOG_KEEP = 100;

/** A level in the words My reporters and the terminal use. */
export const LEVEL_WORDS: Record<PeerLevel, string> = { none: 'No access', see: 'Can see', ask: 'Can send, with approval', send: 'Can send' };

/** What a report's reply carries for messaging (SPEC 6.1). */
export interface PeerReply {
  peers: boolean;
  peerDeliveries: PeerDelivery[];
  peerRequests: PeerRequest[];
}

/** What `ownerView` gives the owner's read: the parts of GET /respond/peers that come from the stores. */
export interface OwnerPeersView {
  serverStartedAt: number;
  reporters: SeenReporterRef[];
  rights: RightRow[];
  defaults: OwnerDefaults;
  limits: { server: PeerLimits; effective: PeerLimits };
  requests: OwnerRequestView[];
}

/** What `adminView` gives Admin > Reporters > a reporter. */
export interface AdminPeersView {
  reporter: ReporterRef;
  peers: ReporterRef[];
  trust: boolean;
  rights: RightRow[];
  effective: ({ from: string; to: string } & EffectiveRight)[];
  requests: OwnerRequestView[];
}

/** What the Stored activity table shows about a session. */
export interface SessionMeta {
  name: string;
  project: string | null;
  owner: string | null;
}

export interface ActivityHistoryOpts {
  now: () => number;
  /** The Admin's choice, read on every call so a change takes effect at once. */
  settings: () => ActivityHistorySettings;
  /** Whether the `activity-feed` flag is on. Off, nothing is captured. */
  featureOn?: () => boolean;
  /** Whether the session is on the wall (running or waiting). Policy `end` removes the rest. */
  isLive: (sessionId: string) => boolean;
  /** The ids of the session's running agents, for the loops the server asks the mod to send. */
  agentsOf?: (sessionId: string) => string[];
  /** Whether the server runs with a sign-in token. Nothing is kept without one. */
  authOn: boolean;
  /** Bytes in a gigabyte for the size cap; tests lower it. */
  capBytesPerGb?: number;
  /** Rows deleted per transaction in a purge or delete; about 5,000 keeps one chunk well under 100 ms. Tests lower it. */
  chunkRows?: number;
  /** How long one chunk of a removal should take, in milliseconds; the chunk size follows it, up to `chunkRows`. */
  chunkMs?: number;
  /** Entries counted per slice when a filter on the time or loop of entries is worked out for a session. Tests lower it. */
  sliceRows?: number;
  /**
   * Runs one synchronous step of a chunked operation (a chunk, a slice, a settle). The storage adapter takes the file's lock
   * here, so another caller runs between two steps exactly where the event loop used to get a turn. Without it a step runs at once.
   */
  step?: <T>(fn: () => T) => Promise<T>;
}

/** What one purge run removed. `bytes` is the size of the entries; `freed` is what the file gave back after compaction. */
export interface PurgeResult {
  entries: number;
  bytes: number;
  sessions: number;
  freed: number;
}

/** What the Stored activity table and the Admin's table show about a session. */
export interface RecordingMeta {
  name: string;
  project: string | null;
  owner: string | null;
}

export interface RecordingsOpts {
  now: () => number;
  /** The Admin's limits, read on every call so a change takes effect at once. */
  settings: () => RecordingSettings;
  /** Whether the `session-recording` flag is on. */
  flagOn: () => boolean;
  /** Whether the server runs with a sign-in token. Nothing is recorded without one. */
  authOn: boolean;
  /** Whether the session is on the wall (running, waiting or lingering). A recording that is not live is not capturing. */
  isLive: (sessionId: string) => boolean;
  /** Every loop of the session with the name the layer shows. */
  loopsOf: (sessionId: string) => { loop: string; name: string }[];
  /** Credentials of this server, replaced wherever they appear in a stored entry. */
  secrets?: () => readonly string[];
  /** Runs a heavy operation one at a time with the Activity history's own, and gives the file's freed space back. */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
  compact?: () => Promise<number>;
  /** Rows deleted per transaction in a purge or delete. Tests lower it. */
  chunkRows?: number;
  /** Runs one synchronous step of a chunked operation; the storage adapter takes the file's lock here. Without it a step runs at once. */
  step?: <T>(fn: () => T) => Promise<T>;
}

/** What happened to a recording that the Admin log should hear of and the routes did not cause. */
export type RecordingTrail =
  | { kind: 'limit'; sessionId: string; which: RecordingLimit; bytes: number }
  | { kind: 'stopped'; sessionId: string; by: string }
  | { kind: 'carried'; sessionId: string; from: string; by: string | null };

export interface RecordingTotals {
  recordings: number;
  bytes: number;
  running: number;
}

export interface RemoveResult {
  entries: number;
  sessions: number;
  bytes: number;
  freed: number;
  /** One per recording removed, for the Admin log. */
  each: { sessionId: string; name: string; entries: number; bytes: number }[];
}

export interface PurgeRecordingsResult {
  entries: number;
  bytes: number;
  sessions: number;
  freed: number;
}

export type StoredState = Exclude<RecordingState, 'off'>;

/** The key a reporter is known by. */
export function keyOf(s: Pick<ReporterSeen, 'kind' | 'machineId' | 'source' | 'reporterName'>): string {
  const base = s.machineId ? s.machineId : `${s.kind === 'hooks' ? 'hooks' : 'addr'}:${s.source ?? 'unknown'}`;
  return base + nameSuffix(s.reporterName);
}

/**
 * What a reporter's name adds to its key (#849): nothing for the Claude Code reporter, so every key and ignore rule made before
 * the name was stored stays valid, and `@<name>` for any other, so two reporters on one machine are two rows.
 */
export function nameSuffix(reporterName: string | undefined | null): string {
  return !reporterName || reporterName === DEFAULT_REPORTER_NAME ? '' : `@${reporterName}`;
}

export * from './features.js';
export * from './settings.js';
