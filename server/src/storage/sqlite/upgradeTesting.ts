// Test support for the upgrade contract (#892): a SQLite file at the schema before peer requests had an insertion number (migration 25) and reporters a name (27),
// holding the given requests in the order given. Opening it as a storage then runs migrations 26 and 27 on rows that exist.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { openSqliteStorage } from './index.js';
import type { LegacyReporter, LegacyRequest } from '../contractUpgrade.js';
import type { Storage } from '../types.js';

/** The caller removes `dir` once the storage is closed. */
export function openUpgradedSqlite(rows: LegacyRequest[], reporters: LegacyReporter[] = []): { storage: Storage; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'podium-upgrade-'));
  const file = path.join(dir, 'podium.sqlite');
  const old = openDb(file, 25);
  const insert = old.prepare(
    `INSERT INTO peer_requests (id, owner, kind, from_key, to_key, level, reason, by, from_session, message_id, created_at, closed_at, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  for (const r of rows) insert.run(r.id, r.owner, r.kind, r.fromKey, r.toKey, r.level, r.reason, r.by, r.fromSession, r.createdAt, r.closedAt, r.outcome);
  const insertReporter = old.prepare(
    `INSERT INTO reporters (key, kind, machine_id, machine_name, owner, reporter_version, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of reporters) insertReporter.run(r.key, r.kind, r.machineId, r.machineName, r.owner, r.version, r.firstSeenAt, r.lastSeenAt);
  old.close();
  return { storage: openSqliteStorage(file, 0), dir };
}
