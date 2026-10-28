// The async storage interfaces (#313). Every method of the existing stores keeps its name, arguments and result, and
// returns a Promise. Nothing here names node:sqlite, so another database can implement it.
import type { FleetDb } from '../fleet/db.js';
import type { PeopleStore } from '../fleet/people.js';
import type { ReporterStore } from '../fleet/reporters.js';
import type { Actor, AnswerOutcome, ConversationSummary, LiveOrchestrator, MachineName, MessageRow, MessageTrail, PeerListing, PeerReporterLookup, Refusal, RightsTrail, SendOutcome, LeftOut } from '../fleet/peerTypes.js';
import type { PeerRights } from '../fleet/peerRights.js';
import type { PeerSettings } from '../fleet/peerSettings.js';
import type { AdminPeersView, OwnerPeersView, PeerReply } from '../fleet/peers.js';
import type { PeerAnswer, PeerResult, Report } from '../fleet/protocol.js';
import type { ReportQueries } from './reportQueries.js';
import type { FeatureFlags } from '../fleet/featureFlags.js';
import type { ModelPriceStore } from '../fleet/modelPrices.js';
import type { RecordingSettingsStore } from '../fleet/recordingSettings.js';
import type { ActivityHistorySettingsStore } from '../fleet/activityHistorySettings.js';
import type { WallSettingsView } from '../fleet/protocol.js';
import type { TlsSettingsStore } from '../tlsRenew.js';
import type { PersonCertStore } from '../tlsClientAuth.js';

/** A function becomes one returning a Promise of the same result; anything else is kept. */
export type Async<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : T[K];
};

/** Sessions, agents, events, blowouts, samples and spend, and the report and rollup queries (#484). */
export type FleetStore = Async<Omit<FleetDb, 'db' | 'tx' | 'close'>> & Async<ReportQueries>;

/** People, groups, the admin log and the settings they own. */
export type PeopleStoreApi = Async<Omit<PeopleStore, 'db'>>;

/** The reporter lookup the peer service reads; the same shape as `PeerReporterLookup` with async methods. */
export type AsyncPeerReporterLookup = Async<PeerReporterLookup>;

/** Reporters, ignore rules and the forget setting. `peerLookup()` stays synchronous: it reads nothing until a method is called. */
export type ReporterStoreApi = Async<Omit<ReporterStore, 'db' | 'peerLookup'>> & {
  peerLookup(): AsyncPeerReporterLookup;
};

/** What the peer service needs from the server that opens it. */
export interface PeerStoreOptions {
  now: () => number;
  /** The Admin's `peer-messaging` flag. */
  flagOn: () => boolean;
  /** When the server started: a reporter last heard before it is "Not since restart". */
  startedAt: number;
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
  readonly settings: Async<Pick<PeerSettings, 'get' | 'set' | 'limits' | 'retainMs'>>;
  readonly rights: Async<Pick<PeerRights, 'effective' | 'rightsOf' | 'defaults' | 'limits' | 'setRight' | 'pauseLink' | 'pauseReporter' | 'propose' | 'requestAccess' | 'openRequests'>>;
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
  setDefaults(owner: string, patch: Record<string, unknown>, actor: Actor): Promise<ReturnType<PeerRights['setDefaults']>>;
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
export type FeatureFlagsApi = Async<FeatureFlags>;

/** The Admin's model price overrides. */
export type ModelPricesApi = Async<ModelPriceStore>;

/** The Admin's session recording limits. */
export type RecordingSettingsApi = Async<RecordingSettingsStore>;

/** The Admin's Activity history choice. */
export type ActivityHistorySettingsApi = Async<ActivityHistorySettingsStore>;

/** The serving certificate and reporter certificate settings, and whether reporters may use HTTP. */
export type TlsSettingsApi = Async<TlsSettingsStore>;

/** A person's certificates. */
export type PersonCertsApi = Async<PersonCertStore>;

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
  /** Runs `fn` in one transaction across the stores: commits when it resolves, rolls back and rethrows when it rejects. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  /** Waits for queued work, then closes the database. */
  close(): Promise<void>;
}
