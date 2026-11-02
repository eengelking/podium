// Test support for the upgrade contract (#892): a PostgreSQL database at the schema before peer requests had an insertion number (main step 1),
// holding the given requests in the order given. Opening it as a storage then runs step 2 on rows that exist. The caller drops the database.
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { openPostgresStorage } from './index.js';
import { createTestDatabase, type TestDatabase } from './testing.js';
import type { LegacyRequest } from '../contractUpgrade.js';
import type { Storage } from '../types.js';

export async function openUpgradedPostgres(rows: LegacyRequest[]): Promise<{ storage: Storage; td: TestDatabase }> {
  const td = await createTestDatabase();
  try {
    return { storage: await build(td, rows), td };
  } catch (e) {
    await td.drop();
    throw e;
  }
}

async function build(td: TestDatabase, rows: LegacyRequest[]): Promise<Storage> {
  const old = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 2, name: 'test' });
  try {
    await migrate(old, MAIN_SCHEMA, MAIN_STEPS.slice(0, 1));
    for (const r of rows) {
      await old.run(
        `INSERT INTO peer_requests (id, owner, kind, from_key, to_key, level, reason, by, from_session, message_id, created_at, closed_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [r.id, r.owner, r.kind, r.fromKey, r.toKey, r.level, r.reason, r.by, r.fromSession, r.createdAt, r.closedAt, r.outcome],
      );
    }
  } finally {
    await old.close();
  }
  return openPostgresStorage(td.url.replace(/^postgres:\/\//, ''), 0);
}
