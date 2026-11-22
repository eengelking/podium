// Steps 32 to 34 of the main schema (#1296) keep a delivery by its message alone and an Admin record's owed rows by the person's id, and drop the list of who had seen a record, as SQLite migrations 56 to 58
// do. The contract's upgrade cases run on every adapter and read what a store gives back; these read the tables themselves, on rows an older database holds, and run a step again after it stopped
// half way, which MariaDB needs because its statements are not one transaction.
import { afterAll, describe, expect, it } from 'vitest';
import { MariaDbConn, parseTarget } from './conn.js';
import { MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { TEST_MARIADB, createTestDatabase, type TestDatabase } from './testing.js';

describe.skipIf(!TEST_MARIADB)('mariadb steps 32 to 34', () => {
  const open: { td: TestDatabase; db: MariaDbConn }[] = [];
  afterAll(async () => {
    for (const { td, db } of open.splice(0)) {
      await db.close();
      await td.drop();
    }
  });
  /** A database of its own, with the steps up to `version` made. */
  const database = async (version: number): Promise<MariaDbConn> => {
    const td = await createTestDatabase();
    const db = new MariaDbConn({ target: parseTarget(td.url), max: 4 });
    open.push({ td, db });
    await migrate(db, MAIN_MIGRATIONS, upTo(version));
    return db;
  };

  const columns = async (db: MariaDbConn, table: string): Promise<string[]> => (await db.all<{ column_name: string }>('SELECT column_name AS column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position', [table])).map((r) => r.column_name);
  const indexes = async (db: MariaDbConn, table: string): Promise<string[]> => (await db.all<{ index_name: string }>("SELECT DISTINCT index_name AS index_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name <> 'PRIMARY' ORDER BY index_name", [table])).map((r) => r.index_name);
  const key = async (db: MariaDbConn, table: string): Promise<string[]> => (await db.all<{ column_name: string }>("SELECT column_name AS column_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position", [table])).map((r) => r.column_name);
  const upTo = (version: number) => MAIN_STEPS.filter((s) => s.version <= version);
  /** Stops the runner before statement `index` of step `version`, as a crash would. */
  const stopAt = (version: number, index: number) => (v: number, i: number) => {
    if (v === version && i === index) throw new Error('stopped');
  };
  /** Forgets that `version` was applied, as a crash after its last statement and before its record would leave it. */
  const unrecord = (db: MariaDbConn, version: number) => db.run(`DELETE FROM ${MAIN_MIGRATIONS} WHERE version = ?`, [version]);

  it('step 32 keeps every delivery under its message, drops the conversation column, has the one key, and runs again after it stopped before it was recorded', async () => {
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
    await migrate(db, MAIN_MIGRATIONS, upTo(32));
    const after = async () => {
      expect(await columns(db, 'conversation_deliveries')).toEqual(['message_id', 'member_kind', 'member_ref', 'member_name', 'named', 'state', 'state_at']);
      expect(await key(db, 'conversation_deliveries')).toEqual(['message_id', 'member_kind', 'member_ref']);
      expect(await db.all('SELECT message_id, member_kind, member_ref, member_name, named, state, state_at FROM conversation_deliveries ORDER BY message_id, member_kind, member_ref')).toEqual([
        { message_id: 'cmg_a', member_kind: 'agent', member_ref: 'sess-notes', member_name: 'infra-notes', named: 0, state: 'queued', state_at: 21 },
        { message_id: 'cmg_a', member_kind: 'agent', member_ref: 'sess-tester', member_name: 'Tester', named: 1, state: 'delivered', state_at: 20 },
        { message_id: 'cmg_b', member_kind: 'person', member_ref: '2', member_name: 'Maya Kim', named: 1, state: null, state_at: null },
        { message_id: 'cmg_c', member_kind: 'agent', member_ref: 'sess-tester', member_name: 'Tester', named: 0, state: 'dropped', state_at: 22 },
      ]);
    };
    await after();
    await expect(db.run("INSERT INTO conversation_deliveries (message_id, member_kind, member_ref, member_name, named) VALUES ('cmg_a', 'agent', 'sess-tester', 'Tester', 0)")).rejects.toThrow(/Duplicate entry/);
    // The statement ran and the step was not recorded: it is run again from its start, finds the key and the column as they are, and ends in the same state.
    await unrecord(db, 32);
    await migrate(db, MAIN_MIGRATIONS, upTo(32));
    await after();
  });

  const records = async (db: MariaDbConn): Promise<void> => {
    await db.run("INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES ('Ed', 'ed', 'k1', ?, 1000), ('Eve', 'eve', 'k2', ?, 1000)", ['0'.repeat(64), '0'.repeat(64)]);
    await db.run(
      `INSERT INTO chat_admin_reads (thread, admin_key, admin, started_at, last_seen_at, kind, people, seen) VALUES
        ('dm:a|b', '#9', 'Root', 100, 110, 'read', '[1,2]', '[2]'),
        ('group:1', '#9', 'Root', 200, 210, 'cleared', '[1]', '[]'),
        ('act:1', 'root', 'Root', 300, 310, 'read', '[]', '[]')`,
    );
  };
  const owedRows = (db: MariaDbConn) => db.all('SELECT person_id, thread, admin_key, started_at FROM chat_admin_owed ORDER BY person_id, thread, started_at');

  it('step 33 keeps each person\'s owed rows by the id alone, drops the rows of no person, drops the name key and the second index, and runs again after it stopped half way', async () => {
    const db = await database(32);
    expect(await columns(db, 'chat_admin_owed')).toEqual(['person_key', 'thread', 'admin_key', 'started_at', 'person_id']);
    expect(await indexes(db, 'chat_admin_owed')).toEqual(['chat_admin_owed_person', 'chat_admin_owed_record']);
    await records(db);
    await db.run("INSERT INTO settings (key, value) VALUES ('chat_admin_owed_filled', '1')");
    await db.run(
      `INSERT INTO chat_admin_owed (person_key, person_id, thread, admin_key, started_at) VALUES
        ('#1', 1, 'dm:a|b', '#9', 100), ('#1', 1, 'group:1', '#9', 200), ('#2', 2, 'dm:a|b', '#9', 100), ('ghost', NULL, 'dm:a|b', '#9', 100)`,
    );
    // The step stops after the row of no person is deleted and before the key is changed, and is run again from its start.
    await expect(migrate(db, MAIN_MIGRATIONS, upTo(33), stopAt(33, 1))).rejects.toThrow('stopped');
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_admin_owed'))!.n).toBe(3);
    await migrate(db, MAIN_MIGRATIONS, upTo(33));
    const after = async () => {
      expect(await columns(db, 'chat_admin_owed')).toEqual(['thread', 'admin_key', 'started_at', 'person_id']);
      expect(await key(db, 'chat_admin_owed')).toEqual(['person_id', 'thread', 'admin_key', 'started_at']);
      expect(await indexes(db, 'chat_admin_owed')).toEqual(['chat_admin_owed_record']);
      // The rows the table held are all there under the person's id, and the row of no person is gone. The fill had run already (its mark is in `settings`), so it adds nothing.
      expect(await owedRows(db)).toEqual([
        { person_id: 1, thread: 'dm:a|b', admin_key: '#9', started_at: 100 },
        { person_id: 1, thread: 'group:1', admin_key: '#9', started_at: 200 },
        { person_id: 2, thread: 'dm:a|b', admin_key: '#9', started_at: 100 },
      ]);
    };
    await after();
    await expect(db.run("INSERT INTO chat_admin_owed (person_id, thread, admin_key, started_at) VALUES (1, 'dm:a|b', '#9', 100)")).rejects.toThrow(/Duplicate entry/);
    // The change ran and the step was not recorded: it is run again and ends in the same state.
    await unrecord(db, 33);
    await migrate(db, MAIN_MIGRATIONS, upTo(33));
    await after();
  });

  it('steps 33 and 34 owe, once, the people an older record\'s lists name who had not seen it, before the list of who had seen it goes, and keep the record and the people it was made with', async () => {
    const db = await database(32);
    await records(db);
    await migrate(db, MAIN_MIGRATIONS, upTo(33));
    // Person 1 is owed both records that name them; person 2 saw the one they were named in, so is owed none; the record that names nobody is owed to nobody.
    const owed = [
      { person_id: 1, thread: 'dm:a|b', admin_key: '#9', started_at: 100 },
      { person_id: 1, thread: 'group:1', admin_key: '#9', started_at: 200 },
    ];
    expect(await owedRows(db)).toEqual(owed);
    expect(await db.all("SELECT value FROM settings WHERE key = 'chat_admin_owed_filled'")).toEqual([{ value: '1' }]);
    expect(await columns(db, 'chat_admin_reads')).toContain('seen');
    // Stopped after the change and before the fill was marked: the step runs again, finds the owed rows there already and adds none twice.
    await db.run("DELETE FROM settings WHERE key = 'chat_admin_owed_filled'");
    await unrecord(db, 33);
    await migrate(db, MAIN_MIGRATIONS, upTo(33));
    expect(await owedRows(db)).toEqual(owed);
    await migrate(db, MAIN_MIGRATIONS, upTo(34));
    expect(await columns(db, 'chat_admin_reads')).toEqual(['thread', 'admin_key', 'admin', 'started_at', 'last_seen_at', 'kind', 'people']);
    expect(await db.all('SELECT thread, admin, started_at, last_seen_at, kind, people FROM chat_admin_reads ORDER BY started_at')).toEqual([
      { thread: 'dm:a|b', admin: 'Root', started_at: 100, last_seen_at: 110, kind: 'read', people: '[1,2]' },
      { thread: 'group:1', admin: 'Root', started_at: 200, last_seen_at: 210, kind: 'cleared', people: '[1]' },
      { thread: 'act:1', admin: 'Root', started_at: 300, last_seen_at: 310, kind: 'read', people: '[]' },
    ]);
    // Step 34 can run again too.
    await unrecord(db, 34);
    await migrate(db, MAIN_MIGRATIONS, upTo(34));
    expect(await columns(db, 'chat_admin_reads')).not.toContain('seen');
  });

  it('step 35 adds an index that begins with seq to each of five tables and one on peer_messages(owner_id), reads an index where it read a whole table, and runs again after it stopped half way', async () => {
    const db = await database(34);
    const tables = ['peer_messages', 'group_messages', 'public_messages', 'conversation_messages', 'peer_requests'];
    for (const t of tables) expect(await indexes(db, t), t).not.toContain(`${t}_counter`);
    // A table the planner will not scan: 20,000 rows made from the columns that must have a value, `seq` counting up and the owner one of 50.
    for (const t of tables) {
      const need = await db.all<{ column_name: string; data_type: string }>("SELECT column_name AS column_name, data_type AS data_type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND (column_name = 'seq' OR (is_nullable = 'NO' AND column_default IS NULL)) ORDER BY ordinal_position", [t]);
      const value = (c: { column_name: string; data_type: string }): string => (c.column_name === 'seq' ? 'seq' : /char|text/.test(c.data_type) ? `CONCAT('${c.column_name}-', seq)` : 'seq');
      await db.run(`INSERT INTO ${t} (${need.map((c) => `"${c.column_name}"`).join(', ')}) SELECT ${need.map(value).join(', ')} FROM seq_1_to_20000`);
    }
    await db.run('UPDATE peer_messages SET owner_id = seq % 50');
    const plan = async (sql: string): Promise<string> => (await db.all<Record<string, unknown>>(`EXPLAIN ${sql}`)).map((r) => `${r.table ?? ''}:${r.type ?? ''}:${r.key ?? ''}:${r.Extra ?? ''}`).join(' | ');
    expect(await plan('SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_messages')).not.toMatch(/optimized away/);
    // The step stops after two of its statements and is run again from its start, which finds those two done and does the rest.
    await expect(migrate(db, MAIN_MIGRATIONS, upTo(35), stopAt(35, 2))).rejects.toThrow('stopped');
    expect(await indexes(db, 'group_messages')).toContain('group_messages_counter');
    expect(await indexes(db, 'public_messages')).not.toContain('public_messages_counter');
    await migrate(db, MAIN_MIGRATIONS, upTo(35));
    for (const t of tables) {
      expect(await indexes(db, t), t).toContain(`${t}_counter`);
      // The statement each insert runs to number its row reads the last entry of the index, and so costs the same at any size.
      expect(await plan(`SELECT COALESCE(MAX(seq), 0) + 1 FROM ${t}`), t).toMatch(/optimized away/);
    }
    expect(await plan('SELECT id FROM peer_messages WHERE owner_id = 7')).toMatch(/:peer_messages_owner:/);
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM peer_messages'))!.n).toBe(20000);
  });
});
