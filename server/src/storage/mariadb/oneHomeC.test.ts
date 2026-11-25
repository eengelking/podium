// Step 36 of the main schema (#1296) keys an owner's defaults by the person's id alone, as SQLite migration 61 and PostgreSQL step 36 do. The contract's upgrade cases run on every adapter and read what a store gives
// back; this reads the table itself, on rows an older database holds, and runs the step again after it stopped half way, which MariaDB needs because its statements are not one transaction.
import { afterAll, describe, expect, it } from 'vitest';
import { MariaDbConn, parseTarget } from './conn.js';
import { MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { TEST_MARIADB, createTestDatabase, type TestDatabase } from './testing.js';

describe.skipIf(!TEST_MARIADB)('mariadb step 36', () => {
  const open: { td: TestDatabase; db: MariaDbConn }[] = [];
  afterAll(async () => {
    for (const { td, db } of open.splice(0)) {
      await db.close();
      await td.drop();
    }
  });
  const upTo = (version: number) => MAIN_STEPS.filter((s) => s.version <= version);
  const columns = async (db: MariaDbConn, table: string): Promise<string[]> => (await db.all<{ column_name: string }>('SELECT column_name AS column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position', [table])).map((r) => r.column_name);
  const indexes = async (db: MariaDbConn, table: string): Promise<string[]> => (await db.all<{ index_name: string }>("SELECT DISTINCT index_name AS index_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name <> 'PRIMARY' ORDER BY index_name", [table])).map((r) => r.index_name);
  const key = async (db: MariaDbConn, table: string): Promise<string[]> => (await db.all<{ column_name: string }>("SELECT column_name AS column_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position", [table])).map((r) => r.column_name);
  /** Stops the runner before statement `index` of step `version`, as a crash would. */
  const stopAt = (version: number, index: number) => (v: number, i: number) => {
    if (v === version && i === index) throw new Error('stopped');
  };

  /** A database at step 35 with the rows of an older one: ids 11 and 12 as the server writes them (the key is the id as text); 14 whose key is not its id (nothing writes that, and every reader goes by `owner_id`); `ghost` with no id; and 13 held twice. */
  const older = async (): Promise<MariaDbConn> => {
    const td = await createTestDatabase();
    const db = new MariaDbConn({ target: parseTarget(td.url), max: 4 });
    open.push({ td, db });
    await migrate(db, MAIN_MIGRATIONS, upTo(35));
    expect(await columns(db, 'peer_owner_settings')).toEqual(['owner_lower', 'trust', 'on_request', 'new_send', 'limits_json', 'owner_id']);
    expect(await key(db, 'peer_owner_settings')).toEqual(['owner_lower']);
    expect(await indexes(db, 'peer_owner_settings')).toEqual(['peer_owner_settings_owner_id']);
    await db.run(
      `INSERT INTO peer_owner_settings (owner_lower, owner_id, trust, on_request, new_send, limits_json) VALUES
        ('11', 11, 1, 'send', 'ask', '{"roundTrips":3}'), ('12', 12, 0, 'ask', 'send', NULL), ('x14', 14, 1, 'ask', 'ask', NULL),
        ('ghost', NULL, 1, 'send', 'send', NULL), ('13', 13, 1, 'send', 'send', NULL), ('ed', 13, 0, 'ask', 'ask', NULL)`,
    );
    return db;
  };
  const after = async (db: MariaDbConn): Promise<void> => {
    expect(await columns(db, 'peer_owner_settings')).toEqual(['trust', 'on_request', 'new_send', 'limits_json', 'owner_id']);
    expect(await key(db, 'peer_owner_settings')).toEqual(['owner_id']);
    expect(await indexes(db, 'peer_owner_settings')).toEqual([]);
    expect(await db.all('SELECT owner_id, trust, on_request, new_send, limits_json FROM peer_owner_settings ORDER BY owner_id')).toEqual([
      { owner_id: 11, trust: 1, on_request: 'send', new_send: 'ask', limits_json: '{"roundTrips":3}' },
      { owner_id: 12, trust: 0, on_request: 'ask', new_send: 'send', limits_json: null },
      { owner_id: 14, trust: 1, on_request: 'ask', new_send: 'ask', limits_json: null },
    ]);
  };

  it('keeps each row under its id, drops the name key and its index, drops a row with no id and the rows of an id held twice, and runs once', async () => {
    const db = await older();
    await migrate(db, MAIN_MIGRATIONS, upTo(36));
    await after(db);
    await expect(db.run("INSERT INTO peer_owner_settings (owner_id, trust, on_request, new_send) VALUES (11, 0, 'ask', 'ask')")).rejects.toThrow(/Duplicate entry/);
    // The step ran once: migrating again changes nothing.
    await migrate(db, MAIN_MIGRATIONS, upTo(36));
    await after(db);
  });

  it('runs again after it stopped before the change of the key, and after the change ran and the step was not recorded', async () => {
    const db = await older();
    // The step stops after the rows are deleted and before the key is changed, and is run again from its start.
    await expect(migrate(db, MAIN_MIGRATIONS, upTo(36), stopAt(36, 1))).rejects.toThrow('stopped');
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM peer_owner_settings'))!.n).toBe(3);
    await migrate(db, MAIN_MIGRATIONS, upTo(36));
    await after(db);
    // The change ran and the step was not recorded: it is run again from its start, finds the key, the index and the column as they are, and ends in the same state.
    await db.run(`DELETE FROM ${MAIN_MIGRATIONS} WHERE version = ?`, [36]);
    await migrate(db, MAIN_MIGRATIONS, upTo(36));
    await after(db);
  });
});
