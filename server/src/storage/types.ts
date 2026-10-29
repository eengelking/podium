// The async storage interfaces (#313). Every method of the stores keeps its name, arguments and result, and returns a Promise.
// Each interface is written out here and imports nothing from an adapter, so another database implements this file alone; an
// adapter proves it does by being typed against these interfaces, and a signature that drifts is a compile error there.
import type { Actor, AccessOutcome, AnswerOutcome, ConversationSummary, EffectiveRight, LeftOut, LiveOrchestrator, MachineName, MessageRow, MessageTrail, OwnerDefaults, PeerListing, PeerReporterLookup, PeerRequestRow, Refusal, RightRow, RightsTrail, SendOutcome } from '../fleet/peerTypes.js';
import type { ModelPricesView, PeerAnswer, PeerLevel, PeerResult, RecordingAdminRow, RecordingBatch, RecordingGrant, RecordingLoopInfo, RecordingRow, RecordingSettings, RecordingState, RecordingView, Report, WallSettingsView } from '../fleet/protocol.js';
import type { ActivityEntryView } from '../fleet/activity.js';
import type { ActivityHistoryNote, ActivityHistoryPreview, ActivityHistorySettings, LastPurge, StoredActivityList, StoredDeleteBody, StoredDeleteResult, StoredFilter, StoredTotals } from '../fleet/activityHistoryTypes.js';
import type { ModelPrice, Pricing, PriceOverrides } from '../fleet/pricing.js';
import type { ServingSettings } from '../tlsRenew.js';
import type { ReporterSettings } from '../tlsReporterRenew.js';
import type { CertToStore, PersonCertRow } from '../tlsClientAuth.js';
import type { ReportQueries } from './reportQueries.js';
import type {
  AdminPeersView, ActivityHistoryOpts, AgentRow, BlowoutRow, CostOf, EventRow, ForgetSetting, GroupListRow, IgnoreKind, IgnoreRule, IgnoreTarget, LogRow, Paged,
  PeerReply, PeerServerSettings, PersonListRow, PersonRow, PurgeRecordingsResult, RecordingMeta, RecordingTotals, RecordingsOpts, RemoveResult, ReporterDetail, ReporterList,
  ReporterSeen, ReporterState, RetentionPolicy, SampleRow, SessionRow, SessionSpend, StoredState, OwnerPeersView, PageIn, PurgeResult, SessionMeta, RecordingTrail,
} from './rows.js';
import type { PeerLimits } from './settings.js';

/** A function becomes one returning a Promise of the same result; anything else is kept. Used only over the neutral interfaces below. */
export type Async<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : T[K];
};

