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
});
