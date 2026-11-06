// The PostgreSQL adapter as the storage tests see it (#1008): one entry of the registry in `../index.ts`, like any other adapter.
// Each storage gets a database of its own on the server `PODIUM_TEST_PG` names; closing the storage drops it, and `dispose` drops what a failed test left.
import pg from 'pg';
import type { ContractAdapter, SchemaNames } from '../contractAdapter.js';
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
    openUpgraded: async (rows, reporters, sessions, messages) => {
      const { storage, td } = await openUpgradedPostgres(rows, reporters, sessions, messages);
      return track(td, storage);
    },
    schema: async () => {
      const td = await createTestDatabase();
      const storage = await openPostgresStorage(target(td), 0);
      // The Activity store is built on demand, so ask for it before reading the catalog.
      storage.activity({ history: { now: () => 0, settings: () => ({ policy: 'default' }) as never, isLive: () => true, authOn: true, agentsOf: async () => [] }, recordings: { now: () => 0, settings: () => ({}) as never, flagOn: () => false, authOn: true, isLive: () => true, loopsOf: async () => [] } });
      const c = new pg.Client({ connectionString: td.url });
      await c.connect();
      try {
        const out: SchemaNames = { tables: {}, indexes: [] };
        const cols = await c.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema IN ('podium', 'podium_activity') ORDER BY table_name, column_name");
        for (const r of cols.rows as { table_name: string; column_name: string }[]) {
          if (r.table_name === 'schema_migrations') continue;
          (out.tables[r.table_name] ??= []).push(r.column_name);
        }
        // An index a primary key or unique constraint made for itself is the constraint's, as SQLite's autoindexes are left out on the other side.
        const idx = await c.query("SELECT indexname FROM pg_indexes WHERE schemaname IN ('podium', 'podium_activity') AND indexname NOT IN (SELECT conname FROM pg_constraint) ORDER BY indexname");
        out.indexes = (idx.rows as { indexname: string }[]).map((r) => r.indexname);
        return out;
      } finally {
        await c.end();
        await storage.close();
        await td.drop();
      }
    },
    known: [
      // Accepted by the maintainer (#1007): no typed validation layer is built. A NaN is not in this list: both adapters store it as NULL.
      { id: 'non-integer number', issue: '#1007', why: 'a fraction, an infinity or a number of 1e21 or more is sent to an integer column or compared with one: PostgreSQL throws and SQLite accepts it (the report validator and the query-number check refuse it before any store is called, so this is not reachable over HTTP)', input: (x) => typeof x === 'number' && !Number.isNaN(x) && !Number.isSafeInteger(x) },
    ],
    dispose: async () => {
      for (const { td, storage } of open.splice(0)) {
        await Promise.race([storage.close().catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
        await td.drop();
      }
    },
  };
}
