// What the storage tests need from an adapter (#1008). Every adapter registers one (the `testing` loader of its kind in `index.ts`), and
// the contract, the upgrade cases and the differential test all run over the list of them, so a new adapter is added in one place and no
// adapter is the reference for another. Types only: this file names no database.
import type { LegacyReporter, LegacyRequest, LegacySession } from './contractUpgrade.js';
import type { Storage } from './types.js';

export interface ContractAdapter {
  /** The registry name of the kind (`sqlite`, `postgres`, ...). Failures name it. */
  name: string;
  /** The environment variable naming the server its tests run against, or null when the adapter needs none (a file or memory). */
  serverVar: string | null;
  /** True when its server is configured, so its tests can run. */
  available(): boolean;
  /** A fresh, empty storage. Its `close()` also removes whatever the adapter made for it. */
  open(): Promise<Storage>;
  /** A storage over a database made at the oldest supported schema and holding the given rows, opened (and so migrated). Closing it removes what was made. */
  openUpgraded(rows: LegacyRequest[], reporters?: LegacyReporter[], sessions?: LegacySession[]): Promise<Storage>;
  /** Removes anything a failed test left behind. Called once after the adapter's suites. */
  dispose(): Promise<void>;
}
