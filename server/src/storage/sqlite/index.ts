import type { DatabaseSync } from 'node:sqlite';
import { FleetDb, openDb } from './db.js';
import { PeopleStore } from './people.js';
import { ReporterStore } from './reporters.js';
import type { Async, AsyncPeerReporterLookup, FleetStore, PeopleStoreApi, ReporterStoreApi, Storage, WallSettingsApi } from '../types.js';
import { FeatureFlags } from './featureFlags.js';
import { WallSettings } from './wallSettings.js';
import { ModelPriceStore } from './modelPrices.js';
import { RecordingSettingsStore } from './recordingSettings.js';
import { ActivityHistorySettingsStore } from './activityHistorySettings.js';
import { TlsSettingsStore } from './tlsSettings.js';
import { PersonCertStore } from './personCerts.js';
import { AsyncLock } from './lock.js';
import { SqliteReportQueries } from './reportQueries.js';
import { asyncLookupOver, peerStoreOver } from './peers.js';
import { ActivityConnection } from './activity.js';
import { activityDbPath, openActivityDb } from './activityDb.js';

const NOT_WRAPPED = new Set(['constructor', 'tx', 'close']);

/** Each method of `target` as an async one that runs the synchronous call under the connection's lock. */
function wrap<T extends object>(target: T, lock: AsyncLock): Async<T> {
  const out: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(target))) {
    if (NOT_WRAPPED.has(name)) continue;
    const fn = (target as Record<string, unknown>)[name];
    if (typeof fn === 'function') out[name] = (...args: unknown[]) => lock.run(() => fn.apply(target, args));
  }
  return out as Async<T>;
}

/** The wall's settings. The class reports a change through its callback, which fires inside the call, so it is read back there. */
function wallSettingsOver(db: DatabaseSync, lock: AsyncLock): WallSettingsApi {
  let changed = false;
  const wall = new WallSettings(db, () => {
    changed = true;
  });
  const run = <T>(fn: () => T): Promise<[T, boolean]> =>
    lock.run(() => {
      changed = false;
      return [fn(), changed];
    });
  return {
    view: () => lock.run(() => wall.view()),
    updateDismissed: () => lock.run(() => wall.updateDismissed()),
    setNotice: async (id, on) => {
      const [known, did] = await run(() => wall.setNotice(id, on));
      return { known, changed: did };
    },
    setShowBackgroundSessions: async (on) => (await run(() => wall.setShowBackgroundSessions(on)))[1],
    setCardTitleMachine: async (on) => (await run(() => wall.setCardTitleMachine(on)))[1],
    dismissUpdate: async (version) => (await run(() => wall.dismissUpdate(version)))[1],
  };
}

/**
 * The SQLite storage, with the raw connection the stores not yet converted still use.
 * TODO(#313 stage 5): remove `sqliteHandle`, with the stores that need it. A call made on it is a synchronous call that does
 * not take the lock, so it can run inside another task's open `tx` and see (or write) its uncommitted rows. It exists only
 * until stages 3 to 5 move those stores onto the async interface.
 */
export interface SqliteStorage extends Storage {
  readonly sqliteHandle: DatabaseSync;
  /** The activity connection, opened on first use. For tests that look at its rows; production code reaches it through `activity`. */
  activityHandle(): DatabaseSync;
}

/** Opens `file` (`:memory:` for tests) and puts the fleet, people and reporter stores on its one connection; the activity file beside it is opened by `activity`. */
export function openSqliteStorage(file: string, now: number = Date.now()): SqliteStorage {
  const db = openDb(file);
  const lock = new AsyncLock();
  const fleet = new FleetDb(db);
  const reporters = new ReporterStore(db, now);
  const asyncLookup: AsyncPeerReporterLookup = asyncLookupOver(reporters.peerLookup(), lock);
  // The activity file is its own connection with its own lock, opened when the first service is built (at startup). Nothing
  // spans the two files.
  let activityConn: ActivityConnection | null = null;
  const activityOf = (): ActivityConnection => (activityConn ??= new ActivityConnection(openActivityDb(activityDbPath(file))));
  return {
    sqliteHandle: db,
    activityHandle: () => activityOf().db,
    activity: (opts) => activityOf().build(opts),
    fleet: { ...wrap(fleet, lock), ...wrap(new SqliteReportQueries(db), lock) } as FleetStore,
    people: wrap(new PeopleStore(db), lock) as PeopleStoreApi,
    reporters: { ...wrap(reporters, lock), peerLookup: () => asyncLookup } as ReporterStoreApi,
    featureFlags: wrap(new FeatureFlags(db), lock),
    wallSettings: wallSettingsOver(db, lock),
    modelPrices: wrap(new ModelPriceStore(db), lock),
    recordingSettings: wrap(new RecordingSettingsStore(db), lock),
    activityHistorySettings: (authOn) => wrap(new ActivityHistorySettingsStore(db, authOn), lock),
    peers: (opts) => peerStoreOver(db, lock, opts),
    tlsSettings: wrap(new TlsSettingsStore(db), lock),
    personCerts: wrap(new PersonCertStore(db), lock),
    tx: (fn) =>
      lock.inside() ? fn() : lock.run(async () => {
        db.exec('BEGIN');
        try {
          const out = await fn();
          db.exec('COMMIT');
          return out;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }),
    close: async () => {
      // The activity file first: its chunked removals stop at their next chunk, and nothing there waits on this connection.
      await activityConn?.close();
      await lock.drain();
      db.close();
    },
  };
}
