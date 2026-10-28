// The async storage interfaces (#313). Every method of the existing stores keeps its name, arguments and result, and
// returns a Promise. Nothing here names node:sqlite, so another database can implement it.
import type { FleetDb } from '../fleet/db.js';
import type { PeopleStore } from '../fleet/people.js';
import type { ReporterStore } from '../fleet/reporters.js';
import type { PeerReporterLookup } from '../fleet/peerTypes.js';
import type { ReportQueries } from './reportQueries.js';

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

/** All the stores over one backing database. */
export interface Storage {
  readonly fleet: FleetStore;
  readonly people: PeopleStoreApi;
  readonly reporters: ReporterStoreApi;
  /** Runs `fn` in one transaction across the stores: commits when it resolves, rolls back and rethrows when it rejects. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  /** Waits for queued work, then closes the database. */
  close(): Promise<void>;
}
