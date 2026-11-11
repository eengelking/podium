import path from 'node:path';
import { repoRoot } from '../serverRoot.js';
import type { Storage } from './types.js';
import type { ContractAdapter } from './contractAdapter.js';

export type { Storage, FleetStore, FleetStoreApi, PeerSettingsStoreApi, PeerRightsStoreApi, PeopleStoreApi, ReporterStoreApi, AsyncPeerReporterLookup,
  FeatureFlagsApi, PeerStoreApi, ActivityStorage, ActivityStoreOptions, ActivityHistoryApi, ActivityHistoryOptions, SessionRecordingsApi, RecordingsOptions, PeerStoreOptions, WallSettingsApi, ModelPricesApi, RecordingSettingsApi, ActivityHistorySettingsApi, TlsSettingsApi, PersonCertsApi } from './types.js';

/** Opens the storage a target names. `target` is what follows the kind: a file for a file-based kind. */
export type StorageOpener = (target: string) => Storage | Promise<Storage>;

/** Imports a kind's adapter module and returns its opener. Called only when that kind is chosen, so a server never loads another kind's driver. */
export type StorageLoader = () => Promise<StorageOpener>;

/** A registered implementation. `fileBased` is true when its target is a file, so the folder holding it is a data directory. `defaultTarget` is what it opens when PODIUM_DB is not set. */
export interface StorageKind {
  fileBased: boolean;
  defaultTarget(): string;
  load: StorageLoader;
  /** What the log and the health check show for a target. It never carries a password. */
  label(target: string): string;
  /** Imports the adapter's entry for the storage tests (#1008). The contract, the upgrade cases and the differential test run over every kind that has one. */
  testing?: () => Promise<ContractAdapter>;
}

/** The kind PODIUM_DB means when it names none: a plain path or `:memory:`, or nothing at all. */
export const DEFAULT_STORAGE_KIND = 'sqlite';

const REPO_ROOT = repoRoot(import.meta.url);

/** The one place that knows which implementations exist: a new database is a registration here. */
const registry = new Map<string, StorageKind>([
  [DEFAULT_STORAGE_KIND, { fileBased: true, defaultTarget: () => path.join(REPO_ROOT, 'data', 'podium.sqlite'), load: async () => (await import('./sqlite/index.js')).openSqliteStorage, label: (target) => target,
    testing: async () => (await import('./sqlite/contractAdapter.js')).sqliteContractAdapter() }],
  ['postgres', {
    fileBased: false,
    defaultTarget: () => { throw new Error('postgres has no default target'); },
    load: async () => (await import('./postgres/index.js')).openPostgresStorage,
    testing: async () => (await import('./postgres/contractAdapter.js')).postgresContractAdapter(),
    label: (target) => (URL.canParse(`postgres://${target}`) ? hostLabel(new URL(`postgres://${target}`)) : 'postgres://<unparseable>'),
  }],
  ['mariadb', {
    fileBased: false,
    defaultTarget: () => { throw new Error('mariadb has no default target'); },
    load: async () => (await import('./mariadb/index.js')).openMariaDbStorage,
    testing: async () => (await import('./mariadb/contractAdapter.js')).mariadbContractAdapter(),
    label: (target) => (URL.canParse(`mariadb://${target}`) ? hostLabel(new URL(`mariadb://${target}`)) : 'mariadb://<unparseable>'),
  }],
]);

/** `host:port/dbname`, with no user and no password. */
function hostLabel(u: URL): string {
  return `${u.host}${u.pathname}`;
}

/** Other schemes that mean a registered kind. */
const ALIASES = new Map([['postgresql', 'postgres']]);

/** Adds a kind to the registry and returns a function that removes it again. For tests: the server registers its own kinds above. A kind with no `defaultTarget` cannot be the default. */
export function registerStorageKind(kind: string, entry: Omit<StorageKind, 'defaultTarget' | 'label'> & Partial<Pick<StorageKind, 'defaultTarget' | 'label'>>): () => void {
  registry.set(kind, { defaultTarget: () => { throw new Error(`${kind} has no default target`); }, label: (target) => target, ...entry });
  return () => { registry.delete(kind); };
}

/** The names of the registered kinds that have an entry for the storage tests, in registration order. Tests only. */
export const testedStorageKinds = (): string[] => [...registry].filter(([, k]) => k.testing).map(([name]) => name);

/** The storage tests' entry for a registered kind (#1008). Tests only. */
export async function contractAdapterFor(kind: string): Promise<ContractAdapter> {
  const entry = registry.get(kind);
  if (!entry?.testing) throw new Error(`storage kind "${kind}" has no entry for the storage tests`);
  return entry.testing();
}

/** The default kind's default target: what the server opens when PODIUM_DB is unset or empty. */
export const defaultDbFile = (): string => registry.get(DEFAULT_STORAGE_KIND)!.defaultTarget();

/**
 * What PODIUM_DB names: the kind of storage and its target. A plain path or `:memory:` is a SQLite file; `kind://target`
 * picks another registered kind, and an unregistered one throws. `target` is also what the rest of the server derives
 * its label in the log and the health check, so `sqlite://x` and `x` agree.
 */
export function storageSpec(env: NodeJS.ProcessEnv = process.env): { kind: string; target: string; label: string } {
  const value = env.PODIUM_DB || defaultDbFile();
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/.exec(value);
  const named = m ? m[1]! : DEFAULT_STORAGE_KIND;
  const kind = ALIASES.get(named) ?? named;
  if (!registry.has(kind)) throw new Error(`PODIUM_DB: unknown storage kind "${named}" (known: ${[...registry.keys()].join(', ')})`);
  const target = m ? m[2]! : value;
  return { kind, target, label: registry.get(kind)!.label(target) };
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
