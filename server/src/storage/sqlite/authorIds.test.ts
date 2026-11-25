// Migration 46 gives a direct message written by a person the id of its author (#1269), as it does a channel message: the contract's upgrade case covers the channel tables
// on every adapter, and this one reads the `peer_messages` column, which no store method returns yet.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from './db.js';

describe('migration 46 on direct messages', () => {
  it('gives a person\'s message the id of the person its sender or owner names, and leaves an agent\'s and an unmatched one without', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'podium-author-ids-'));
    try {
      const file = path.join(dir, 'podium.sqlite');
      const old = openDb(file, 45);
      const person = old.prepare('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, 1000)');
      person.run('Ed Smith', 'ed smith', 'k1', '0'.repeat(64));
      person.run('Zoe', 'zoe', 'k2', '0'.repeat(64));
      const insert = old.prepare(
        `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq, author)
         VALUES (?, ?, 'l', '', 'kb', ?, 'sb', 'x', '', 'beta', 'box-b', 'hi', 1, 'delivered', 1, NULL, 0, 1, ?, ?)`,
      );
      insert.run('m1', 'Zoe', 'person:ed  smith', 1, 'person');
      insert.run('m2', 'Ed Smith', 'sa', 2, 'person');
      insert.run('m3', 'nobody', 'person:ghost', 3, 'person');
      insert.run('m4', 'Zoe', 'sa', 4, 'agent');
      old.close();
      const db = openDb(file);
      const ids = Object.fromEntries((db.prepare('SELECT id, author_id FROM peer_messages ORDER BY seq').all() as unknown as { id: string; author_id: number | null }[]).map((r) => [r.id, r.author_id]));
      const smith = (db.prepare("SELECT id FROM people WHERE name_lower = 'ed smith'").get() as { id: number }).id;
      expect(ids).toEqual({ m1: smith, m2: smith, m3: null, m4: null });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an author id that is already set and fills the rows that have none, as PostgreSQL and MariaDB do', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'podium-author-ids-'));
    try {
      const file = path.join(dir, 'podium.sqlite');
      const old = openDb(file, 45);
      const person = old.prepare('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, 0)');
      person.run('Ana', 'ana', 'k1', '0'.repeat(64));
      person.run('Zoe', 'zoe', 'k2', '0'.repeat(64));
      const group = old.prepare(
        "INSERT INTO group_messages (id, owner, group_id, author_kind, author_ref, author_name, text, created_at, updated_at, seq) VALUES (?, 'o', 'g', 'person', ?, ?, 'hi', 1, 1, ?)",
      );
      group.run('g1', 'Ana', 'Ana', 1);
      group.run('g2', 'Zoe', 'Zoe', 2);
      const pub = old.prepare("INSERT INTO public_messages (id, author_kind, author_ref, author_name, text, created_at, updated_at, seq) VALUES (?, 'person', ?, ?, 'hi', 1, 1, ?)");
      pub.run('p1', 'Ana', 'Ana', 1);
      pub.run('p2', 'Zoe', 'Zoe', 2);
      const peer = old.prepare(
        `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq, author)
         VALUES (?, ?, 'l', '', 'kb', 'sa', 'sb', 'x', '', 'beta', 'box-b', 'hi', 1, 'delivered', 1, NULL, 0, 1, ?, 'person')`,
      );
      peer.run('m1', 'Ana', 1);
      peer.run('m2', 'Zoe', 2);
      // The column does not exist yet at version 45, so a row cannot carry an id before the step runs. This trigger fires when the step fills the first group message (Ana's, which
      // sorts first) and gives Zoe's rows an id of 999 before the step reaches them, as a step that had already run halfway would have left them.
      old.exec(`CREATE TRIGGER preset AFTER UPDATE ON group_messages WHEN NEW.id = 'g1' BEGIN
        UPDATE group_messages SET author_id = 999 WHERE id = 'g2';
        UPDATE public_messages SET author_id = 999 WHERE id = 'p2';
        UPDATE peer_messages SET author_id = 999 WHERE id = 'm2';
      END`);
      old.close();
      const db = openDb(file);
      const ana = (db.prepare("SELECT id FROM people WHERE name_lower = 'ana'").get() as { id: number }).id;
      const ids = (table: string): Record<string, number | null> =>
        Object.fromEntries((db.prepare(`SELECT id, author_id FROM ${table} ORDER BY seq`).all() as unknown as { id: string; author_id: number | null }[]).map((r) => [r.id, r.author_id]));
      expect(ids('group_messages')).toEqual({ g1: ana, g2: 999 });
      expect(ids('public_messages')).toEqual({ p1: ana, p2: 999 });
      expect(ids('peer_messages')).toEqual({ m1: ana, m2: 999 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
