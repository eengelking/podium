// Migration 61 (#1296) keys an owner's defaults by the person's id alone, as PostgreSQL step 36 and MariaDB step 36 do. The contract's upgrade cases (`contractUpgrade.ts`) run on every adapter and read what a store
// gives back; this reads the table itself, which no store method returns, on rows an older database holds.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from './db.js';

const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all() as unknown as { name: string }[]).map((r) => r.name);
const indexes = (db: DatabaseSync, table: string): string[] => (db.prepare(`SELECT name FROM pragma_index_list('${table}') WHERE origin = 'c' ORDER BY name`).all() as unknown as { name: string }[]).map((r) => r.name);
const key = (db: DatabaseSync, table: string): string[] => (db.prepare(`SELECT name FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`).all() as unknown as { name: string }[]).map((r) => r.name);

function withDatabase(body: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'podium-one-home-c-'));
  try {
    body(path.join(dir, 'podium.sqlite'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('migration 61: an owner\'s defaults are found by the person\'s id', () => {
  it('keeps each row under its id, drops the name key and its index, drops a row with no id and the rows of an id held twice, and runs once', () => {
    withDatabase((file) => {
      const old = openDb(file, 60);
      expect(columns(old, 'peer_owner_settings')).toEqual(['owner_lower', 'trust', 'on_request', 'new_send', 'limits_json', 'owner_id']);
      expect(key(old, 'peer_owner_settings')).toEqual(['owner_lower']);
      expect(indexes(old, 'peer_owner_settings')).toEqual(['peer_owner_settings_owner_id']);
      // Ids 11 and 12 as the server writes them (the key is the id as text); 14 whose key is not its id (nothing writes that, and every reader goes by `owner_id`); `ghost` with no id; and 13 held twice.
      old.exec(`
        INSERT INTO peer_owner_settings (owner_lower, owner_id, trust, on_request, new_send, limits_json) VALUES
          ('11', 11, 1, 'send', 'ask', '{"roundTrips":3}'), ('12', 12, 0, 'ask', 'send', NULL), ('x14', 14, 1, 'ask', 'ask', NULL),
          ('ghost', NULL, 1, 'send', 'send', NULL), ('13', 13, 1, 'send', 'send', NULL), ('ed', 13, 0, 'ask', 'ask', NULL);`);
      old.close();

      const db = openDb(file);
      expect(columns(db, 'peer_owner_settings')).toEqual(['owner_id', 'trust', 'on_request', 'new_send', 'limits_json']);
      expect(key(db, 'peer_owner_settings')).toEqual(['owner_id']);
      expect(indexes(db, 'peer_owner_settings')).toEqual([]);
      expect(db.prepare('SELECT owner_id, trust, on_request, new_send, limits_json FROM peer_owner_settings ORDER BY owner_id').all()).toEqual([
        { owner_id: 11, trust: 1, on_request: 'send', new_send: 'ask', limits_json: '{"roundTrips":3}' },
        { owner_id: 12, trust: 0, on_request: 'ask', new_send: 'send', limits_json: null },
        { owner_id: 14, trust: 1, on_request: 'ask', new_send: 'ask', limits_json: null },
      ]);
      expect(() => db.prepare("INSERT INTO peer_owner_settings (owner_id, trust, on_request, new_send) VALUES (11, 0, 'ask', 'ask')").run()).toThrow(/UNIQUE/);
      db.close();
      // The step ran once: opening the database again changes nothing.
      const again = openDb(file);
      expect((again.prepare('SELECT COUNT(*) AS n FROM peer_owner_settings').get() as { n: number }).n).toBe(3);
      again.close();
    });
  });
});