/** Sessions, agents, events, blowouts, samples and spend (the synchronous `FleetDb` of before, now async), and the report and rollup queries (#484). */
export interface FleetStoreApi {
  upsertSession(row: SessionRow): Promise<void>;
  getSession(id: string): Promise<SessionRow | undefined>;
  /** Sessions that may be in the live set: not dropped, and either not ended or ended after `endedAfter`. */
  liveCandidates(endedAfter: number): Promise<SessionRow[]>;
  setDropped(id: string, at: number): Promise<void>;
  deleteSession(id: string): Promise<boolean>;
  /** The session that continued `id` after a /clear, if any (the newest when there are several). */
  clearedInto(id: string): Promise<string | null>;
  /** Sessions that ended (or were dropped) in [from, to). */
  endedBetween(from: number, to: number): Promise<SessionRow[]>;
  /**
   * Every session's share of the spend at or after `since`, in the order `costTodayByOwner` adds them, so a cut of it adds up
   * to the same total (#482). `priced` is false when the session has no price (its `usd` is then 0).
   */
  sessionSpendSince(since: number, cost?: CostOf): Promise<SessionSpend[]>;
  /** Σ cost_usd_est of the agents of each session `spendSince(since)` looks at, repriced with `cost`; a session with no agents is not in the map. */
  agentCostsSince(since: number, cost: CostOf): Promise<Map<string, number>>;
  /** Σ spend at or after `since`. */
  costSince(since: number, cost?: CostOf): Promise<number>;
  /** `costSince` split by owner, with the group each owner is in (Admin, no owner and no group give null), largest first. */
  costByOwnerSince(since: number, cost?: CostOf): Promise<{ owner: string | null; group: string | null; costUsd: number }[]>;
  /** `costSince` and `costByOwnerSince` from one pass over the sessions, so the total is the sum of the split. */
  spendTotals(since: number, cost?: CostOf): Promise<{ total: number; byOwner: { owner: string | null; group: string | null; costUsd: number }[] }>;
  /** The group a session owner is in; null for Admin, an unknown name or a person with no group. */
  groupOfOwner(owner: string | null): Promise<string | null>;
  distinctReporterVersions(): Promise<string[]>;
  upsertAgent(row: AgentRow): Promise<void>;
  getAgents(sessionId: string): Promise<AgentRow[]>;
  /** Keeps the full texts a report carried; a text the report leaves out is left as it was. */
  upsertAgentTexts(sessionId: string, agentId: string, t: { prompt?: string; answer?: string }): Promise<void>;
  getAgentTexts(sessionId: string, agentId: string): Promise<{ prompt: string | null; answer: string | null } | null>;
  /** Marks every running or queued agent of a session aborted. */
  abortOpenAgents(sessionId: string, at: number): Promise<void>;
  /** Inserts an event unless its id exists. Resolves true when it was new. */
  insertEvent(row: EventRow): Promise<boolean>;
  /** Newest first. `before` is exclusive on event time. */
  listEvents(opts: { sessionId?: string | null; before?: number | null; limit: number }): Promise<EventRow[]>;
  countEvents(sessionId?: string): Promise<number>;
  insertBlowout(row: Omit<BlowoutRow, 'id'>): Promise<void>;
  getBlowouts(sessionId: string): Promise<BlowoutRow[]>;
  countBlowouts(sessionId?: string): Promise<number>;
  /** The latest sample strictly before second `t`. */
  sampleBefore(sessionId: string, t: number): Promise<SampleRow | undefined>;
  latestSample(sessionId: string): Promise<SampleRow | undefined>;
  /** Writes the sample for second `t`, replacing one already there (at most one per second). */
  upsertSample(row: SampleRow): Promise<void>;
  /** Writes a sample only if that second has none yet. */
  insertSampleIfAbsent(row: SampleRow): Promise<void>;
  samplesSince(sessionId: string, fromT: number): Promise<SampleRow[]>;
  /** Σ tokens_delta per second across all sessions, for seconds >= fromT. */
  fleetTokensPerSecond(fromT: number): Promise<{ t: number; v: number }[]>;
  /** Positive cost increase per minute across all sessions, for seconds >= fromT (minute = floor(t/60)). */
  fleetCostPerMinute(fromT: number, cost?: CostOf): Promise<{ m: number; v: number }[]>;
  /** Deletes old samples, events, ended sessions (with their rows) and admin log rows. Resolves with what was deleted. */
  retain(now: number, p: RetentionPolicy): Promise<{ samples: number; events: number; sessions: number; adminLog: number }>;
}

/** The fleet store and the report and rollup queries behind Admin > Reporting. */
export type FleetStore = FleetStoreApi & Async<ReportQueries>;

