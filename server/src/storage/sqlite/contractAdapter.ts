// The SQLite adapter as the storage tests see it (#1008): one entry of the registry in `../index.ts`, like any other adapter.
import { rmSync } from 'node:fs';
import type { ContractAdapter, SchemaNames } from '../contractAdapter.js';
import type { DatabaseSync } from 'node:sqlite';
import { openSqliteStorage } from './index.js';
import { openUpgradedSqlite } from './upgradeTesting.js';

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
    openUpgraded: async (rows, reporters, sessions) => {
      const { storage, dir } = openUpgradedSqlite(rows, reporters, sessions);
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
    known: [],
    dispose: async () => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    },
  };
}
