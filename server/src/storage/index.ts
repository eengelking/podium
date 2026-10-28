import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqliteStorage } from './sqlite/index.js';
import type { Storage } from './types.js';

export type { Storage, FleetStore, PeopleStoreApi, ReporterStoreApi, AsyncPeerReporterLookup,
  FeatureFlagsApi, PeerStoreApi, PeerStoreOptions, WallSettingsApi, ModelPricesApi, RecordingSettingsApi, ActivityHistorySettingsApi, TlsSettingsApi, PersonCertsApi } from './types.js';
export { openSqliteStorage, type SqliteStorage } from './sqlite/index.js';

/** Opens the storage a target names. `target` is what follows the kind: a file for SQLite. */
export type StorageOpener = (target: string) => Storage;

/** The one place that knows which implementations exist: a new database is a registration here. */
const registry = new Map<string, StorageOpener>([['sqlite', (target) => openSqliteStorage(target)]]);

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const defaultDbFile = (): string => path.join(REPO_ROOT, 'data', 'podium.sqlite');

/** PODIUM_DB is a SQLite file by default; `kind://target` picks another registered implementation. */
export function openStorage(env: NodeJS.ProcessEnv = process.env): Storage {
  const value = env.PODIUM_DB || defaultDbFile();
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/.exec(value);
  const kind = m ? m[1] : 'sqlite';
  const open = registry.get(kind);
  if (!open) throw new Error(`PODIUM_DB: unknown storage kind "${kind}" (known: ${[...registry.keys()].join(', ')})`);
  return open(m ? m[2] : value);
}