/** People, groups, the admin log and the settings they own. */
export interface PeopleStoreApi {
  createPerson(rawName: string, groupId?: number | null, now?: number): Promise<{ person: PersonRow; token: string }>;
  getPerson(id: number): Promise<PersonRow | undefined>;
  findByKeyId(keyId: string): Promise<PersonRow | undefined>;
  findByName(name: string): Promise<PersonRow | undefined>;
  /** New token for a person; the old one stops working and a revoked person is restored. Null if no such person. */
  rotate(id: number, now?: number): Promise<{ person: PersonRow; token: string } | null>;
  /** Lifts a revocation without touching the token, as a certificate reissue does. True if the person was revoked. */
  restore(id: number): Promise<boolean>;
  revoke(id: number, now?: number): Promise<boolean>;
  /**
   * Rejects, changing nothing, when `id` is the only active member of Administrators: revoking their token would leave nobody
   * who can sign in to Admin with a name and a token (#583). A person outside the group, or already revoked, is fine.
   */
  assertNotLastAdministrator(id: number): Promise<void>;
  /**
   * Deletes these people in one step (#243); unknown ids are skipped. Their machines go with them. Sessions, spend and
   * Admin log entries keep the name as text. Refuses, deleting nobody, if it would leave Administrators empty.
   * Resolves with the people it removed.
   */
  deleteMany(ids: number[]): Promise<PersonRow[]>;
  /**
   * Records a report from a person: the time and the machine it came from. A machine that sent an id is listed once as
   * `name (first four of id)`; one that did not is listed by its source address. The list is bounded (#379).
   */
  touch(personId: number, address: string | null, now: number, machine?: { name: string; id: string } | null): Promise<void>;
  setGroup(personId: number, groupId: number | null): Promise<boolean>;
  list(opts: Partial<PageIn> & { q?: string }): Promise<Paged<PersonListRow>>;
  createGroup(rawName: string, now?: number): Promise<{ id: number; name: string }>;
  getGroup(id: number): Promise<{ id: number; name: string } | undefined>;
  /** Deletes a group. Its people stay and move to no group. */
  deleteGroup(id: number): Promise<boolean>;
  listGroups(opts: Partial<PageIn>): Promise<Paged<GroupListRow>>;
  /** Every group, for the pick list on the People tab (groups are few; people are paged). */
  allGroups(): Promise<{ id: number; name: string; builtIn: boolean }[]>;
  administratorsGroupId(): Promise<number | null>;
  /** True when the person exists, their token is not revoked and they are in Administrators. */
  isAdministrator(personId: number): Promise<boolean>;
  /** The administrator a presented token belongs to, or undefined (unknown, revoked, wrong token or not in Administrators). */
  findAdministratorByToken(token: string): Promise<PersonRow | undefined>;
  adminReportingAllowed(): Promise<boolean>;
  setAdminReporting(on: boolean): Promise<void>;
  /** Never pass a token or the admin secret in `detail`. */
  log(kind: string, detail: string, source: string, now?: number, actor?: string | null): Promise<void>;
  listLog(opts: Partial<PageIn>): Promise<Paged<LogRow>>;
}

/** The reporter lookup the peer service reads; the same shape as `PeerReporterLookup` with async methods. */
export type AsyncPeerReporterLookup = Async<PeerReporterLookup>;

/** Reporters, ignore rules and the forget setting. `peerLookup()` stays synchronous: it reads nothing until a method is called. */
export interface ReporterStoreApi {
  /** Every key a report from this sender can be known by: its own, and the row that already holds its session (#166). */
  keysFor(s: Pick<ReporterSeen, 'kind' | 'machineId' | 'source' | 'sessionId'> & { owner?: string | null }): Promise<string[]>;
  /** Notes one accepted report: creates the reporter or updates it, and links the session. Resolves with the reporter's key. */
  record(s: ReporterSeen, now: number): Promise<string>;
  /** Reporters as orchestrator messaging needs them (#347). Answers at once; each read through it is async. */
  peerLookup(): AsyncPeerReporterLookup;
  /** Whether any reporter has ever reported to this server: an existing install, for the TLS defaults (#589). */
  hasAny(): Promise<boolean>;
  /** Keeps a short, memory-only list of refused reports by source address, for the detail view. The reason is one of the server's own fixed phrases. */
  rejected(source: string | null, reason: string, now: number): Promise<void>;
  list(opts: { page?: number; pageSize?: number; q?: string; state?: string; sort?: string; dir?: number; admin?: boolean }, now: number): Promise<ReporterList>;
  /** Every key a filtered view holds, not one page of it: what "select all in this filter" removes. */
  keys(opts: { q?: string; state?: string; admin?: boolean }, now: number): Promise<string[]>;
  get(key: string, now: number, opts?: { page?: number; pageSize?: number }): Promise<ReporterDetail | undefined>;
  /** Takes a reporter off the list; it comes back if it reports again. Its sessions are not touched. */
  remove(key: string): Promise<boolean>;
  /** Removes these reporters in one step; unknown keys are skipped. Resolves with how many went. Sessions are not touched. */
  removeMany(keys: string[]): Promise<number>;
  /** Removes every reporter in one state ("Not since restart", say). Resolves with how many went. */
  removeState(state: ReporterState, now: number): Promise<number>;
  listIgnores(): Promise<IgnoreRule[]>;
  /** The first rule a reporter matches, or undefined. */
  ignoredBy(t: IgnoreTarget): Promise<IgnoreRule | undefined>;
  /** Adds a rule (an identical one is kept once) and takes the reporters it matches off the list. Rejects on a bad rule. */
  addIgnore(kind: IgnoreKind, pattern: string, now: number): Promise<IgnoreRule>;
  removeIgnore(id: number): Promise<boolean>;
  /** Off until the Admin turns it on; the days are kept while it is off. */
  forgetSetting(): Promise<ForgetSetting>;
  /** Rejects when `days` is not a whole number from 1 to 3650. */
  setForgetSetting(s: Partial<ForgetSetting>): Promise<void>;
  /** Removes reporters not heard from for the set number of days, when the setting is on and the server has been up for an hour. Resolves with how many went. */
  forgetStale(now: number): Promise<number>;
}

