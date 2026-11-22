// Steps 32 to 34 of the main schema (#1296) keep a delivery by its message alone and an Admin record's owed rows by the person's id, and drop the list of who had seen a record, as SQLite migrations 56 to 58
// do. The contract's upgrade cases run on every adapter and read what a store gives back; these read the tables themselves, on rows an older database holds.
import { afterAll, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';

describe.skipIf(!TEST_PG)('postgres steps 32 to 34', () => {
  const open: { td: TestDatabase; db: PgDb }[] = [];
  afterAll(async () => {
    for (const { td, db } of open.splice(0)) {
      await db.close();
      await td.drop();
    }
  });
  /** A database of its own, with the steps up to `version` made. */
  const database = async (version: number): Promise<PgDb> => {
    const td = await createTestDatabase();
    const db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 4, name: 'test' });
    open.push({ td, db });
    await migrate(db, MAIN_SCHEMA, upTo(version));
    return db;
  };

  const columns = async (db: PgDb, table: string): Promise<string[]> => (await db.all<{ column_name: string }>('SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position', [MAIN_SCHEMA, table])).map((r) => r.column_name);
  const indexes = async (db: PgDb, table: string): Promise<string[]> => (await db.all<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = ? AND tablename = ? AND indexname NOT LIKE '%_pkey' ORDER BY indexname", [MAIN_SCHEMA, table])).map((r) => r.indexname);
  const key = async (db: PgDb, table: string): Promise<string[]> =>
    (await db.all<{ attname: string }>(
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = ?::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`,
      [`${MAIN_SCHEMA}.${table}`],
    )).map((r) => r.attname);
  const upTo = (version: number) => MAIN_STEPS.filter((s) => s.version <= version);

  it('step 32 keeps every delivery under its message, drops the conversation column, has the one key, and runs once', async () => {
    const db = await database(31);
    expect(await columns(db, 'conversation_deliveries')).toEqual(['conversation_id', 'message_id', 'member_kind', 'member_ref', 'member_name', 'named', 'state', 'state_at']);
    await db.run("INSERT INTO conversations (id, created_at, members_key) VALUES ('cnv_1', 1, 'k1'), ('cnv_2', 2, 'k2')");
    await db.run(
      `INSERT INTO conversation_messages (id, conversation_id, author_kind, author_ref, author_name, text, created_at, seq) VALUES
        ('cmg_a', 'cnv_1', 'person', '1', 'Ed', 'one', 10, 1), ('cmg_b', 'cnv_1', 'person', '1', 'Ed', 'two', 11, 2), ('cmg_c', 'cnv_2', 'person', '2', 'Maya', 'three', 12, 3)`,
    );
    await db.run(
      `INSERT INTO conversation_deliveries (conversation_id, message_id, member_kind, member_ref, member_name, named, state, state_at) VALUES
        ('cnv_1', 'cmg_a', 'agent', 'sess-tester', 'Tester', 1, 'delivered', 20),
        ('cnv_1', 'cmg_a', 'agent', 'sess-notes', 'infra-notes', 0, 'queued', 21),
        ('cnv_1', 'cmg_b', 'person', '2', 'Maya Kim', 1, NULL, NULL),
        ('cnv_2', 'cmg_c', 'agent', 'sess-tester', 'Tester', 0, 'dropped', 22)`,
    );
    await migrate(db, MAIN_SCHEMA, upTo(32));
    expect(await columns(db, 'conversation_deliveries')).toEqual(['message_id', 'member_kind', 'member_ref', 'member_name', 'named', 'state', 'state_at']);
    expect(await key(db, 'conversation_deliveries')).toEqual(['message_id', 'member_kind', 'member_ref']);
    expect(await db.all('SELECT message_id, member_kind, member_ref, member_name, named, state, state_at FROM conversation_deliveries ORDER BY message_id, member_kind, member_ref')).toEqual([
      { message_id: 'cmg_a', member_kind: 'agent', member_ref: 'sess-notes', member_name: 'infra-notes', named: 0, state: 'queued', state_at: 21 },
      { message_id: 'cmg_a', member_kind: 'agent', member_ref: 'sess-tester', member_name: 'Tester', named: 1, state: 'delivered', state_at: 20 },
      { message_id: 'cmg_b', member_kind: 'person', member_ref: '2', member_name: 'Maya Kim', named: 1, state: null, state_at: null },
      { message_id: 'cmg_c', member_kind: 'agent', member_ref: 'sess-tester', member_name: 'Tester', named: 0, state: 'dropped', state_at: 22 },
    ]);
    await expect(db.run("INSERT INTO conversation_deliveries (message_id, member_kind, member_ref, member_name, named) VALUES ('cmg_a', 'agent', 'sess-tester', 'Tester', 0)")).rejects.toThrow(/duplicate key/);
    // The step ran once: running the steps again changes nothing.
    await migrate(db, MAIN_SCHEMA, upTo(32));
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversation_deliveries'))!.n).toBe(4);
  });

  const records = async (db: PgDb): Promise<void> => {
    await db.run("INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES ('Ed', 'ed', 'k1', ?, 1000), ('Eve', 'eve', 'k2', ?, 1000)", ['0'.repeat(64), '0'.repeat(64)]);
    await db.run(
      `INSERT INTO chat_admin_reads (thread, admin_key, admin, started_at, last_seen_at, kind, people, seen) VALUES
        ('dm:a|b', '#9', 'Root', 100, 110, 'read', '[1,2]', '[2]'),
        ('group:1', '#9', 'Root', 200, 210, 'cleared', '[1]', '[]'),
        ('act:1', 'root', 'Root', 300, 310, 'read', '[]', '[]')`,
    );
  };

  it('step 33 keeps each person\'s owed rows by the id alone, drops the rows of no person, drops the name key and the second index', async () => {
    const db = await database(32);
    expect(await columns(db, 'chat_admin_owed')).toEqual(['person_key', 'thread', 'admin_key', 'started_at', 'person_id']);
    expect(await indexes(db, 'chat_admin_owed')).toEqual(['chat_admin_owed_person', 'chat_admin_owed_record']);
    await records(db);
    await db.run("INSERT INTO settings (key, value) VALUES ('chat_admin_owed_filled', '1')");
    await db.run(
      `INSERT INTO chat_admin_owed (person_key, person_id, thread, admin_key, started_at) VALUES
        ('#1', 1, 'dm:a|b', '#9', 100), ('#1', 1, 'group:1', '#9', 200), ('#2', 2, 'dm:a|b', '#9', 100), ('ghost', NULL, 'dm:a|b', '#9', 100)`,
    );
    await migrate(db, MAIN_SCHEMA, upTo(33));
    expect(await columns(db, 'chat_admin_owed')).toEqual(['thread', 'admin_key', 'started_at', 'person_id']);
    expect(await key(db, 'chat_admin_owed')).toEqual(['person_id', 'thread', 'admin_key', 'started_at']);
    expect(await indexes(db, 'chat_admin_owed')).toEqual(['chat_admin_owed_record']);
    // The rows the table held are all there under the person's id, and the row of no person is gone. The fill had run already (its mark is in `settings`), so it adds nothing.
    expect(await db.all('SELECT person_id, thread, admin_key, started_at FROM chat_admin_owed ORDER BY person_id, thread, started_at')).toEqual([
      { person_id: 1, thread: 'dm:a|b', admin_key: '#9', started_at: 100 },
      { person_id: 1, thread: 'group:1', admin_key: '#9', started_at: 200 },
      { person_id: 2, thread: 'dm:a|b', admin_key: '#9', started_at: 100 },
    ]);
    await expect(db.run("INSERT INTO chat_admin_owed (person_id, thread, admin_key, started_at) VALUES (1, 'dm:a|b', '#9', 100)")).rejects.toThrow(/duplicate key/);
    await migrate(db, MAIN_SCHEMA, upTo(33));
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_admin_owed'))!.n).toBe(3);
  });

  it('steps 33 and 34 owe, once, the people an older record\'s lists name who had not seen it, before the list of who had seen it goes, and keep the record and the people it was made with', async () => {
    const db = await database(32);
    await records(db);
    await migrate(db, MAIN_SCHEMA, upTo(33));
    // Person 1 is owed both records that name them; person 2 saw the one they were named in, so is owed none; the record that names nobody is owed to nobody.
    expect(await db.all('SELECT person_id, thread, admin_key, started_at FROM chat_admin_owed ORDER BY person_id, thread, started_at')).toEqual([
      { person_id: 1, thread: 'dm:a|b', admin_key: '#9', started_at: 100 },
      { person_id: 1, thread: 'group:1', admin_key: '#9', started_at: 200 },
    ]);
    expect(await db.all("SELECT value FROM settings WHERE key = 'chat_admin_owed_filled'")).toEqual([{ value: '1' }]);
    expect(await columns(db, 'chat_admin_reads')).toContain('seen');
    await migrate(db, MAIN_SCHEMA, upTo(34));
    expect(await columns(db, 'chat_admin_reads')).toEqual(['thread', 'admin_key', 'admin', 'started_at', 'last_seen_at', 'kind', 'people']);
    expect(await db.all('SELECT thread, admin, started_at, last_seen_at, kind, people FROM chat_admin_reads ORDER BY started_at')).toEqual([
      { thread: 'dm:a|b', admin: 'Root', started_at: 100, last_seen_at: 110, kind: 'read', people: '[1,2]' },
      { thread: 'group:1', admin: 'Root', started_at: 200, last_seen_at: 210, kind: 'cleared', people: '[1]' },
      { thread: 'act:1', admin: 'Root', started_at: 300, last_seen_at: 310, kind: 'read', people: '[]' },
    ]);
    // Run again, nothing is added.
    await migrate(db, MAIN_SCHEMA, upTo(34));
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_admin_owed'))!.n).toBe(2);
  });

  it('step 35 adds an index that begins with seq to each of five tables and one on peer_messages(owner_id), and the statements that read a whole table read an index', async () => {
    const db = await database(34);
    const tables = ['peer_messages', 'group_messages', 'public_messages', 'conversation_messages', 'peer_requests'];
    for (const t of tables) expect(await indexes(db, t), t).not.toContain(`${t}_counter`);
    // A table the planner will not scan: 20,000 rows made from the columns that must have a value, `seq` counting up and the owner one of 50.
    for (const t of tables) {
      const need = (await db.all<{ column_name: string; data_type: string }>("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND (column_name = 'seq' OR (is_nullable = 'NO' AND column_default IS NULL)) ORDER BY ordinal_position", [MAIN_SCHEMA, t]));
      const value = (c: { column_name: string; data_type: string }): string => (c.column_name === 'seq' ? 'i' : c.data_type === 'text' ? `'${c.column_name}-' || i` : 'i');
      await db.run(`INSERT INTO ${t} (${need.map((c) => c.column_name).join(', ')}) SELECT ${need.map(value).join(', ')} FROM generate_series(1, 20000) AS i`);
    }
    await db.run('UPDATE peer_messages SET owner_id = seq % 50');
    const plan = async (sql: string): Promise<string> => (await db.all<Record<string, string>>(`EXPLAIN ${sql}`)).map((r) => Object.values(r)[0]).join(' | ');
    await db.run('ANALYZE');
    expect(await plan('SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_messages')).toMatch(/Seq Scan/);
    await migrate(db, MAIN_SCHEMA, upTo(35));
    await db.run('ANALYZE');
    for (const t of tables) {
      expect(await indexes(db, t), t).toContain(`${t}_counter`);
      // The statement each insert runs to number its row reads the last entry of the index, and so costs the same at any size.
      expect(await plan(`SELECT COALESCE(MAX(seq), 0) + 1 FROM ${t}`), t).toMatch(new RegExp(`Index Only Scan Backward using ${t}_counter`));
    }
    expect(await plan('SELECT id FROM peer_messages WHERE owner_id = 7')).toMatch(/peer_messages_owner/);
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM peer_messages'))!.n).toBe(20000);
    await migrate(db, MAIN_SCHEMA, upTo(35));
  });
});
