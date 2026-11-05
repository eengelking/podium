// The SQLite adapter as the storage tests see it (#1008): one entry of the registry in `../index.ts`, like any other adapter.
import { rmSync } from 'node:fs';
import type { ContractAdapter } from '../contractAdapter.js';
import { openSqliteStorage } from './index.js';
import { openUpgradedSqlite } from './upgradeTesting.js';

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
    dispose: async () => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    },
  };
}