/** What the peer service needs from the server that opens it. */
export interface PeerStoreOptions {
  now: () => number;
  /** The Admin's `peer-messaging` flag. */
  flagOn: () => boolean;
  /** When the server started: a reporter last heard before it is "Not since restart". */
  startedAt: number;
}

/** The Admin's messaging settings, in one stored value; unset values take the defaults. */
export interface PeerSettingsStoreApi {
  get(): Promise<PeerServerSettings>;
  /** Saves the given values. Every value is checked first, and nothing is saved when one fails. */
  set(patch: Record<string, unknown>): Promise<{ ok: true; settings: PeerServerSettings } | { ok: false; error: string }>;
  limits(): Promise<PeerLimits>;
  retainMs(): Promise<number>;
}

/** The rights between reporters, the owners' defaults and the requests for access. */
export interface PeerRightsStoreApi {
  effective(from: string, to: string): Promise<EffectiveRight>;
  rightsOf(owner: string): Promise<RightRow[]>;
  defaults(owner: string): Promise<OwnerDefaults>;
  limits(owner: string, server: PeerLimits): Promise<PeerLimits>;
  setRight(owner: string, from: string, to: string, level: PeerLevel, actor: Actor): Promise<{ ok: true; right: RightRow | null } | Refusal>;
  pauseLink(owner: string | null, a: string, b: string, paused: boolean, actor: Actor): Promise<{ ok: true } | Refusal>;
  pauseReporter(key: string, paused: boolean, actor: Actor): Promise<{ ok: true; links: number } | Refusal>;
  propose(from: string, to: string, level: PeerLevel, actor: Actor): Promise<{ ok: true; request: PeerRequestRow } | Refusal>;
  requestAccess(input: { owner: string; fromKey: string; toKey: string; right: 'see' | 'send'; reason: string; by: string; fromSession: string }): Promise<AccessOutcome | Refusal>;
  openRequests(owner: string, about?: string): Promise<PeerRequestRow[]>;
}

/**
 * Orchestrator messaging (#347, SPEC 7.7): the rights, the messages and the Admin's limits, with the live directory of
 * orchestrators they work from. Each method that touches storage is one step: a rights check and the insert it allows,
 * an answer and the delivery it causes, a retention pass, all happen without another peer call between them. The one
 * method that reads memory only (`messages.live`) answers at once, so a route can check and act in one turn.
 */
export interface PeerStoreApi {
  /** The reporters the service reads, as the table has them. */
  readonly reporters: AsyncPeerReporterLookup;
  /** The Admin's `peer-messaging` flag. */
  flagOn(): boolean;
  /** Replaced by the routes, so a right's event reaches the logs. It runs inside the step that caused it, with a lookup of machine names that answers at once. */
  onRights: (t: RightsTrail, machine: MachineName) => void;
  /** Replaced by the routes, so a message's event reaches the logs. */
  onMessage: (t: MessageTrail, machine: MachineName) => void;
  /** Replaced by the routes: runs `fn` with `src` as the address the log rows it causes name. */
  withSource: <T>(src: string, fn: () => T) => T;
  readonly settings: PeerSettingsStoreApi;
  readonly rights: PeerRightsStoreApi;
  readonly messages: {
    /** The live directory is memory, so this answers at once. */
    live(sessionId: string): LiveOrchestrator | null;
    list(sessionId: string): Promise<{ peers: PeerListing[]; leftOut: LeftOut[] }>;
    send(fromSession: string, to: string, text: string): Promise<SendOutcome | Refusal>;
    result(sessionId: string, id: string, result: PeerResult): Promise<'new' | 'repeat' | 'unknown'>;
    conversations(filter: { owner?: string; since?: number; liveOnly?: boolean }): Promise<ConversationSummary[]>;
    conversation(a: string, b: string): Promise<MessageRow[]>;
  };
  /** After every accepted report from a reporter the server recorded. A `done` report lets go of what waited for the session. */
  note(sessionId: string, reporterKey: string, owner: string, report: Report): Promise<void>;
  replyFor(sessionId: string, allowed: boolean): Promise<PeerReply>;
  answer(id: string, owner: string, answer: PeerAnswer, actor: Actor): Promise<AnswerOutcome | Refusal>;
  answerPaused(id: string, owner: string, answer: PeerAnswer, actor: Actor): Promise<{ out: AnswerOutcome | Refusal; paused: boolean }>;
  removeLink(owner: string | null, a: string, b: string, actor: Actor): Promise<{ ok: true } | Refusal>;
  /** The owner's defaults, checked against the Admin's limits as they are in the same step. */
  setDefaults(owner: string, patch: Record<string, unknown>, actor: Actor): Promise<{ ok: true; defaults: OwnerDefaults } | Refusal>;
  ownerView(owner: string, now: number): Promise<OwnerPeersView>;
  adminView(key: string): Promise<AdminPeersView | null>;
  /** The orchestrator is forgotten, and what still waits for it is dropped. */
  ended(sessionId: string): Promise<void>;
  deleted(sessionIds: string[]): Promise<void>;
  /** The flag went off: every held message is dropped. */
  dropAll(): Promise<void>;
  /** The hourly sweep of conversations, closed requests and messages whose session is gone. */
  retain(): Promise<{ messages: number; requests: number }>;
}

