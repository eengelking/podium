import { FleetDb, openDb } from '../../fleet/db.js';
import { PeopleStore } from '../../fleet/people.js';
import { ReporterStore } from '../../fleet/reporters.js';
import type { Async, AsyncPeerReporterLookup, FleetStore, PeopleStoreApi, ReporterStoreApi, Storage } from '../types.js';
import { AsyncLock } from './lock.js';

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

/** Opens `file` (`:memory:` for tests) and puts the fleet, people and reporter stores on its one connection. */
export function openSqliteStorage(file: string, now: number = Date.now()): Storage {
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
    fleet: wrap(fleet, lock) as FleetStore,
    people: wrap(new PeopleStore(db), lock) as PeopleStoreApi,
    reporters: { ...wrap(reporters, lock), peerLookup: () => asyncLookup } as ReporterStoreApi,
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
