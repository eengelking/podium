// The SQLite adapter as the storage tests see it (#1008): one entry of the registry in `../index.ts`, like any other adapter.
import { rmSync } from 'node:fs';
import type { ContractAdapter, SchemaNames } from '../contractAdapter.js';
import { StatementSync, type DatabaseSync } from 'node:sqlite';
import { statementCount } from '../statementCount.js';
import { openSqliteStorage } from './index.js';
import { openUpgradedSqlite } from './upgradeTesting.js';
import { sqliteSamplesPerf } from './samplesPerf.js';

// The stores run every statement through a prepared one, so counting its three ways of running gives the number the other adapters count in their connection (#1309).
for (const way of ['run', 'get', 'all'] as const) {
  const run = StatementSync.prototype[way] as (...args: unknown[]) => unknown;
  StatementSync.prototype[way] = function (this: StatementSync, ...args: unknown[]) {
    statementCount.n++;
    return run.apply(this, args);
  } as never;
}

/** Tables the database keeps for itself, not part of the schema the app uses. */
const INTERNAL = /^(sqlite_|schema_migrations$)/;

function namesOf(db: DatabaseSync, into: SchemaNames): void {
  const rows = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all() as { type: string; name: string }[];
  for (const r of rows) {
    if (INTERNAL.test(r.name)) continue;
    if (r.type === 'index') into.indexes.push(r.name);
    else into.tables[r.name] = (db.prepare(`PRAGMA table_info(${r.name})`).all() as { name: string }[]).map((c) => c.name).sort((a, b) => a.localeCompare(b));
  }
}

export function sqliteContractAdapter(): ContractAdapter {
  const dirs: string[] = [];
  return {
    name: 'sqlite',
    serverVar: null,
    available: () => true,
    open: async () => openSqliteStorage(':memory:', 0),
    openUpgraded: async (rows, reporters, sessions, messages, rights, adminReads, publicMessages, extras, chat, daily) => {
      const { storage, dir } = openUpgradedSqlite(rows, reporters, sessions, messages, rights, adminReads, publicMessages, extras, chat, daily);
      dirs.push(dir);
      return storage;
    },
    schema: async () => {
      const s = openSqliteStorage(':memory:', 0) as unknown as { sqliteHandle: DatabaseSync; activityHandle(): DatabaseSync; close(): Promise<void> };
      const out: SchemaNames = { tables: {}, indexes: [] };
      try {
        namesOf(s.sqliteHandle, out);
        namesOf(s.activityHandle(), out);
      } finally {
        await s.close();
      }
      out.indexes.sort((a, b) => a.localeCompare(b));
      return out;
    },
    samplesPerf: async () => sqliteSamplesPerf(),
    known: [],
    dispose: async () => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    },
  };
}