/** The Admin's feature flags, one `settings` row each. */
export interface FeatureFlagsApi {
  featureOn(id: string): Promise<boolean>;
  /** Resolves false for an id that is not a known flag. */
  setFeature(id: string, on: boolean): Promise<boolean>;
  /** Every flag by id, as `StateBody.features` sends it to the console. */
  view(): Promise<Record<string, boolean>>;
}

/** The Admin's model price overrides. */
export interface ModelPricesApi {
  overrides(): Promise<PriceOverrides>;
  /** The pricing in force; a saved change shows here at once. */
  pricing(): Promise<Pricing>;
  /**
   * Saves one row (replacing whatever the Admin had set on it). Values equal to the built-in ones are not stored.
   * Resolves with a message for an invalid row, `null` when it was saved.
   */
  set(rawKey: string, body: Partial<ModelPrice>): Promise<string | null>;
  /** Removes the Admin's change from a row (or an Admin-added model). */
  reset(rawKey: string): Promise<void>;
  view(): Promise<ModelPricesView>;
}

/** The Admin's session recording limits. */
export interface RecordingSettingsApi {
  /** The saved settings; a missing or invalid field takes its default. */
  get(): Promise<RecordingSettings>;
  /** Saves the given fields. Every field is checked first, and nothing is saved when one fails. `before` is what was saved until now. */
  set(patch: Record<string, unknown>): Promise<{ ok: true; before: RecordingSettings; settings: RecordingSettings } | { ok: false; error: string }>;
}

/** The Admin's Activity history choice. */
export interface ActivityHistorySettingsApi {
  /** The saved settings; a missing or invalid field takes its default. Without a token the policy is always `default`. */
  get(): Promise<ActivityHistorySettings>;
  /** Saves the given fields. Every field is checked first, and nothing is saved when one fails. */
  set(patch: Record<string, unknown>): Promise<{ ok: true; settings: ActivityHistorySettings } | { ok: false; error: string }>;
}

/** The serving certificate and reporter certificate settings, and whether reporters may use HTTP. */
export interface TlsSettingsApi {
  get(): Promise<ServingSettings>;
  /** `tls.allowReportersOverHttp`. A missing row reads as on, so nothing stops before the server has decided (SPEC 6). */
  allowReportersOverHttp(): Promise<boolean>;
  /** The first time TLS runs: on for an install that already has reporters, off for a fresh one. A row that exists is left alone. */
  seedAllowReportersOverHttp(existingInstall: boolean): Promise<void>;
  /** The setting for a person's certificate. A missing or invalid row reads as its default. */
  getReporter(): Promise<ReporterSettings>;
  /** Saves the given settings, keyed as in SPEC 6. Every value is checked first and nothing is saved when one fails. */
  set(patch: Record<string, unknown>): Promise<{ ok: true; settings: ServingSettings; changed: string[] } | { ok: false; error: string }>;
}

