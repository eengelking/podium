// Test support for the upgrade contract (#892) on MariaDB (#823): a database at the schema before peer requests had an insertion number and reporters a name and sessions a harness (main step 1),
// holding the given requests in the order given. Opening it as a storage then runs steps 2 to 5 on rows that exist. The caller drops the database.
import { nameKey } from '../rows.js';
import { MariaDbConn, parseTarget } from './conn.js';
import { MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { openMariaDbStorage } from './index.js';
import { createTestDatabase, type TestDatabase } from './testing.js';
import { LEGACY_RIGHT_AT, legacyDailyInsert, NEWCOMER_AT, type LegacyAdminRead, type LegacyChat, type LegacyDaily, type LegacyExtras, type LegacyMessage, type LegacyPublicMessage, type LegacyReporter, type LegacyRequest, type LegacyRight, type LegacySession } from '../contractUpgrade.js';
import type { Storage } from '../types.js';

export async function openUpgradedMariaDb(rows: LegacyRequest[], reporters: LegacyReporter[] = [], sessions: LegacySession[] = [], messages: LegacyMessage[] = [], rights: LegacyRight[] = [], adminReads: LegacyAdminRead[] = [], publicMessages: LegacyPublicMessage[] = [], extras: LegacyExtras = {}, chat?: LegacyChat, daily: LegacyDaily[] = []): Promise<{ storage: Storage; td: TestDatabase }> {
  const td = await createTestDatabase();
  try {
    return { storage: await build(td, rows, reporters, sessions, messages, rights, adminReads, publicMessages, extras, chat, daily), td };
  } catch (e) {
    await td.drop();
    throw e;
  }
}

async function build(td: TestDatabase, rows: LegacyRequest[], reporters: LegacyReporter[], sessions: LegacySession[], messages: LegacyMessage[], rights: LegacyRight[], adminReads: LegacyAdminRead[], publicMessages: LegacyPublicMessage[], extras: LegacyExtras, chat: LegacyChat | undefined, daily: LegacyDaily[]): Promise<Storage> {
  const old = new MariaDbConn({ target: parseTarget(td.url), max: 2 });
  try {
    await migrate(old, MAIN_MIGRATIONS, MAIN_STEPS.slice(0, 1));
    // The people this older database holds (#1284), in order, so an owner's name can be matched to one when the upgrade binds rows to ids, and the owner defaults it kept under a name.
    for (const name of extras.people ?? []) await old.run('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, 1000)', [name, nameKey(name), `key${nameKey(name).replace(/\W/g, '')}`, '0'.repeat(64)]);
    for (const name of extras.newcomers ?? []) await old.run('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)', [name, nameKey(name), `key${nameKey(name).replace(/\W/g, '')}`, '0'.repeat(64), NEWCOMER_AT]);
    for (const x of extras.ownerSettings ?? []) await old.run("INSERT INTO peer_owner_settings (owner_lower, trust, on_request, new_send, limits_json) VALUES (?, ?, 'ask', 'ask', NULL)", [nameKey(x.owner), Number(x.trust)]);
    for (const r of rows) {
      await old.run(
        `INSERT INTO peer_requests (id, owner, kind, from_key, to_key, level, reason, by, from_session, message_id, created_at, closed_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [r.id, r.owner, r.kind, r.fromKey, r.toKey, r.level, r.reason, r.by, r.fromSession, r.createdAt, r.closedAt, r.outcome],
      );
    }
    for (const r of reporters.filter((x) => !x.bound)) {
      await old.run(
        `INSERT INTO reporters (key, kind, machine_id, machine_name, owner, reporter_version, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.key, r.kind, r.machineId, r.machineName, r.owner, r.version, r.firstSeenAt, r.lastSeenAt],
      );
      for (const id of r.sessionIds ?? []) await old.run('INSERT INTO reporter_sessions (reporter_key, session_id) VALUES (?, ?)', [r.key, id]);
    }
    for (const x of sessions.filter((s) => !s.bound)) {
      await old.run(
        `INSERT INTO sessions (id, name, status, started_at, last_seen_at, cwd, model, cost_usd, tok_in, tok_out, tok_cr, tok_cw) VALUES (?, ?, 'done', ?, ?, '/w', ?, ?, 0, 0, 0, 0)`,
        [x.id, x.name, x.startedAt, x.startedAt, x.model, x.costUsd],
      );
      if (x.agent) {
        await old.run(`INSERT INTO agents (session_id, id, kind, type, description, status, started_at) VALUES (?, ?, 'subagent', 'Explore', 'look', 'done', ?)`, [x.id, x.agent, x.startedAt]);
      }
    }
    for (const x of messages.filter((m) => !m.written)) {
      await old.run(
        `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq)
         VALUES (?, ?, 'ka|kb', 'ka', 'kb', ?, ?, 'alpha', 'box-a', 'beta', 'box-b', ?, ?, 'delivered', ?, NULL, 0, 1, ?)`,
        [x.id, x.owner, x.fromSession, x.toSession, x.text, x.sentAt, x.sentAt, x.seq],
      );
    }
    for (const x of rights) {
      await old.run('INSERT INTO peer_rights (from_key, to_key, owner, level, paused, set_at) VALUES (?, ?, ?, ?, ?, ?)', [x.fromKey, x.toKey, x.owner, x.level, Number(x.paused), LEGACY_RIGHT_AT]);
    }
    if (adminReads.length > 0) {
      // The Admin read records come from step 9; step 10 gave them a kind, so the rows go in at the schema before it.
      await migrate(old, MAIN_MIGRATIONS, MAIN_STEPS.filter((s) => s.version <= 9));
      for (const x of adminReads.filter((r) => !r.lists)) {
        await old.run('INSERT INTO chat_admin_reads (thread, admin_key, admin, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', [x.thread, x.adminKey, x.admin, x.startedAt, x.lastSeenAt]);
      }
      if (adminReads.some((r) => r.lists)) {
        // Records that kept who they are owed to (step 11) and came before the owed table (step 20).
        await migrate(old, MAIN_MIGRATIONS, MAIN_STEPS.filter((s) => s.version <= 19));
        for (const x of adminReads) {
          if (!x.lists) continue;
          await old.run('INSERT INTO chat_admin_reads (thread, admin_key, admin, started_at, last_seen_at, kind, people, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [x.thread, x.adminKey, x.admin, x.startedAt, x.lastSeenAt, x.lists.kind, JSON.stringify(x.lists.people), JSON.stringify(x.lists.seen)]);
        }
      }
    }
    if (publicMessages.length > 0) {
      // General's messages come from step 7; step 21 gave them a channel, so the rows go in at the schema before it.
      await migrate(old, MAIN_MIGRATIONS, MAIN_STEPS.filter((s) => s.version <= 20));
      for (const name of new Set(publicMessages.flatMap((x) => (x.person ? [x.person] : [])))) {
        await old.run('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, 1000)', [name, nameKey(name), `key${nameKey(name).replace(/\W/g, '')}`, '0'.repeat(64)]);
      }
      for (const x of publicMessages) {
        if (x.group) {
          await old.run(
            'INSERT INTO group_messages (id, owner, group_id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)',
            [x.id, x.group.owner, x.group.groupId, x.authorKind, x.authorRef, x.authorName, x.text, x.createdAt, x.createdAt, x.mentionsJson, x.seq],
          );
          continue;
        }
        await old.run(
          'INSERT INTO public_messages (id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)',
          [x.id, x.authorKind, x.authorRef, x.authorName, x.text, x.createdAt, x.createdAt, x.mentionsJson, x.seq],
        );
      }
    }
    if (messages.some((m) => m.written)) {
      // Rows that say who wrote them come from step 1; step 22 gave them an author's id, so they go in at the schema before it, with the people they will be matched to.
      await migrate(old, MAIN_MIGRATIONS, MAIN_STEPS.filter((s) => s.version <= 21));
      for (const name of new Set(messages.flatMap((x) => (x.written?.person ? [x.written.person] : [])))) {
        if (!(await old.get('SELECT 1 AS x FROM people WHERE name_lower = ?', [nameKey(name)]))) {
          await old.run('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, 1000)', [name, nameKey(name), `key${nameKey(name).replace(/\W/g, '')}`, '0'.repeat(64)]);
        }
      }
      for (const x of messages) {
        if (!x.written) continue;
        await old.run(
          `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq, author)
           VALUES (?, ?, 'ka|kb', 'ka', 'kb', ?, ?, ?, 'box-a', 'beta', 'box-b', ?, ?, ?, ?, NULL, 0, 0, ?, ?)`,
          [x.id, x.owner, x.fromSession, x.toSession, x.written.fromName, x.text, x.sentAt, x.written.state, x.sentAt, x.seq, x.written.author],
        );
      }
    }
    if (sessions.some((x) => x.bound) || reporters.some((r) => r.bound)) {
      // Rows that name their owner come from step 1; step 25 bound them to the owner's id, so they go in at the schema before it, with the people they will be matched to.
      await migrate(old, MAIN_MIGRATIONS, MAIN_STEPS.filter((s) => s.version <= 24));
      for (const name of new Set([...sessions, ...reporters].flatMap((x) => (x.bound?.person ? [x.bound.person] : [])))) {
        await old.run('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, 1000)', [name, nameKey(name), `key${nameKey(name).replace(/\W/g, '')}`, '0'.repeat(64)]);
      }
      for (const x of sessions) {
        if (!x.bound) continue;
        await old.run(
          `INSERT INTO sessions (id, name, status, started_at, last_seen_at, cwd, model, cost_usd, tok_in, tok_out, tok_cr, tok_cw, owner) VALUES (?, ?, 'done', ?, ?, '/w', ?, ?, 0, 0, 0, 0, ?)`,
          [x.id, x.name, x.startedAt, x.startedAt, x.model, x.costUsd, x.owner ?? null],
        );
      }
      for (const r of reporters) {
        if (!r.bound) continue;
        await old.run('INSERT INTO reporters (key, kind, machine_id, machine_name, owner, reporter_version, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [r.key, r.kind, r.machineId, r.machineName, r.owner, r.version, r.firstSeenAt, r.lastSeenAt]);
      }
    }
    if (chat) {
      // Chat kept under a person's name comes from steps 7, 20 and 21; step 27 bound it to the person's id, so it goes in at the schema before it, with the people it will be matched to.
      await migrate(old, MAIN_MIGRATIONS, MAIN_STEPS.filter((s) => s.version <= 24));
      for (const p of chat.people ?? []) {
        if (!(await old.get('SELECT 1 AS x FROM people WHERE name_lower = ?', [nameKey(p.name)]))) {
          await old.run('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)', [p.name, nameKey(p.name), `key${nameKey(p.name).replace(/\W/g, '')}`, '0'.repeat(64), p.createdAt]);
        }
      }
      for (const r of chat.readState ?? []) await old.run('INSERT INTO chat_read_state (person, thread, last_read, unread, mentions, updated_at) VALUES (?, ?, NULL, ?, 0, 0)', [r.person, r.thread, r.unread]);
      for (const c of chat.channels ?? []) await old.run("INSERT INTO public_channels (name, description, created_by, created_by_name, created_at, updated_at) VALUES (?, '', ?, ?, ?, ?)", [c.name, c.createdBy, c.createdByName, c.createdAt, c.createdAt]);
      for (const o of chat.owed ?? []) await old.run('INSERT INTO chat_admin_owed (person_key, thread, admin_key, started_at) VALUES (?, ?, ?, ?)', [o.person, o.thread, o.adminKey, o.startedAt]);
      for (const f of chat.flags ?? []) await old.run('INSERT INTO settings (key, value) VALUES (?, ?)', [`chat.flag.${f.scope}`, f.value]);
    }
    if (daily.length > 0) {
      // Daily rows that name only their owner come from the first steps; step 28 bound them to the owner's id, so they go in at the schema before it, with the people they will be matched to.
      await migrate(old, MAIN_MIGRATIONS, MAIN_STEPS.filter((s) => s.version <= 27));
      for (const name of new Set(daily.flatMap((x) => (x.person ? [x.person] : [])))) {
        if (!(await old.get('SELECT 1 FROM people WHERE name_lower = ?', [nameKey(name)]))) await old.run('INSERT INTO people (name, name_lower, key_id, token_hash, created_at) VALUES (?, ?, ?, ?, 1000)', [name, nameKey(name), `key${nameKey(name).replace(/\W/g, '')}`, '0'.repeat(64)]);
      }
      for (const x of daily) {
        const { sql, args } = legacyDailyInsert(x);
        await old.run(sql, args);
      }
    }
  } finally {
    await old.close();
  }
  return openMariaDbStorage(td.url.replace(/^mariadb:\/\//, ''), 0);
}
