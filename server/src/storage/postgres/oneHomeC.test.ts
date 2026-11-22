// Step 36 of the main schema (#1296) keys an owner's defaults by the person's id alone, as SQLite migration 61 and MariaDB step 36 do. The contract's upgrade cases run on every adapter and read what a store gives
// back; this reads the table itself, on rows an older database holds.
import { afterAll, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';

describe.skipIf(!TEST_PG)('postgres step 36', () => {
  const open: { td: TestDatabase; db: PgDb }[] = [];
  afterAll(async () => {
    for (const { td, db } of open.splice(0)) {
      await db.close();
      await td.drop();
    }
  });
  const upTo = (version: number) => MAIN_STEPS.filter((s) => s.version <= version);
  const columns = async (db: PgDb, table: string): Promise<string[]> => (await db.all<{ column_name: string }>('SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position', [MAIN_SCHEMA, table])).map((r) => r.column_name);
  const indexes = async (db: PgDb, table: string): Promise<string[]> => (await db.all<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = ? AND tablename = ? AND indexname NOT LIKE '%_pkey' ORDER BY indexname", [MAIN_SCHEMA, table])).map((r) => r.indexname);
  const key = async (db: PgDb, table: string): Promise<string[]> =>
    (await db.all<{ attname: string }>(
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = ?::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`,
      [`${MAIN_SCHEMA}.${table}`],
    )).map((r) => r.attname);

  it('keeps each row under its id, drops the name key and its index, drops a row with no id and the rows of an id held twice, and runs once', async () => {
    const td = await createTestDatabase();
    const db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 4, name: 'test' });
    open.push({ td, db });
    await migrate(db, MAIN_SCHEMA, upTo(35));
    expect(await columns(db, 'peer_owner_settings')).toEqual(['owner_lower', 'trust', 'on_request', 'new_send', 'limits_json', 'owner_id']);
    expect(await key(db, 'peer_owner_settings')).toEqual(['owner_lower']);
    expect(await indexes(db, 'peer_owner_settings')).toEqual(['peer_owner_settings_owner_id']);
    // Ids 11 and 12 as the server writes them (the key is the id as text); 14 whose key is not its id (nothing writes that, and every reader goes by `owner_id`); `ghost` with no id; and 13 held twice.
    await db.run(
      `INSERT INTO peer_owner_settings (owner_lower, owner_id, trust, on_request, new_send, limits_json) VALUES
        ('11', 11, 1, 'send', 'ask', '{"roundTrips":3}'), ('12', 12, 0, 'ask', 'send', NULL), ('x14', 14, 1, 'ask', 'ask', NULL),
        ('ghost', NULL, 1, 'send', 'send', NULL), ('13', 13, 1, 'send', 'send', NULL), ('ed', 13, 0, 'ask', 'ask', NULL)`,
    );
    await migrate(db, MAIN_SCHEMA, upTo(36));
    expect(await columns(db, 'peer_owner_settings')).toEqual(['trust', 'on_request', 'new_send', 'limits_json', 'owner_id']);
    expect(await key(db, 'peer_owner_settings')).toEqual(['owner_id']);
    expect(await indexes(db, 'peer_owner_settings')).toEqual([]);
    expect(await db.all('SELECT owner_id, trust, on_request, new_send, limits_json FROM peer_owner_settings ORDER BY owner_id')).toEqual([
      { owner_id: 11, trust: 1, on_request: 'send', new_send: 'ask', limits_json: '{"roundTrips":3}' },
      { owner_id: 12, trust: 0, on_request: 'ask', new_send: 'send', limits_json: null },
      { owner_id: 14, trust: 1, on_request: 'ask', new_send: 'ask', limits_json: null },
    ]);
    await expect(db.run("INSERT INTO peer_owner_settings (owner_id, trust, on_request, new_send) VALUES (11, 0, 'ask', 'ask')")).rejects.toThrow(/duplicate key/);
    // The step ran once: migrating again changes nothing.
    await migrate(db, MAIN_SCHEMA, upTo(36));
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM peer_owner_settings'))!.n).toBe(3);
  });
});
