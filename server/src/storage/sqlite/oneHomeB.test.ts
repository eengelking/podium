// Migrations 56 to 59 (#1296) keep a delivery by its message alone, an Admin record's owed rows by the person's id, and no list of who had seen a record, and lay three tables out `WITHOUT ROWID` (DECISIONS 78).
// The contract's upgrade cases (`contractUpgrade.ts`) run on every adapter and read what a store gives back; these read the tables themselves, which no store method returns, on rows an older database holds.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from './db.js';

const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all() as unknown as { name: string }[]).map((r) => r.name);
const indexes = (db: DatabaseSync, table: string): string[] => (db.prepare(`SELECT name FROM pragma_index_list('${table}') WHERE origin = 'c' ORDER BY name`).all() as unknown as { name: string }[]).map((r) => r.name);
const key = (db: DatabaseSync, table: string): string[] => (db.prepare(`SELECT name FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`).all() as unknown as { name: string }[]).map((r) => r.name);
const withoutRowid = (db: DatabaseSync, table: string): boolean => (db.prepare('SELECT wr FROM pragma_table_list WHERE name = ?').get(table) as { wr: number }).wr === 1;

function withDatabase(body: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'podium-one-home-b-'));
  try {
    body(path.join(dir, 'podium.sqlite'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('migration 56: a delivery is found by its message', () => {
  it('keeps every delivery under its message, drops the conversation column, has the one key, is laid out without a rowid, and runs once', () => {
    withDatabase((file) => {
      const old = openDb(file, 55);
      expect(columns(old, 'conversation_deliveries')).toEqual(['conversation_id', 'message_id', 'member_kind', 'member_ref', 'member_name', 'named', 'state', 'state_at']);
      expect(withoutRowid(old, 'conversation_deliveries')).toBe(false);
      old.exec(`
        INSERT INTO conversations (id, created_at, members_key) VALUES ('cnv_1', 1, 'k1'), ('cnv_2', 2, 'k2');
        INSERT INTO conversation_messages (id, conversation_id, author_kind, author_ref, author_name, text, created_at, seq) VALUES
          ('cmg_a', 'cnv_1', 'person', '1', 'Ed', 'one', 10, 1), ('cmg_b', 'cnv_1', 'person', '1', 'Ed', 'two', 11, 2), ('cmg_c', 'cnv_2', 'person', '2', 'Maya', 'three', 12, 3);
        INSERT INTO conversation_deliveries (conversation_id, message_id, member_kind, member_ref, member_name, named, state, state_at) VALUES
          ('cnv_1', 'cmg_a', 'agent', 'sess-tester', 'Tester', 1, 'delivered', 20),
          ('cnv_1', 'cmg_a', 'agent', 'sess-notes', 'infra-notes', 0, 'queued', 21),
          ('cnv_1', 'cmg_b', 'person', '2', 'Maya Kim', 1, NULL, NULL),
          ('cnv_2', 'cmg_c', 'agent', 'sess-tester', 'Tester', 0, 'dropped', 22);`);
      old.close();

      const db = openDb(file);
      expect(columns(db, 'conversation_deliveries')).toEqual(['message_id', 'member_kind', 'member_ref', 'member_name', 'named', 'state', 'state_at']);
      expect(key(db, 'conversation_deliveries')).toEqual(['message_id', 'member_kind', 'member_ref']);
      expect(withoutRowid(db, 'conversation_deliveries')).toBe(true);
      expect(db.prepare('SELECT message_id, member_kind, member_ref, member_name, named, state, state_at FROM conversation_deliveries ORDER BY message_id, member_kind, member_ref').all()).toEqual([
        { message_id: 'cmg_a', member_kind: 'agent', member_ref: 'sess-notes', member_name: 'infra-notes', named: 0, state: 'queued', state_at: 21 },
        { message_id: 'cmg_a', member_kind: 'agent', member_ref: 'sess-tester', member_name: 'Tester', named: 1, state: 'delivered', state_at: 20 },
        { message_id: 'cmg_b', member_kind: 'person', member_ref: '2', member_name: 'Maya Kim', named: 1, state: null, state_at: null },
        { message_id: 'cmg_c', member_kind: 'agent', member_ref: 'sess-tester', member_name: 'Tester', named: 0, state: 'dropped', state_at: 22 },
      ]);
      expect(() => db.prepare("INSERT INTO conversation_deliveries (message_id, member_kind, member_ref, member_name, named) VALUES ('cmg_a', 'agent', 'sess-tester', 'Tester', 0)").run()).toThrow(/UNIQUE/);
      db.close();
      // The step ran once: opening the database again changes nothing.
      const again = openDb(file);
      expect((again.prepare('SELECT COUNT(*) AS n FROM conversation_deliveries').get() as { n: number }).n).toBe(4);
      again.close();
    });
  });
});

describe('migrations 57 and 58: what an Admin record is owed to', () => {
  const records = `
    INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES ('Ed', 'ed', 'k1', '${'0'.repeat(64)}', 1000), ('Eve', 'eve', 'k2', '${'0'.repeat(64)}', 1000);
    INSERT INTO chat_admin_reads (thread, admin_key, admin, started_at, last_seen_at, kind, people, seen) VALUES
      ('dm:a|b', '#9', 'Root', 100, 110, 'read', '[1,2]', '[2]'),
      ('group:1', '#9', 'Root', 200, 210, 'cleared', '[1]', '[]'),
      ('act:1', 'root', 'Root', 300, 310, 'read', '[]', '[]');`;

  it('keeps each person\'s owed rows by the id alone, drops the rows of no person, drops the name key and the second index, and lays the table out without a rowid', () => {
    withDatabase((file) => {
      const old = openDb(file, 56);
      expect(columns(old, 'chat_admin_owed')).toEqual(['person_key', 'thread', 'admin_key', 'started_at', 'person_id']);
      expect(indexes(old, 'chat_admin_owed')).toEqual(['chat_admin_owed_person', 'chat_admin_owed_record']);
      old.exec(records);
      old.exec(`
        INSERT INTO settings (key, value) VALUES ('chat_admin_owed_filled', '1');
        INSERT INTO chat_admin_owed (person_key, person_id, thread, admin_key, started_at) VALUES
          ('#1', 1, 'dm:a|b', '#9', 100), ('#1', 1, 'group:1', '#9', 200), ('#2', 2, 'dm:a|b', '#9', 100), ('ghost', NULL, 'dm:a|b', '#9', 100);`);
      old.close();

      const db = openDb(file);
      expect(columns(db, 'chat_admin_owed')).toEqual(['person_id', 'thread', 'admin_key', 'started_at']);
      expect(key(db, 'chat_admin_owed')).toEqual(['person_id', 'thread', 'admin_key', 'started_at']);
      expect(indexes(db, 'chat_admin_owed')).toEqual(['chat_admin_owed_record']);
      expect(withoutRowid(db, 'chat_admin_owed')).toBe(true);
      // The rows the table held are all there under the person's id, and the row of no person is gone. The fill had run already (its mark is in `settings`), so it adds nothing.
      expect(db.prepare('SELECT person_id, thread, admin_key, started_at FROM chat_admin_owed ORDER BY person_id, thread, started_at').all()).toEqual([
        { person_id: 1, thread: 'dm:a|b', admin_key: '#9', started_at: 100 },
        { person_id: 1, thread: 'group:1', admin_key: '#9', started_at: 200 },
        { person_id: 2, thread: 'dm:a|b', admin_key: '#9', started_at: 100 },
      ]);
      expect(() => db.prepare("INSERT INTO chat_admin_owed (person_id, thread, admin_key, started_at) VALUES (1, 'dm:a|b', '#9', 100)").run()).toThrow(/UNIQUE/);
      db.close();
      // The steps ran once: opening the database again changes nothing.
      const again = openDb(file);
      expect((again.prepare('SELECT COUNT(*) AS n FROM chat_admin_owed').get() as { n: number }).n).toBe(3);
      again.close();
    });
  });

  it('owes, once, the people an older record\'s lists name who had not seen it, before the list of who had seen it goes, and keeps the record and the people it was made with', () => {
    withDatabase((file) => {
      const old = openDb(file, 56);
      old.exec(records);
      old.close();
      const db = openDb(file);
      // Person 1 is owed both records that name them; person 2 saw the one they were named in, so is owed none; the record that names nobody is owed to nobody.
      expect(db.prepare('SELECT person_id, thread, admin_key, started_at FROM chat_admin_owed ORDER BY person_id, thread, started_at').all()).toEqual([
        { person_id: 1, thread: 'dm:a|b', admin_key: '#9', started_at: 100 },
        { person_id: 1, thread: 'group:1', admin_key: '#9', started_at: 200 },
      ]);
      expect(db.prepare("SELECT value FROM settings WHERE key = 'chat_admin_owed_filled'").get()).toEqual({ value: '1' });
      expect(columns(db, 'chat_admin_reads')).toEqual(['thread', 'admin_key', 'admin', 'started_at', 'last_seen_at', 'kind', 'people', 'detail']);
      expect(db.prepare('SELECT thread, admin, started_at, last_seen_at, kind, people FROM chat_admin_reads ORDER BY started_at').all()).toEqual([
        { thread: 'dm:a|b', admin: 'Root', started_at: 100, last_seen_at: 110, kind: 'read', people: '[1,2]' },
        { thread: 'group:1', admin: 'Root', started_at: 200, last_seen_at: 210, kind: 'cleared', people: '[1]' },
        { thread: 'act:1', admin: 'Root', started_at: 300, last_seen_at: 310, kind: 'read', people: '[]' },
      ]);
      db.close();
    });
  });
});

describe('migration 59: a person\'s counts in a thread, without a rowid', () => {
  it('keeps every count under the person and the thread, has the same key and the index on the thread, is laid out without a rowid, and runs once', () => {
    withDatabase((file) => {
      const old = openDb(file, 58);
      expect(withoutRowid(old, 'chat_read_state')).toBe(false);
      old.exec(`
        INSERT INTO chat_read_state (person_id, thread, unread, mentions) VALUES
          (1, 'public', 4, 1), (1, 'dm:person:1|sa', 0, 2), (2, 'public', 3, 0), (2, 'convo:cnv_1', 7, 0);`);
      old.close();

      const db = openDb(file);
      expect(columns(db, 'chat_read_state')).toEqual(['person_id', 'thread', 'unread', 'mentions']);
      expect(key(db, 'chat_read_state')).toEqual(['person_id', 'thread']);
      expect(indexes(db, 'chat_read_state')).toEqual(['chat_read_state_thread']);
      expect(withoutRowid(db, 'chat_read_state')).toBe(true);
      expect(db.prepare('SELECT person_id, thread, unread, mentions FROM chat_read_state ORDER BY person_id, thread').all()).toEqual([
        { person_id: 1, thread: 'dm:person:1|sa', unread: 0, mentions: 2 },
        { person_id: 1, thread: 'public', unread: 4, mentions: 1 },
        { person_id: 2, thread: 'convo:cnv_1', unread: 7, mentions: 0 },
        { person_id: 2, thread: 'public', unread: 3, mentions: 0 },
      ]);
      // A count is still bumped in one statement, by the key, and a thread's rows are still found by the thread.
      db.prepare("INSERT INTO chat_read_state (person_id, thread, unread, mentions) VALUES (1, 'public', 1, 0) ON CONFLICT(person_id, thread) DO UPDATE SET unread = unread + excluded.unread").run();
      expect(db.prepare("SELECT unread FROM chat_read_state WHERE person_id = 1 AND thread = 'public'").get()).toEqual({ unread: 5 });
      expect((db.prepare("EXPLAIN QUERY PLAN SELECT person_id FROM chat_read_state WHERE thread = 'public'").all() as { detail: string }[]).map((r) => r.detail).join(' ')).toMatch(/USING (COVERING )?INDEX chat_read_state_thread/);
      db.close();
      const again = openDb(file);
      expect((again.prepare('SELECT COUNT(*) AS n FROM chat_read_state').get() as { n: number }).n).toBe(4);
      again.close();
    });
  });
});

describe('migration 60: the next seq of a table and the owner read of peer_messages', () => {
  const TABLES = ['peer_messages', 'group_messages', 'public_messages', 'conversation_messages', 'peer_requests'];
  const plan = (db: DatabaseSync, sql: string): string => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join('; ');

  it('adds an index that begins with seq to each of five tables and one on peer_messages(owner_id), so the statements that read a whole index search one', () => {
    withDatabase((file) => {
      const old = openDb(file, 59);
      for (const t of TABLES) expect(indexes(old, t), t).not.toContain(`${t}_counter`);
      expect(indexes(old, 'peer_messages')).not.toContain('peer_messages_owner');
      expect(plan(old, 'SELECT id FROM peer_messages WHERE owner_id = 1')).toMatch(/SCAN/);
      old.close();

      const db = openDb(file);
      for (const t of TABLES) {
        expect(indexes(db, t), t).toContain(`${t}_counter`);
        // The statement each insert runs to number its row reads the last entry of the index, and so costs the same at any size.
        expect(plan(db, `SELECT COALESCE(MAX(seq), 0) + 1 FROM ${t}`), t).toMatch(new RegExp(`INDEX ${t}_counter`));
      }
      expect((db.prepare("SELECT name FROM pragma_index_info('peer_messages_counter')").all() as { name: string }[]).map((r) => r.name)).toEqual(['seq']);
      // The owner's index is in the order the reads sort in, so `conversations` and the ended agent's name need no sort.
      expect((db.prepare("SELECT name FROM pragma_index_info('peer_messages_owner') ORDER BY seqno").all() as { name: string }[]).map((r) => r.name)).toEqual(['owner_id', 'sent_at', 'seq']);
      const owner = plan(db, 'SELECT id FROM peer_messages WHERE owner_id = 1 ORDER BY sent_at, seq');
      expect(owner).toMatch(/SEARCH peer_messages USING INDEX peer_messages_owner/);
      expect(owner).not.toMatch(/TEMP B-TREE/);
      // The tables the migration indexes keep their rows and columns, and the older indexes stay.
      expect(indexes(db, 'peer_requests')).toEqual(['peer_requests_counter', 'peer_requests_seq']);
      db.close();
      // The step ran once: opening the database again changes nothing.
      openDb(file).close();
    });
  });
});
