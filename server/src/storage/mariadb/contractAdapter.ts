// The MariaDB adapter as the storage tests see it (#1008, #823): one entry of the registry in `../index.ts`, like any other adapter.
// Each storage gets a database of its own on the server `PODIUM_TEST_MARIADB` names; closing the storage drops it, and `dispose` drops what a failed test left.
import type { ContractAdapter, SchemaNames } from '../contractAdapter.js';
import type { Storage } from '../types.js';
import { openMariaDbStorage } from './index.js';
import { openUpgradedMariaDb } from './upgradeTesting.js';
import { ACTIVITY_MIGRATIONS, CONSTRAINT_INDEX, MAIN_MIGRATIONS } from './schema.js';
import { TEST_MARIADB, createTestDatabase, withConnection, type TestDatabase } from './testing.js';

const target = (td: TestDatabase): string => td.url.replace(/^mariadb:\/\//, '');

/** What the database holds, by name, read from its catalog: every table but the two records of applied steps, and every index a constraint did not make. */
export async function readSchema(url: string, database: string): Promise<SchemaNames> {
  return withConnection(url, async (c) => {
    const out: SchemaNames = { tables: {}, indexes: [] };
    const cols = await c.query<{ table_name: string; column_name: string }[]>(
      'SELECT table_name AS table_name, column_name AS column_name FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, column_name',
      [database],
    );
    for (const r of cols) {
      if (r.table_name === MAIN_MIGRATIONS || r.table_name === ACTIVITY_MIGRATIONS) continue;
      (out.tables[r.table_name] ??= []).push(r.column_name);
    }
    // An index MariaDB made for a primary key, a unique constraint or a foreign key is the constraint's, as SQLite's autoindexes are left out on the other side.
    const idx = await c.query<{ index_name: string }[]>('SELECT DISTINCT index_name AS index_name FROM information_schema.statistics WHERE table_schema = ? ORDER BY index_name', [database]);
    out.indexes = idx.map((r) => r.index_name).filter((n) => !CONSTRAINT_INDEX.test(n));
    return out;
  });
}

export function mariadbContractAdapter(): ContractAdapter {
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
    name: 'mariadb',
    serverVar: 'PODIUM_TEST_MARIADB',
    available: () => Boolean(TEST_MARIADB),
    open: async () => {
      const td = await createTestDatabase();
      return track(td, await openMariaDbStorage(target(td), 0));
    },
    openUpgraded: async (rows, reporters, sessions, messages, rights, adminReads) => {
      const { storage, td } = await openUpgradedMariaDb(rows, reporters, sessions, messages, rights, adminReads);
      return track(td, storage);
    },
    schema: async () => {
      const td = await createTestDatabase();
      const storage = await openMariaDbStorage(target(td), 0);
      try {
        // The Activity store is built on demand, so ask for it before reading the catalog.
        storage.activity({ history: { now: () => 0, settings: () => ({ policy: 'default' }) as never, isLive: () => true, authOn: true, agentsOf: async () => [] }, recordings: { now: () => 0, settings: () => ({}) as never, flagOn: () => false, authOn: true, isLive: () => true, loopsOf: async () => [] } });
        return await readSchema(td.url, td.name);
      } finally {
        await storage.close();
        await td.drop();
      }
    },
    known: [
      // As on PostgreSQL (#1007), no typed validation layer is built. What MariaDB does with such a number (#823): a fraction sent to an
      // integer column is rounded half away from zero and stored with no error (1.5 is stored as 2, -2.5 as -3), a number of 1e21 or more
      // is refused (out of range), and an infinity is refused before it is sent (`bound()` in conn.ts). SQLite stores the fraction as it is
      // and PostgreSQL throws for all three. The report validator and the query-number check refuse them before any store is called, so this
      // is not reachable over HTTP. A NaN is not in this list: every adapter stores it as NULL.
      { id: 'non-integer number', issue: '#823', why: 'a fraction, an infinity or a number of 1e21 or more is sent to an integer column or compared with one: MariaDB rounds a fraction to the nearest whole number and refuses the others, SQLite accepts each as it is (not reachable over HTTP)', input: (x) => typeof x === 'number' && !Number.isNaN(x) && !Number.isSafeInteger(x) },
    ],
    dispose: async () => {
      for (const { td, storage } of open.splice(0)) {
        await Promise.race([storage.close().catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
        await td.drop();
      }
    },
  };
}
