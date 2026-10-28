// The async storage interfaces (#313). Every method of the existing stores keeps its name, arguments and result, and
// returns a Promise. Nothing here names node:sqlite, so another database can implement it.
import type { FleetDb } from '../fleet/db.js';
import type { PeopleStore } from '../fleet/people.js';
import type { ReporterStore } from '../fleet/reporters.js';
import type { PeerReporterLookup } from '../fleet/peerTypes.js';
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
  readonly tlsSettings: TlsSettingsApi;
  readonly personCerts: PersonCertsApi;
  /** Runs `fn` in one transaction across the stores: commits when it resolves, rolls back and rethrows when it rejects. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  /** Waits for queued work, then closes the database. */
  close(): Promise<void>;
}