/** A person's certificates. Only the certificate is kept; the key is never passed in. */
export interface PersonCertsApi {
  find(fingerprint: string): Promise<PersonCertRow | undefined>;
  /** The person's certificates, newest first. */
  listFor(personId: number): Promise<PersonCertRow[]>;
  /** The newest certificate that is not revoked, or undefined. */
  current(personId: number): Promise<PersonCertRow | undefined>;
  /**
   * Stores a new certificate and revokes the person's earlier live ones as `reissued`, in one step, so there is never a
   * moment with none or with two.
   */
  replace(personId: number, c: CertToStore, now: number): Promise<PersonCertRow>;
  /**
   * Stores a certificate a reporter renewed for itself and leaves the earlier ones live: the old certificate keeps working
   * until it expires, since another session of the same person may still hold it (SPEC 6, *Authenticating by certificate*).
   */
  add(personId: number, c: CertToStore, now: number): Promise<PersonCertRow>;
  /**
   * How many people are on each CA: a person counts once, by their newest certificate that is not revoked and has not ended
   * by `cutoff`. Used to say how many reporters still depend on the old CA (#588).
   */
  reportersByIssuer(cutoff: number): Promise<{ total: number; byIssuer: Record<string, number> }>;
  /** Revokes the person's live certificates. Resolves with how many it revoked; 0 when there was none to revoke. */
  revokeFor(personId: number, reason: string, now: number): Promise<number>;
}

/**
 * The wall's display settings. A setter resolves with whether it changed the stored value, which is what the caller broadcasts
 * on: writing the default over an unset row counts as a change, as it always has.
 */
export interface WallSettingsApi {
  view(): Promise<WallSettingsView>;
  updateDismissed(): Promise<string | null>;
  /** `known` is false for an id that is not a notice, and then nothing was written. */
  setNotice(id: string, on: boolean): Promise<{ known: boolean; changed: boolean }>;
  setShowBackgroundSessions(on: boolean): Promise<boolean>;
  setCardTitleMachine(on: boolean): Promise<boolean>;
  dismissUpdate(version: string): Promise<boolean>;
}

/** What the Activity history needs from the server that opens it. The rest of its options are plain values and memory reads. */
export interface ActivityHistoryOptions extends Omit<ActivityHistoryOpts, 'agentsOf' | 'step'> {
  /** The ids of the session's running agents, for the loops the server asks the mod to send. Read from the fleet store, so it is async. */
  agentsOf: (sessionId: string) => Promise<string[]>;
}

/** What the session recordings need from the server that opens them. */
export interface RecordingsOptions extends Omit<RecordingsOpts, 'loopsOf' | 'exclusive' | 'compact' | 'step'> {
  /** Every loop of the session with the name the layer shows. Read from the fleet store, so it is async. */
  loopsOf: (sessionId: string) => Promise<{ loop: string; name: string }[]>;
}

export interface ActivityStoreOptions {
  history: ActivityHistoryOptions;
  recordings: RecordingsOptions;
}

/**
 * The Activity history (#432), kept in the second file. What reads memory only (`enabled`, `current`, `lastPurge`, `busy`,
 * `forgetSession`) answers at once. Every other call is one step under the activity file's own lock, or, for a chunked removal,
 * a run of such steps with a turn for the event loop between them, as it always was. The lock is not the main database's.
 */
