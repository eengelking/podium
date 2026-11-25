// Migrations 54 and 55 (#1296) take the columns and indexes that hold what another column holds, and the read-state row a person's counts need no more, out of the chat and peer tables. The contract's upgrade
// cases (`contractUpgrade.ts`) run on every adapter and read what a store gives back; these read the tables themselves, which no store method returns, on rows an older database holds.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from './db.js';

const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all() as unknown as { name: string }[]).map((r) => r.name);
const indexes = (db: DatabaseSync, table: string): string[] => (db.prepare(`SELECT name FROM pragma_index_list('${table}') WHERE origin = 'c' ORDER BY name`).all() as unknown as { name: string }[]).map((r) => r.name);

function withDatabase(body: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'podium-one-home-'));
  try {
    body(path.join(dir, 'podium.sqlite'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('migration 54: the columns and indexes nothing reads', () => {
  it('drops them, keeps every row of the tables it changes, and leaves the indexes the queries use', () => {
    withDatabase((file) => {
      const old = openDb(file, 53);
      old.exec(`
        INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES ('Ed', 'ed', 'k1', '${'0'.repeat(64)}', 1000);
        INSERT INTO group_messages (id, owner, group_id, owner_id, author_kind, author_ref, author_name, text, created_at, updated_at, mentions_json, seq) VALUES ('grp_1', '#1', '#1', 1, 'person', 'Ed', 'Ed', 'one', 5, 9, '[]', 1);
        INSERT INTO group_messages (id, owner, group_id, owner_id, author_kind, author_ref, author_name, text, created_at, updated_at, mentions_json, seq) VALUES ('grp_2', 'ghost', 'ghost', NULL, 'person', 'Ghost', 'Ghost', 'nobody reads this', 6, 6, '[]', 2);
        INSERT INTO public_messages (id, channel, author_kind, author_ref, author_name, text, created_at, updated_at, mentions_json, seq) VALUES ('pub_1', 'general', 'person', 'Ed', 'Ed', 'hi', 7, 8, '[]', 1);
        INSERT INTO public_channels (name, description, created_by, created_by_id, created_by_name, created_at, updated_at) VALUES ('dev', '', '', 1, 'Ed', 3, 3);
        INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq)
          VALUES ('m1', 'Ed', 'a|b', 'a', 'b', 'sa', 'sb', 'x', '', 'y', '', 'hello', 1, 'handed', 2, NULL, 0, 1, 1);
        INSERT INTO peer_requests (id, owner, kind, from_key, to_key, level, reason, by, from_session, message_id, created_at, seq) VALUES ('prq_1', 'Ed', 'access', 'a', 'b', 'see', 'why', 'x', 'sa', NULL, 1, 1);
        INSERT INTO conversations (id, created_by, created_at, members_key) VALUES ('cnv_1', 1, 4, 'k');
        INSERT INTO conversation_messages (id, conversation_id, author_kind, author_ref, author_name, text, created_at, updated_at, seq) VALUES ('cmg_1', 'cnv_1', 'person', '1', 'Ed', 'yo', 4, 11, 1);`);
      expect(indexes(old, 'group_messages')).toContain('group_messages_channel');
      expect(indexes(old, 'peer_requests')).toContain('peer_requests_owner');
      old.close();

      const db = openDb(file);
      for (const [table, gone] of [['group_messages', ['owner', 'group_id', 'updated_at']], ['public_messages', ['updated_at']], ['conversation_messages', ['updated_at']], ['public_channels', ['created_by']], ['peer_messages', ['handed']], ['conversations', ['created_by']]] as const) {
        const have = columns(db, table);
        for (const c of gone) expect(have, `${table}.${c}`).not.toContain(c);
      }
      // `group_messages_counter` is migration 60's, which the database has by now.
      expect(indexes(db, 'group_messages')).toEqual(['group_messages_counter', 'group_messages_created', 'group_messages_owner']);
      expect(indexes(db, 'peer_requests')).not.toContain('peer_requests_owner');
      // Every row is there with the values the columns that stay hold.
      expect(db.prepare('SELECT id, owner_id, text FROM group_messages ORDER BY seq').all()).toEqual([{ id: 'grp_1', owner_id: 1, text: 'one' }, { id: 'grp_2', owner_id: null, text: 'nobody reads this' }]);
      expect(db.prepare('SELECT id, channel, created_at FROM public_messages').all()).toEqual([{ id: 'pub_1', channel: 'general', created_at: 7 }]);
      expect(db.prepare('SELECT name, created_by_id, created_by_name FROM public_channels').all()).toEqual([{ name: 'dev', created_by_id: 1, created_by_name: 'Ed' }]);
      expect(db.prepare('SELECT id, state FROM peer_messages').all()).toEqual([{ id: 'm1', state: 'handed' }]);
      expect(db.prepare('SELECT id, created_at FROM conversations').all()).toEqual([{ id: 'cnv_1', created_at: 4 }]);
      expect(db.prepare('SELECT id, created_at FROM conversation_messages').all()).toEqual([{ id: 'cmg_1', created_at: 4 }]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM peer_requests').get()).toEqual({ n: 1 });
      db.close();
    });
  });
});

describe('migration 55: a person\'s counts in a thread', () => {
  it('keeps every count that is not zero under the person\'s id, drops the rows at zero and the rows of no person, and has the one key', () => {
    withDatabase((file) => {
      const old = openDb(file, 54);
      expect(columns(old, 'chat_read_state')).toEqual(['person', 'thread', 'last_read', 'unread', 'mentions', 'updated_at', 'person_id']);
      old.exec(`
        INSERT INTO chat_read_state (person, person_id, thread, last_read, unread, mentions, updated_at) VALUES
          ('#1', 1, 'public', 'c1', 4, 1, 10),
          ('#1', 1, 'group:1', 'c2', 0, 0, 11),
          ('#1', 1, 'dm:person:1|sa', NULL, 0, 2, 12),
          ('#2', 2, 'public', NULL, 3, 0, 13),
          ('#2', 2, 'public:dev', 'c9', 0, 0, 14),
          ('ghost', NULL, 'public', NULL, 9, 3, 15);`);
      old.close();

      const db = openDb(file);
      expect(columns(db, 'chat_read_state')).toEqual(['person_id', 'thread', 'unread', 'mentions']);
      expect(db.prepare('SELECT person_id, thread, unread, mentions FROM chat_read_state ORDER BY person_id, thread').all()).toEqual([
        { person_id: 1, thread: 'dm:person:1|sa', unread: 0, mentions: 2 },
        { person_id: 1, thread: 'public', unread: 4, mentions: 1 },
        { person_id: 2, thread: 'public', unread: 3, mentions: 0 },
      ]);
      // The key is the person and the thread, and the one index left is the thread's, for forgetting a thread.
      expect((db.prepare("SELECT name FROM pragma_table_info('chat_read_state') WHERE pk > 0 ORDER BY pk").all() as { name: string }[]).map((r) => r.name)).toEqual(['person_id', 'thread']);
      expect(indexes(db, 'chat_read_state')).toEqual(['chat_read_state_thread']);
      expect(() => db.prepare("INSERT INTO chat_read_state (person_id, thread, unread, mentions) VALUES (1, 'public', 1, 0)").run()).toThrow(/UNIQUE/);
      db.close();
      // The upgrade ran once: opening the database again changes nothing.
      const again = openDb(file);
      expect(again.prepare('SELECT COUNT(*) AS n FROM chat_read_state').get()).toEqual({ n: 3 });
      again.close();
    });
  });
});
