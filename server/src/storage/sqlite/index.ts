import type { DatabaseSync } from 'node:sqlite';
import { FleetDb, openDb } from '../../fleet/db.js';
import { PeopleStore } from '../../fleet/people.js';
import { ReporterStore } from '../../fleet/reporters.js';
import type { Async, AsyncPeerReporterLookup, FleetStore, PeopleStoreApi, ReporterStoreApi, Storage, WallSettingsApi } from '../types.js';
import { FeatureFlags } from '../../fleet/featureFlags.js';
import { WallSettings } from '../../fleet/wallSettings.js';
import { ModelPriceStore } from '../../fleet/modelPrices.js';
import { RecordingSettingsStore } from '../../fleet/recordingSettings.js';
import { ActivityHistorySettingsStore } from '../../fleet/activityHistorySettings.js';
import { TlsSettingsStore } from '../../tlsRenew.js';
import { PersonCertStore } from '../../tlsClientAuth.js';
import { AsyncLock } from './lock.js';
import { SqliteReportQueries } from './reportQueries.js';

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
}

/** Opens `file` (`:memory:` for tests) and puts the fleet, people and reporter stores on its one connection. */
export function openSqliteStorage(file: string, now: number = Date.now()): SqliteStorage {
  const db = openDb(file);
  const lock = new AsyncLock();
  const fleet = new FleetDb(db);
  const reporters = new ReporterStore(db, now);
  const lookup = reporters.peerLookup();
  const asyncLookup: AsyncPeerReporterLookup = {
    startedAt: lookup.startedAt,
    ofOwnerSeen: (owner, at) => lock.run(() => lookup.ofOwnerSeen(owner, at)),
    get: (key) => lock.run(() => lookup.get(key)),
    ofOwner: (owner) => lock.run(() => lookup.ofOwner(owner)),
  };
  return {
    sqliteHandle: db,
    fleet: { ...wrap(fleet, lock), ...wrap(new SqliteReportQueries(db), lock) } as FleetStore,
    people: wrap(new PeopleStore(db), lock) as PeopleStoreApi,
    reporters: { ...wrap(reporters, lock), peerLookup: () => asyncLookup } as ReporterStoreApi,
    featureFlags: wrap(new FeatureFlags(db), lock),
    wallSettings: wallSettingsOver(db, lock),
    modelPrices: wrap(new ModelPriceStore(db), lock),
    recordingSettings: wrap(new RecordingSettingsStore(db), lock),
    activityHistorySettings: (authOn) => wrap(new ActivityHistorySettingsStore(db, authOn), lock),
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
      await lock.drain();
      db.close();
    },
  };
}