export interface ActivityHistoryApi {
  /** Stores what is new in a report's snapshots, for the orchestrator and every agent. `skewMs` is the report's `sentAt` minus the server's time. Resolves with how many entries were stored. */
  ingest(report: Report, skewMs: number, meta: SessionMeta): Promise<number>;
  /** An answer, message or command sent from Podium, as an entry of the loop it is about. */
  addPodium(sessionId: string, loop: string, ref: string, e: { at: number; text: string; by: string; note: string | null }, meta: SessionMeta): Promise<void>;
  /** A Podium entry's note changed (queued, then taken). */
  updatePodium(sessionId: string, ref: string, note: string | null): Promise<void>;
  /** A Podium entry for something the session never took (discarded, refused, or the ask closed first). */
  removePodium(sessionId: string, ref: string): Promise<void>;
  /** One page of a loop's stored entries, oldest first. `before` is a `seq` (or null for the newest page). */
  page(sessionId: string, loop: string, before: number | null, limit?: number): Promise<{
    entries: ActivityEntryView[];
    olderBefore: number | null;
    total: number;
    since: number | null;
    keptUntil: number | null;
  }>;
  /** The counts the live feed's reply carries for a loop: null under the default policy or when nothing is stored for it. */
  note(sessionId: string, loop: string): Promise<Pick<ActivityHistoryNote, 'policy' | 'total' | 'since' | 'keptUntil'> | null>;
  /** Everything stored, from the per-session aggregates. */
  totals(): Promise<StoredTotals>;
  /** The stored sessions the filter matches, a page at a time, newest first, with what is stored for each. */
  list(filter: StoredFilter, page?: number, pageSize?: number): Promise<StoredActivityList>;
  /** An estimate of what saving these settings would do now, without doing it. */
  preview(settings: ActivityHistorySettings): Promise<ActivityHistoryPreview>;
  /** Removes what the policy no longer keeps. Does nothing under the default policy. */
  purge(now?: number): Promise<PurgeResult>;
  /** The Admin's delete: the ticked sessions, everything the filter matches, or everything. Works in chunks, session by session. */
  deleteBy(body: StoredDeleteBody, stillWanted?: (sessionId: string) => Promise<boolean>): Promise<StoredDeleteResult>;
  /** A session was deleted: its rows and its loop positions go. */
  deleteSession(sessionId: string): Promise<StoredDeleteResult>;
  /** Resolves when every heavy operation started so far has finished. */
  idle(): Promise<void>;
  current(): ActivityHistorySettings;
  enabled(): boolean;
  readonly lastPurge: LastPurge | null;
  readonly busy: boolean;
  forgetSession(sessionId: string): void;
  /** The orchestrator and every running agent. */
  loopsToWatch(sessionId: string): Promise<string[]>;
  /** `exists` says whether the main database still holds the session; it is asked again just before each session's rows go. */
  dropMissingSessions(exists: (sessionId: string) => Promise<boolean>): Promise<number>;
}

/** Which recordings a Stored activity delete means: these ids, what a filter matches, or all. */
type RecordingTarget = { ids: string[] } | { match: StoredFilter } | { all: true };

/**
 * Session recordings (#353), in the same file and under the same lock. The consent and the write of a batch, and of a start, are
 * one step (`accept`, `choose`), so nothing can change between the check and the write.
 */
