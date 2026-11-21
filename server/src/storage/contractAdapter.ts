// What the storage tests need from an adapter (#1008). Every adapter registers one (the `testing` loader of its kind in `index.ts`), and
// the contract, the upgrade cases and the differential test all run over the list of them, so a new adapter is added in one place and no
// adapter is the reference for another. Types only: this file names no database.
import type { LegacyAdminRead, LegacyChat, LegacyExtras, LegacyMessage, LegacyPublicMessage, LegacyReporter, LegacyRequest, LegacyRight, LegacySession } from './contractUpgrade.js';
import type { Storage } from './types.js';

/** What an adapter's database holds, by name: each table with its columns, and the indexes. Names only; the types differ between databases. */
export interface SchemaNames {
  tables: Record<string, string[]>;
  indexes: string[];
}

/**
 * A defect of this adapter that another issue owns, found by the contract or the differential test (#1008). It is listed in the adapter's own folder with the
 * issue that fixes it, so the test keeps running and warns instead of failing; `PODIUM_DIFF_STRICT=1` makes it fail. It is never a way to make an adapter pass.
 */
export interface KnownDefect {
  /** Names a case (`outside call waits for the transaction`) or an input class. */
  id: string;
  issue: string;
  why: string;
  /** For an input class: true for a value that makes a call diverge. Absent for a case. */
  input?: (value: unknown) => boolean;
}

/**
 * A throwaway database of one adapter with the `samples` table to measure (#755), for `scripts/podium-perf-samples-index.ts`. The SQL that seeds the table, drops
 * and creates the index and reads its size is the adapter's own, so nothing outside the adapter folders writes SQL or imports a driver.
 */
export interface SamplesPerf {
  /** The value of PODIUM_DB that opens this database as a Storage. */
  podiumDb: string;
  /** Fills `samples` with `sessions` sessions of one sample a second for `seconds` seconds, the newest at second `endSec`. */
  seed(sessions: number, seconds: number, endSec: number): Promise<void>;
  dropIndex(): Promise<void>;
  createIndex(): Promise<void>;
  /** Bytes the `samples_t` index takes as the database reports them, or null when it cannot say. */
  indexBytes(): Promise<number | null>;
  rows(): Promise<number>;
  /** Closes the connection and removes the database. */
  close(): Promise<void>;
}

export interface ContractAdapter {
  /** The registry name of the kind. Failures name it. */
  name: string;
  /** The environment variable naming the server its tests run against, or null when the adapter needs none (a file or memory). */
  serverVar: string | null;
  /** True when its server is configured, so its tests can run. */
  available(): boolean;
  /** A fresh, empty storage. Its `close()` also removes whatever the adapter made for it. */
  open(): Promise<Storage>;
  /** A storage over a database made at the oldest supported schema and holding the given rows, opened (and so migrated). Closing it removes what was made. */
  openUpgraded(rows: LegacyRequest[], reporters?: LegacyReporter[], sessions?: LegacySession[], messages?: LegacyMessage[], rights?: LegacyRight[], adminReads?: LegacyAdminRead[], publicMessages?: LegacyPublicMessage[], extras?: LegacyExtras, chat?: LegacyChat): Promise<Storage>;
  /** The names of the tables, columns and indexes of a freshly opened database, both the main and the Activity one. Read from the database itself, not from the code that makes it. */
  schema(): Promise<SchemaNames>;
  /** A throwaway database with the `samples` table to measure (#755). Optional: only the measurement script asks for it. */
  samplesPerf?(): Promise<SamplesPerf>;
  /** Defects of this adapter that another issue owns. Empty when there are none. */
  known: KnownDefect[];
  /** Removes anything a failed test left behind. Called once after the adapter's suites. */
  dispose(): Promise<void>;
}
