// The PostgreSQL adapter as the storage tests see it (#1008): one entry of the registry in `../index.ts`, like any other adapter.
// Each storage gets a database of its own on the server `PODIUM_TEST_PG` names; closing the storage drops it, and `dispose` drops what a failed test left.
import type { ContractAdapter } from '../contractAdapter.js';
import type { Storage } from '../types.js';
import { openPostgresStorage } from './index.js';
import { openUpgradedPostgres } from './upgradeTesting.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';

const target = (td: TestDatabase): string => td.url.replace(/^postgres:\/\//, '');

export function postgresContractAdapter(): ContractAdapter {
  const open: { td: TestDatabase; storage: Storage }[] = [];
  const track = (td: TestDatabase, storage: Storage): Storage => {
    const entry = { td, storage };
    open.push(entry);
    return {
      ...storage,
      close: async () => {
        await storage.close();
        await td.drop();
        open.splice(open.indexOf(entry), 1);
      },
    };
  };
  return {
    name: 'postgres',
    serverVar: 'PODIUM_TEST_PG',
    available: () => Boolean(TEST_PG),
    open: async () => {
      const td = await createTestDatabase();
      return track(td, await openPostgresStorage(target(td), 0));
    },
    openUpgraded: async (rows, reporters, sessions) => {
      const { storage, td } = await openUpgradedPostgres(rows, reporters, sessions);
      return track(td, storage);
    },
    dispose: async () => {
      for (const { td, storage } of open.splice(0)) {
        await Promise.race([storage.close().catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
        await td.drop();
      }
    },
  };
}