export interface SessionRecordingsApi {
  /** Whether a recording is held for the session, whatever its state. */
  has(sessionId: string): Promise<boolean>;
  /** Whether the session may send entries now: all three yes answers, and the batch's loops chosen. */
  capturing(sessionId: string): Promise<boolean>;
  /** Up to which `at` the mod's route takes entries, or null for everything else (a limit, nothing chosen, deleted, the flag or the owner's option off). */
  acceptsUntil(sessionId: string): Promise<number | null>;
  /** When the oldest part of the session's recording goes, or null when none is held. */
  keptUntilOf(sessionId: string): Promise<number | null>;
  /** The consent state a report's reply and a batch's reply carry (SPEC 6.1). */
  grant(sessionId: string): Promise<RecordingGrant>;
  totalBytes(): Promise<number>;
  /**
   * Someone with the right chose to record the session's loops from now on. Nothing before this moment is kept. `limit` when its
   * own limit stopped it (delete it first), `budget` while less than one request is left under the Admin's budget, `busy` while a delete of it is still going.
   */
  start(sessionId: string, loops: string[], by: string, meta: RecordingMeta): Promise<'ok' | 'limit' | 'budget' | 'busy'>;
  /** The recording's state as the Admin's table shows it, or undefined when there is none. */
  stateFor(sessionId: string): Promise<StoredState | undefined>;
  /** Stop capture and keep what was recorded. Null when there is no recording; `changed` is false for one already stopped. */
  stop(sessionId: string, by: string): Promise<{ grant: RecordingGrant; changed: boolean } | null>;
  /** The Admin turned the flag off: every running recording stops and keeps what it has. Resolves with the sessions stopped. */
  stopAll(by: string): Promise<string[]>;
  /** A /clear gave the session a new id. When the old one was being recorded, the new one is recorded from its first report. */
  carryOver(oldId: string, newId: string, meta: RecordingMeta): Promise<boolean>;
  /** Stores a batch the mod sent for a session that may send. Resolves with how many entries were new. */
  ingest(sessionId: string, batch: RecordingBatch, meta?: RecordingMeta): Promise<number>;
  /** One page of a replay, oldest first: the newest `limit` rows older than `before` (an `n`), of one loop when given. */
  page(sessionId: string, before: number | null, limit: number, loop: string | null): Promise<{ entries: RecordingRow[]; olderBefore: number | null; total: number }>;
  /** The Admin's Recordings table: running or kept, a page at a time. `state` and `q` (name, id or owner) narrow it. */
  adminList(opts: { page: number; pageSize: number; state?: StoredState; q?: string }): Promise<{ total: number; page: number; pageSize: number; rows: RecordingAdminRow[]; totals: RecordingTotals }>;
  /** The Stored activity page for Source = Recordings: the same shape as the Activity history's list. */
  listStored(f: StoredFilter, page: number, pageSize: number): Promise<StoredActivityList>;
  /** The session ids a Stored activity delete means for Source = Recordings. */
  idsFor(body: RecordingTarget): Promise<string[]>;
  /** A message delivered from Podium to a recorded loop is remembered, not stored, so the mod's matching `prompt` entry can name the sender. */
  notePodiumPrompt(sessionId: string, loop: string, e: { at: number; text: string; by: string }, ref?: string): Promise<void>;
  /** The browser route's checks and `start` as one step. */
  choose(sessionId: string, loops: string[], by: string, meta: RecordingMeta, available: string[]): Promise<'ended' | 'unknown-loop' | 'ok' | 'limit' | 'budget' | 'busy'>;
  /** The mod route's checks and the write as one step. `ended` carries whether a recording is held, for the refusal. */
  accept(sessionId: string, batch: RecordingBatch, meta: RecordingMeta): Promise<
    { kind: 'ended'; held: boolean } | { kind: 'off' } | { kind: 'stored'; stored: number; before: RecordingState; recording: RecordingGrant }
  >;
  /** Deletes whole recordings for good and stops their capture at once; the entries then go in chunks. */
  removeMany(ids: string[]): Promise<RemoveResult>;
  /** `removeMany` for the recordings a Stored activity delete means, chosen in the same step that removes the rows that carry their state. */
  removeFor(body: RecordingTarget): Promise<RemoveResult>;
  /** The session is gone from the main database: its recording goes with it. */
  removeSession(sessionId: string): Promise<RemoveResult>;
  /** Removes every part older than `keepHours`, counted from when it was stored, in chunks. */
  purge(now?: number): Promise<PurgeRecordingsResult>;
  /** Set by the routes: where the Admin log hears of what the server did on its own. Called after the step that caused it, before its promise resolves. */
  trail: ((t: RecordingTrail) => void) | null;
  enabled(): boolean;
  noteOption(sessionId: string, on: boolean | undefined): void;
  optionOn(sessionId: string): boolean;
  forgetSession(sessionId: string): void;
  forgetPodiumPrompt(sessionId: string, ref: string): void;
  view(sessionId: string): Promise<RecordingView | null>;
  loopInfo(sessionId: string): Promise<RecordingLoopInfo[]>;
  totals(): Promise<RecordingTotals>;
  /** `exists` says whether the main database still holds the session; it is asked again just before the recording's state goes. */
  dropMissingSessions(exists: (sessionId: string) => Promise<boolean>): Promise<number>;
}

export type { RecordingMeta };

/** The two services over the activity file. */
export interface ActivityStorage {
  readonly history: ActivityHistoryApi;
  readonly recordings: SessionRecordingsApi;
}

/** All the stores over one backing database. */
export interface Storage {
  readonly fleet: FleetStore;
  readonly people: PeopleStoreApi;
  readonly reporters: ReporterStoreApi;
  readonly featureFlags: FeatureFlagsApi;
  readonly wallSettings: WallSettingsApi;
  readonly modelPrices: ModelPricesApi;
  readonly recordingSettings: RecordingSettingsApi;
  /** The store is built per server, since what a policy may be depends on whether a sign-in token is set. */
  activityHistorySettings(authOn: boolean): ActivityHistorySettingsApi;
  /** Built per server, since the live directory, the flag and the start time are its own. */
  peers(opts: PeerStoreOptions): PeerStoreApi;
  readonly tlsSettings: TlsSettingsApi;
  readonly personCerts: PersonCertsApi;
  /**
   * The Activity store: the Activity history, the session recordings and the loops. It is kept apart from the main store so a
   * slow write there does not hold up reports, and an adapter decides where it lives. It has its own lock and transactions;
   * nothing here spans both stores, and `tx` is the main store's. Built per server, since the live set and the Admin's settings are its own.
   */
  activity(opts: ActivityStoreOptions): ActivityStorage;
  /** Runs `fn` in one transaction across the stores: commits when it resolves, rolls back and rethrows when it rejects. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  /** Waits for queued work, then closes the database. */
  close(): Promise<void>;
}
