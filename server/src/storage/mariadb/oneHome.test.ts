// Steps 30 and 31 of the main schema (#1296) take the columns and indexes that hold what another column holds, and the read-state row a person's counts need no more, out of the chat and peer tables, as
// SQLite migrations 54 and 55 do. The contract's upgrade cases run on every adapter and read what a store gives back; these read the tables themselves, on rows an older database holds, and run a step
// again after it stopped half way, which MariaDB needs because its statements are not one transaction.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MariaDbConn, parseTarget } from './conn.js';
import { MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { TEST_MARIADB, createTestDatabase, type TestDatabase } from './testing.js';

describe.skipIf(!TEST_MARIADB)('mariadb steps 30 and 31', () => {
  let td: TestDatabase;
  let db: MariaDbConn;
  beforeAll(async () => {
    td = await createTestDatabase();
    db = new MariaDbConn({ target: parseTarget(td.url), max: 4 });
  });
  afterAll(async () => {
    await db.close();
    await td.drop();
  });

  const columns = async (table: string): Promise<string[]> => (await db.all<{ column_name: string }>('SELECT column_name AS column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position', [table])).map((r) => r.column_name);
  const indexes = async (table: string): Promise<string[]> => (await db.all<{ index_name: string }>("SELECT DISTINCT index_name AS index_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name <> 'PRIMARY' ORDER BY index_name", [table])).map((r) => r.index_name);
  const upTo = (version: number) => MAIN_STEPS.filter((s) => s.version <= version);
  /** Stops the runner before statement `index` of step `version`, as a crash would. */
  const stopAt = (version: number, index: number) => (v: number, i: number) => {
    if (v === version && i === index) throw new Error('stopped');
  };

  it('step 30 drops the columns and indexes nothing reads, keeps every row of the tables it changes, runs again after it stopped half way, and leaves the indexes the queries use', async () => {
    await migrate(db, MAIN_MIGRATIONS, upTo(29));
    await db.run("INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES ('Ed', 'ed', 'k1', ?, 1000)", ['0'.repeat(64)]);
    await db.run("INSERT INTO group_messages (id, owner, group_id, owner_id, author_kind, author_ref, author_name, text, created_at, updated_at, mentions_json, seq) VALUES ('grp_1', '#1', '#1', 1, 'person', 'Ed', 'Ed', 'one', 5, 9, '[]', 1)");
    await db.run("INSERT INTO group_messages (id, owner, group_id, owner_id, author_kind, author_ref, author_name, text, created_at, updated_at, mentions_json, seq) VALUES ('grp_2', 'ghost', 'ghost', NULL, 'person', 'Ghost', 'Ghost', 'nobody reads this', 6, 6, '[]', 2)");
    await db.run("INSERT INTO public_messages (id, channel, author_kind, author_ref, author_name, text, created_at, updated_at, mentions_json, seq) VALUES ('pub_1', 'general', 'person', 'Ed', 'Ed', 'hi', 7, 8, '[]', 1)");
    await db.run("INSERT INTO public_channels (name, description, created_by, created_by_id, created_by_name, created_at, updated_at) VALUES ('dev', '', '', 1, 'Ed', 3, 3)");
    await db.run(
      `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq)
       VALUES ('m1', 'Ed', 'a|b', 'a', 'b', 'sa', 'sb', 'x', '', 'y', '', 'hello', 1, 'handed', 2, NULL, 0, 1, 1)`,
    );
    await db.run("INSERT INTO peer_requests (id, owner, kind, from_key, to_key, level, reason, by, from_session, message_id, created_at, seq) VALUES ('prq_1', 'Ed', 'access', 'a', 'b', 'see', 'why', 'x', 'sa', NULL, 1, 1)");
    await db.run("INSERT INTO conversations (id, created_by, created_at, members_key) VALUES ('cnv_1', 1, 4, 'k')");
    await db.run("INSERT INTO conversation_messages (id, conversation_id, author_kind, author_ref, author_name, text, created_at, updated_at, seq) VALUES ('cmg_1', 'cnv_1', 'person', '1', 'Ed', 'yo', 4, 11, 1)");
    expect(await indexes('group_messages')).toContain('group_messages_channel');
    expect(await indexes('peer_requests')).toContain('peer_requests_owner');

    // The step stops after its first statement (group_messages has lost its index and three columns in that one statement) and is run again from its start, which finds that statement done and does the rest.
    await expect(migrate(db, MAIN_MIGRATIONS, upTo(30), stopAt(30, 1))).rejects.toThrow('stopped');
    for (const c of ['owner', 'group_id', 'updated_at']) expect(await columns('group_messages'), c).not.toContain(c);
    expect(await indexes('group_messages')).toEqual(['group_messages_created', 'group_messages_owner']);
    expect(await columns('public_messages')).toContain('updated_at');
    // Stopped again between the last two tables, so the step is run a third time from the start with everything but one table done.
    await expect(migrate(db, MAIN_MIGRATIONS, upTo(30), stopAt(30, 6))).rejects.toThrow('stopped');
    expect(await columns('conversations')).toContain('created_by');
    expect(await columns('peer_messages')).not.toContain('handed');
    await migrate(db, MAIN_MIGRATIONS, upTo(30));

    for (const [table, gone] of [['group_messages', ['owner', 'group_id', 'updated_at']], ['public_messages', ['updated_at']], ['conversation_messages', ['updated_at']], ['public_channels', ['created_by']], ['peer_messages', ['handed']], ['conversations', ['created_by']]] as const) {
      const have = await columns(table);
      for (const c of gone) expect(have, `${table}.${c}`).not.toContain(c);
    }
    expect(await indexes('group_messages')).toEqual(['group_messages_created', 'group_messages_owner']);
    expect(await indexes('peer_requests')).not.toContain('peer_requests_owner');
    expect(await db.all('SELECT id, owner_id, text FROM group_messages ORDER BY seq')).toEqual([{ id: 'grp_1', owner_id: 1, text: 'one' }, { id: 'grp_2', owner_id: null, text: 'nobody reads this' }]);
    expect(await db.all('SELECT id, channel, created_at FROM public_messages')).toEqual([{ id: 'pub_1', channel: 'general', created_at: 7 }]);
    expect(await db.all('SELECT name, created_by_id, created_by_name FROM public_channels')).toEqual([{ name: 'dev', created_by_id: 1, created_by_name: 'Ed' }]);
    expect(await db.all('SELECT id, state FROM peer_messages')).toEqual([{ id: 'm1', state: 'handed' }]);
    expect(await db.all('SELECT id, created_at FROM conversations')).toEqual([{ id: 'cnv_1', created_at: 4 }]);
    expect(await db.all('SELECT id, created_at FROM conversation_messages')).toEqual([{ id: 'cmg_1', created_at: 4 }]);
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM peer_requests'))!.n).toBe(1);
  });

  it('step 31 keeps every count that is not zero under the person\'s id, drops the rows at zero and the rows of no person, has the one key, and runs again after it stopped half way', async () => {
    expect(await columns('chat_read_state')).toEqual(['person', 'thread', 'last_read', 'unread', 'mentions', 'updated_at', 'person_id']);
    await db.run(
      `INSERT INTO chat_read_state (person, person_id, thread, last_read, unread, mentions, updated_at) VALUES
        ('#1', 1, 'public', 'c1', 4, 1, 10),
        ('#1', 1, 'group:1', 'c2', 0, 0, 11),
        ('#1', 1, 'dm:person:1|sa', NULL, 0, 2, 12),
        ('#2', 2, 'public', NULL, 3, 0, 13),
        ('#2', 2, 'public:dev', 'c9', 0, 0, 14),
        ('ghost', NULL, 'public', NULL, 9, 3, 15)`,
    );
    // The step stops after the rows are deleted and before the key is made, and is run again from its start.
    await expect(migrate(db, MAIN_MIGRATIONS, MAIN_STEPS, stopAt(31, 1))).rejects.toThrow('stopped');
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_read_state'))!.n).toBe(3);
    await migrate(db, MAIN_MIGRATIONS, MAIN_STEPS);
    expect(await columns('chat_read_state')).toEqual(['thread', 'unread', 'mentions', 'person_id']);
    expect(await db.all('SELECT person_id, thread, unread, mentions FROM chat_read_state ORDER BY person_id, thread')).toEqual([
      { person_id: 1, thread: 'dm:person:1|sa', unread: 0, mentions: 2 },
      { person_id: 1, thread: 'public', unread: 4, mentions: 1 },
      { person_id: 2, thread: 'public', unread: 3, mentions: 0 },
    ]);
    // The key is the person and the thread, and the one index left is the thread's, for forgetting a thread.
    expect(await db.all<{ column_name: string }>("SELECT column_name AS column_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'chat_read_state' AND constraint_name = 'PRIMARY' ORDER BY ordinal_position")).toEqual([{ column_name: 'person_id' }, { column_name: 'thread' }]);
    expect(await indexes('chat_read_state')).toEqual(['chat_read_state_thread']);
    await expect(db.run("INSERT INTO chat_read_state (person_id, thread, unread, mentions) VALUES (1, 'public', 1, 0)")).rejects.toThrow(/Duplicate entry/);
    // The step ran once: running the steps again changes nothing.
    await migrate(db, MAIN_MIGRATIONS, MAIN_STEPS);
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_read_state'))!.n).toBe(3);
  });
});
