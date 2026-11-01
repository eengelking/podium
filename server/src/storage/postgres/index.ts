// The PostgreSQL storage (#822): the stores of `types.ts` over the `pg` driver. The main schema (`podium`) holds the fleet, people, reporters
// and settings; the Activity history and the recordings live in their own schema (`podium_activity`) on their own pool, as the SQLite
// adapter keeps them in their own file. Only this folder knows PostgreSQL; the registry loads this module when a `postgres://` target is chosen.
import type { Storage } from '../types.js';
import { PgDb } from './conn.js';
import { ACTIVITY_SCHEMA, ACTIVITY_STEPS, MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { acquireSingleProcessLock } from './singleProcess.js';
import { PgActivityConnection } from './activity.js';
import { pgFleet } from './fleet.js';
import { pgPeople } from './people.js';
import { pgReporters } from './reporters.js';
import { pgPeers } from './peers.js';
import { pgFeatureFlags } from './featureFlags.js';
import { pgWallSettings } from './wallSettings.js';
import { pgModelPrices } from './modelPrices.js';
import { pgRecordingSettings } from './recordingSettings.js';
import { pgActivityHistorySettings } from './activityHistorySettings.js';
import { pgTlsSettings } from './tlsSettings.js';
import { pgPersonCerts } from './personCerts.js';

const MAIN_POOL = 10;
const ACTIVITY_POOL = 4;

/** Opens the database `target` names (what follows `postgres://`), takes the single-process lock and brings both schemas up to date. */
export async function openPostgresStorage(target: string, now: number = Date.now()): Promise<Storage> {
  const url = `postgres://${target}`;
  const lock = await acquireSingleProcessLock(url);
  const main = new PgDb({ connectionString: url, schema: MAIN_SCHEMA, max: MAIN_POOL, name: 'main' });
  const activityDb = new PgDb({ connectionString: url, schema: ACTIVITY_SCHEMA, max: ACTIVITY_POOL, name: 'activity' });
  try {
    await migrate(main, MAIN_SCHEMA, MAIN_STEPS);
    await migrate(activityDb, ACTIVITY_SCHEMA, ACTIVITY_STEPS);
  } catch (err) {
    await main.close().catch(() => undefined);
    await activityDb.close().catch(() => undefined);
    await lock.release();
    throw err;
  }
  // The activity services are built when the first is asked for (at startup), over the pool opened above.
  let connection: PgActivityConnection | null = null;
  const activityOf = (): PgActivityConnection => (connection ??= new PgActivityConnection(activityDb));
  let closed = false;
  return {
    activity: (opts) => activityOf().build(opts),
    fleet: pgFleet(main),
    people: pgPeople(main),
    reporters: pgReporters(main, now),
    featureFlags: pgFeatureFlags(main),
    wallSettings: pgWallSettings(main),
    modelPrices: pgModelPrices(main),
    recordingSettings: pgRecordingSettings(main),
    activityHistorySettings: (authOn) => pgActivityHistorySettings(main, authOn),
    peers: (opts) => pgPeers(main, opts),
    tlsSettings: pgTlsSettings(main),
    personCerts: pgPersonCerts(main),
    tx: (fn) => main.tx(fn),
    close: async () => {
      if (closed) return;
      closed = true;
      // The activity side first: its chunked removals stop at their next chunk, and nothing there waits on the main pool.
      if (connection) await connection.close();
      else await activityDb.close();
      await main.close();
      await lock.release();
    },
  };
}
