// The MariaDB storage (#823): the stores of `types.ts` over the official `mariadb` driver. The fleet, people, reporters and settings and the
// Activity history and recordings share one database: the Activity tables have names of their own (and their own record of steps), and sit
// on their own pool and lock, as the SQLite adapter keeps them in their own file. Only this folder knows MariaDB; the registry loads this
// module when a `mariadb://` target is chosen.
import type { Storage } from '../types.js';
import { MariaDbConn, parseTarget } from './conn.js';
import { ACTIVITY_MIGRATIONS, ACTIVITY_STEPS, MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { acquireSingleProcessLock, exitOnLockLost, type LockOptions, type SingleProcessLock } from './singleProcess.js';
import { MariaActivityConnection } from './activity.js';
import { mariaFleet } from './fleet.js';
import { mariaPeople } from './people.js';
import { mariaReporters } from './reporters.js';
import { mariaPeers } from './peers.js';
import { mariaChat } from './chat.js';
import { mariaFeatureFlags } from './featureFlags.js';
import { mariaWallSettings } from './wallSettings.js';
import { mariaModelPrices } from './modelPrices.js';
import { mariaRecordingSettings } from './recordingSettings.js';
import { mariaActivityHistorySettings } from './activityHistorySettings.js';
import { mariaTlsSettings } from './tlsSettings.js';
import { mariaPersonCerts } from './personCerts.js';

const MAIN_POOL = 10;
const ACTIVITY_POOL = 4;

/**
 * Opens the database `target` names (what follows `mariadb://`), takes the single-process lock and brings both sets of tables up to date.
 * If the lock is lost later (its connection dropped and could not be taken again, or another server took it) every call rejects and
 * `onLockLost` is called once; the default stops the process through its normal shutdown. `lockOptions` tunes the retries.
 */
export async function openMariaDbStorage(target: string, now: number = Date.now(), onLockLost: (err: Error) => void = exitOnLockLost, lockOptions: Omit<LockOptions, 'onLost'> = {}): Promise<Storage> {
  const url = `mariadb://${target}`;
  const where = parseTarget(url); // a URL with no database or an unknown parameter fails here, before any connection
  const dbs: MariaDbConn[] = [];
  const lock = await acquireSingleProcessLock(url, {
    ...lockOptions,
    onLost: (err) => {
      for (const d of dbs) d.fail(err);
      onLockLost(err);
    },
  });
  // Every pool is made inside the try: whatever fails from here on lets go of what was made and of the lock.
  let main: MariaDbConn | undefined;
  let activityDb: MariaDbConn | undefined;
  try {
    main = new MariaDbConn({ target: where, max: MAIN_POOL });
    dbs.push(main);
    activityDb = new MariaDbConn({ target: where, max: ACTIVITY_POOL });
    dbs.push(activityDb);
    await migrate(main, MAIN_MIGRATIONS, MAIN_STEPS);
    await migrate(activityDb, ACTIVITY_MIGRATIONS, ACTIVITY_STEPS);
  } catch (err) {
    await main?.close().catch(() => undefined);
    await activityDb?.close().catch(() => undefined);
    await lock.release();
    throw err;
  }
  return storageOver(main, activityDb, lock, now);
}

/** The stores over the two open pools; closing it closes both and releases the lock, each step whether or not the one before it failed. */
function storageOver(main: MariaDbConn, activityDb: MariaDbConn, lock: SingleProcessLock, now: number): Storage {
  // The activity services are built when the first is asked for (at startup), over the pool opened above.
  let connection: MariaActivityConnection | null = null;
  const activityOf = (): MariaActivityConnection => (connection ??= new MariaActivityConnection(activityDb));
  let closed = false;
  return {
    activity: (opts) => activityOf().build(opts),
    fleet: mariaFleet(main),
    people: mariaPeople(main),
    reporters: mariaReporters(main, now),
    featureFlags: mariaFeatureFlags(main),
    wallSettings: mariaWallSettings(main),
    modelPrices: mariaModelPrices(main),
    recordingSettings: mariaRecordingSettings(main),
    activityHistorySettings: (authOn) => mariaActivityHistorySettings(main, authOn),
    peers: (opts) => mariaPeers(main, opts),
    chat: (opts) => mariaChat(main, opts),
    tlsSettings: mariaTlsSettings(main),
    personCerts: mariaPersonCerts(main),
    tx: (fn) => main.tx(fn),
    close: async () => {
      if (closed) return;
      closed = true;
      // The activity side first: its chunked removals stop at their next chunk, and nothing there waits on the main pool. A step that
      // fails does not stop the next one; the first failure is reported once the lock is released.
      const failures: unknown[] = [];
      const step = async (fn: () => Promise<void>): Promise<void> => {
        try {
          await fn();
        } catch (err) {
          failures.push(err);
        }
      };
      await step(() => (connection ? connection.close() : activityDb.close()));
      await step(() => main.close());
      await step(() => lock.release());
      if (failures.length) throw failures[0];
    },
  };
}
