// Test support for the upgrade contract (#892): a PostgreSQL database at the schema before peer requests had an insertion number and reporters a name (main step 1),
// holding the given requests in the order given. Opening it as a storage then runs step 2 on rows that exist. The caller drops the database.
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { openPostgresStorage } from './index.js';
import { createTestDatabase, type TestDatabase } from './testing.js';
import type { LegacyReporter, LegacyRequest } from '../contractUpgrade.js';
import type { Storage } from '../types.js';

export async function openUpgradedPostgres(rows: LegacyRequest[], reporters: LegacyReporter[] = []): Promise<{ storage: Storage; td: TestDatabase }> {
  const td = await createTestDatabase();
  try {
    return { storage: await build(td, rows, reporters), td };
  } catch (e) {
    await td.drop();
    throw e;
  }
}

async function build(td: TestDatabase, rows: LegacyRequest[], reporters: LegacyReporter[]): Promise<Storage> {
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
    for (const r of reporters) {
      await old.run(
        `INSERT INTO reporters (key, kind, machine_id, machine_name, owner, reporter_version, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.key, r.kind, r.machineId, r.machineName, r.owner, r.version, r.firstSeenAt, r.lastSeenAt],
      );
    }
  } finally {
    await old.close();
  }
  return openPostgresStorage(td.url.replace(/^postgres:\/\//, ''), 0);
}
