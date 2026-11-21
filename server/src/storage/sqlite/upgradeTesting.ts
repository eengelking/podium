// Test support for the upgrade contract (#892): a SQLite file at the schema before peer requests had an insertion number (migration 25), reporters a name (27) and sessions a harness (28) and peer messages an author (31), a person's link the one who paused it (32),
// holding the given requests and messages in the order given. Opening it as a storage then runs migrations 26 to 32 on rows that exist.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { nameKey } from '../rows.js';
import { openSqliteStorage } from './index.js';
import type { LegacyAdminRead, LegacyExtras, LegacyMessage, LegacyPublicMessage, LegacyReporter, LegacyRequest, LegacyRight, LegacySession } from '../contractUpgrade.js';
import type { Storage } from '../types.js';

/** The caller removes `dir` once the storage is closed. */
export function openUpgradedSqlite(rows: LegacyRequest[], reporters: LegacyReporter[] = [], sessions: LegacySession[] = [], messages: LegacyMessage[] = [], rights: LegacyRight[] = [], adminReads: LegacyAdminRead[] = [], publicMessages: LegacyPublicMessage[] = [], extras: LegacyExtras = {}): { storage: Storage; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'podium-upgrade-'));
  const file = path.join(dir, 'podium.sqlite');
  const old = openDb(file, 25);
  // The people this older database holds (#1284), in order, so an owner's name can be matched to one when the upgrade binds rows to ids, and the owner defaults it kept under a name.
  const insertPerson = old.prepare('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, 1000)');
  for (const name of extras.people ?? []) insertPerson.run(name, nameKey(name), `key${nameKey(name).replace(/\W/g, '')}`, '0'.repeat(64));
  const insertSetting = old.prepare("INSERT INTO peer_owner_settings (owner_lower, trust, on_request, new_send, limits_json) VALUES (?, ?, 'ask', 'ask', NULL)");
  for (const x of extras.ownerSettings ?? []) insertSetting.run(nameKey(x.owner), Number(x.trust));
  const insert = old.prepare(
    `INSERT INTO peer_requests (id, owner, kind, from_key, to_key, level, reason, by, from_session, message_id, created_at, closed_at, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  for (const r of rows) insert.run(r.id, r.owner, r.kind, r.fromKey, r.toKey, r.level, r.reason, r.by, r.fromSession, r.createdAt, r.closedAt, r.outcome);
  const insertReporter = old.prepare(
    `INSERT INTO reporters (key, kind, machine_id, machine_name, owner, reporter_version, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const link = old.prepare('INSERT INTO reporter_sessions (reporter_key, session_id) VALUES (?, ?)');
  for (const r of reporters.filter((x) => !x.bound)) {
    insertReporter.run(r.key, r.kind, r.machineId, r.machineName, r.owner, r.version, r.firstSeenAt, r.lastSeenAt);
    for (const id of r.sessionIds ?? []) link.run(r.key, id);
  }
  const insertSession = old.prepare(
    `INSERT INTO sessions (id, name, status, started_at, last_seen_at, cwd, model, cost_usd, tok_in, tok_out, tok_cr, tok_cw) VALUES (?, ?, 'done', ?, ?, '/w', ?, ?, 0, 0, 0, 0)`,
  );
  const insertAgent = old.prepare(`INSERT INTO agents (session_id, id, kind, type, description, status, started_at) VALUES (?, ?, 'subagent', 'Explore', 'look', 'done', ?)`);
  for (const x of sessions.filter((s) => !s.bound)) {
    insertSession.run(x.id, x.name, x.startedAt, x.startedAt, x.model, x.costUsd);
    if (x.agent) insertAgent.run(x.id, x.agent, x.startedAt);
  }
  const insertMessage = old.prepare(
    `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq)
     VALUES (?, ?, 'ka|kb', 'ka', 'kb', ?, ?, 'alpha', 'box-a', 'beta', 'box-b', ?, ?, 'delivered', ?, NULL, 0, 1, ?)`,
  );
  for (const x of messages.filter((m) => !m.written)) insertMessage.run(x.id, x.owner, x.fromSession, x.toSession, x.text, x.sentAt, x.sentAt, x.seq);
  const insertRight = old.prepare('INSERT INTO peer_rights (from_key, to_key, owner, level, paused, set_at) VALUES (?, ?, ?, ?, ?, 0)');
  for (const x of rights) insertRight.run(x.fromKey, x.toKey, x.owner, x.level, Number(x.paused));
  old.close();
  if (adminReads.length > 0) {
    // The Admin read records come from migration 33; migration 34 gave them a kind, so the rows go in at the schema before it.
    const mid = openDb(file, 33);
    const insertRead = mid.prepare('INSERT INTO chat_admin_reads (thread, admin_key, admin, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)');
    for (const x of adminReads.filter((r) => !r.lists)) insertRead.run(x.thread, x.adminKey, x.admin, x.startedAt, x.lastSeenAt);
    mid.close();
    if (adminReads.some((r) => r.lists)) {
      // Records that kept who they are owed to (migration 35) and came before the owed table (migration 44).
      const late = openDb(file, 43);
      const insertListed = late.prepare('INSERT INTO chat_admin_reads (thread, admin_key, admin, started_at, last_seen_at, kind, people, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const x of adminReads) if (x.lists) insertListed.run(x.thread, x.adminKey, x.admin, x.startedAt, x.lastSeenAt, x.lists.kind, JSON.stringify(x.lists.people), JSON.stringify(x.lists.seen));
      late.close();
    }
  }
  if (publicMessages.length > 0) {
    // General's messages come from migration 31; migration 45 gave them a channel, so the rows go in at the schema before it.
    const before = openDb(file, 44);
    const insertPublic = before.prepare(
      'INSERT INTO public_messages (id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)',
    );
    const insertGroup = before.prepare(
      'INSERT INTO group_messages (id, owner, group_id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)',
    );
    const insertPerson = before.prepare('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, 1000)');
    for (const name of new Set(publicMessages.flatMap((x) => (x.person ? [x.person] : [])))) insertPerson.run(name, nameKey(name), `key${nameKey(name).replace(/\W/g, '')}`, '0'.repeat(64));
    for (const x of publicMessages) {
      if (x.group) insertGroup.run(x.id, x.group.owner, x.group.groupId, x.authorKind, x.authorRef, x.authorName, x.text, x.createdAt, x.createdAt, x.mentionsJson, x.seq);
      else insertPublic.run(x.id, x.authorKind, x.authorRef, x.authorName, x.text, x.createdAt, x.createdAt, x.mentionsJson, x.seq);
    }
    before.close();
  }
  if (messages.some((m) => m.written)) {
    // Rows that say who wrote them come from migration 31; migration 46 gave them an author's id, so they go in at the schema before it, with the people they will be matched to.
    const late = openDb(file, 45);
    const insertPerson = late.prepare('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, 1000)');
    for (const name of new Set(messages.flatMap((x) => (x.written?.person ? [x.written.person] : [])))) {
      if (!late.prepare('SELECT 1 FROM people WHERE name_lower = ?').get(nameKey(name))) insertPerson.run(name, nameKey(name), `key${nameKey(name).replace(/\W/g, '')}`, '0'.repeat(64));
    }
    const insertWritten = late.prepare(
      `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq, author)
       VALUES (?, ?, 'ka|kb', 'ka', 'kb', ?, ?, ?, 'box-a', 'beta', 'box-b', ?, ?, ?, ?, NULL, 0, 0, ?, ?)`,
    );
    for (const x of messages) if (x.written) insertWritten.run(x.id, x.owner, x.fromSession, x.toSession, x.written.fromName, x.text, x.sentAt, x.written.state, x.sentAt, x.seq, x.written.author);
    late.close();
  }
  if (sessions.some((x) => x.bound) || reporters.some((r) => r.bound)) {
    // Rows that name their owner come from migrations 6 and 11; migration 49 bound them to the owner's id, so they go in at the schema before it, with the people they will be matched to.
    const late = openDb(file, 48);
    const insertPerson = late.prepare('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, 1000)');
    const names = [...sessions, ...reporters].flatMap((x) => (x.bound?.person ? [x.bound.person] : []));
    for (const name of new Set(names)) insertPerson.run(name, nameKey(name), `key${nameKey(name).replace(/\W/g, '')}`, '0'.repeat(64));
    const insertOwned = late.prepare(`INSERT INTO sessions (id, name, status, started_at, last_seen_at, cwd, model, cost_usd, tok_in, tok_out, tok_cr, tok_cw, owner) VALUES (?, ?, 'done', ?, ?, '/w', ?, ?, 0, 0, 0, 0, ?)`);
    for (const x of sessions) if (x.bound) insertOwned.run(x.id, x.name, x.startedAt, x.startedAt, x.model, x.costUsd, x.owner ?? null);
    const insertOwnedReporter = late.prepare('INSERT INTO reporters (key, kind, machine_id, machine_name, owner, reporter_version, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of reporters) if (r.bound) insertOwnedReporter.run(r.key, r.kind, r.machineId, r.machineName, r.owner, r.version, r.firstSeenAt, r.lastSeenAt);
    late.close();
  }
  return { storage: openSqliteStorage(file, 0), dir };
}
