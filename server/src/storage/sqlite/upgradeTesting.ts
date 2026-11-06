// Test support for the upgrade contract (#892): a SQLite file at the schema before peer requests had an insertion number (migration 25), reporters a name (27) and sessions a harness (28) and peer messages an author (31), a person's link the one who paused it (32),
// holding the given requests and messages in the order given. Opening it as a storage then runs migrations 26 to 32 on rows that exist.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { openSqliteStorage } from './index.js';
import type { LegacyMessage, LegacyReporter, LegacyRequest, LegacyRight, LegacySession } from '../contractUpgrade.js';
import type { Storage } from '../types.js';

/** The caller removes `dir` once the storage is closed. */
export function openUpgradedSqlite(rows: LegacyRequest[], reporters: LegacyReporter[] = [], sessions: LegacySession[] = [], messages: LegacyMessage[] = [], rights: LegacyRight[] = []): { storage: Storage; dir: string } {
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
  const link = old.prepare('INSERT INTO reporter_sessions (reporter_key, session_id) VALUES (?, ?)');
  for (const r of reporters) {
    insertReporter.run(r.key, r.kind, r.machineId, r.machineName, r.owner, r.version, r.firstSeenAt, r.lastSeenAt);
    for (const id of r.sessionIds ?? []) link.run(r.key, id);
  }
  const insertSession = old.prepare(
    `INSERT INTO sessions (id, name, status, started_at, last_seen_at, cwd, model, cost_usd, tok_in, tok_out, tok_cr, tok_cw) VALUES (?, ?, 'done', ?, ?, '/w', ?, ?, 0, 0, 0, 0)`,
  );
  const insertAgent = old.prepare(`INSERT INTO agents (session_id, id, kind, type, description, status, started_at) VALUES (?, ?, 'subagent', 'Explore', 'look', 'done', ?)`);
  for (const x of sessions) {
    insertSession.run(x.id, x.name, x.startedAt, x.startedAt, x.model, x.costUsd);
    if (x.agent) insertAgent.run(x.id, x.agent, x.startedAt);
  }
  const insertMessage = old.prepare(
    `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq)
     VALUES (?, ?, 'ka|kb', 'ka', 'kb', ?, ?, 'alpha', 'box-a', 'beta', 'box-b', ?, ?, 'delivered', ?, NULL, 0, 1, ?)`,
  );
  for (const x of messages) insertMessage.run(x.id, x.owner, x.fromSession, x.toSession, x.text, x.sentAt, x.sentAt, x.seq);
  const insertRight = old.prepare('INSERT INTO peer_rights (from_key, to_key, owner, level, paused, set_at) VALUES (?, ?, ?, ?, ?, 0)');
  for (const x of rights) insertRight.run(x.fromKey, x.toKey, x.owner, x.level, Number(x.paused));
  old.close();
  return { storage: openSqliteStorage(file, 0), dir };
}
