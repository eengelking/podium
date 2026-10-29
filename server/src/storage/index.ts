import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Storage } from './types.js';

export type { Storage, FleetStore, FleetStoreApi, PeerSettingsStoreApi, PeerRightsStoreApi, PeopleStoreApi, ReporterStoreApi, AsyncPeerReporterLookup,
  FeatureFlagsApi, PeerStoreApi, ActivityStorage, ActivityStoreOptions, ActivityHistoryApi, ActivityHistoryOptions, SessionRecordingsApi, RecordingsOptions, PeerStoreOptions, WallSettingsApi, ModelPricesApi, RecordingSettingsApi, ActivityHistorySettingsApi, TlsSettingsApi, PersonCertsApi } from './types.js';

/** Opens the storage a target names. `target` is what follows the kind: a file for a file-based kind. */
export type StorageOpener = (target: string) => Storage;

/** Imports a kind's adapter module and returns its opener. Called only when that kind is chosen, so a server never loads another kind's driver. */
export type StorageLoader = () => Promise<StorageOpener>;

/** A registered implementation. `fileBased` is true when its target is a file, so the folder holding it is a data directory. `defaultTarget` is what it opens when PODIUM_DB is not set. */
export interface StorageKind { fileBased: boolean; defaultTarget(): string; load: StorageLoader }

/** The kind PODIUM_DB means when it names none: a plain path or `:memory:`, or nothing at all. */
export const DEFAULT_STORAGE_KIND = 'sqlite';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The one place that knows which implementations exist: a new database is a registration here. */
const registry = new Map<string, StorageKind>([[DEFAULT_STORAGE_KIND, { fileBased: true, defaultTarget: () => path.join(REPO_ROOT, 'data', 'podium.sqlite'), load: async () => (await import('./sqlite/index.js')).openSqliteStorage }]]);

/** Adds a kind to the registry and returns a function that removes it again. For tests: the server registers its own kinds above. A kind with no `defaultTarget` cannot be the default. */
export function registerStorageKind(kind: string, entry: Omit<StorageKind, 'defaultTarget'> & Partial<Pick<StorageKind, 'defaultTarget'>>): () => void {
  registry.set(kind, { defaultTarget: () => { throw new Error(`${kind} has no default target`); }, ...entry });
  return () => { registry.delete(kind); };
}

/** The default kind's default target: what the server opens when PODIUM_DB is unset or empty. */
export const defaultDbFile = (): string => registry.get(DEFAULT_STORAGE_KIND)!.defaultTarget();

/**
 * What PODIUM_DB names: the kind of storage and its target. A plain path or `:memory:` is a SQLite file; `kind://target`
 * picks another registered kind, and an unregistered one throws. `target` is also what the rest of the server derives
 * its label in the log and the health check, so `sqlite://x` and `x` agree.
 */
export function storageSpec(env: NodeJS.ProcessEnv = process.env): { kind: string; target: string } {
  const value = env.PODIUM_DB || defaultDbFile();
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/.exec(value);
  const kind = m ? m[1]! : DEFAULT_STORAGE_KIND;
  if (!registry.has(kind)) throw new Error(`PODIUM_DB: unknown storage kind "${kind}" (known: ${[...registry.keys()].join(', ')})`);
  return { kind, target: m ? m[2]! : value };
}

/**
 * The folder for what the server keeps of its own: the TLS CA. PODIUM_DATA_DIR when set;
 * otherwise the folder of a file target, as before. A database that is not a file has no such folder, so it must be named.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PODIUM_DATA_DIR) return env.PODIUM_DATA_DIR;
  const { kind, target } = storageSpec(env);
  if (!registry.get(kind)!.fileBased) throw new Error(`PODIUM_DATA_DIR is required when PODIUM_DB is ${kind}://...`);
  return path.dirname(target);
}

/** PODIUM_DB is a SQLite file by default; `kind://target` picks another registered implementation. An unknown kind throws at once, not as a rejection. */
export function openStorage(env: NodeJS.ProcessEnv = process.env): Promise<Storage> {
  const { kind, target } = storageSpec(env); // throws now, before a loader runs or anything reads the path
  return registry.get(kind)!.load().then((open) => open(target));
}
