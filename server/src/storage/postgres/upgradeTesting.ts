// Test support for the upgrade contract (#892): a PostgreSQL database at the schema before peer requests had an insertion number and reporters a name and sessions a harness (main step 1),
// holding the given requests in the order given. Opening it as a storage then runs steps 2 to 5 on rows that exist. The caller drops the database.
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { openPostgresStorage } from './index.js';
import { createTestDatabase, type TestDatabase } from './testing.js';
import type { LegacyMessage, LegacyReporter, LegacyRequest, LegacyRight, LegacySession } from '../contractUpgrade.js';
import type { Storage } from '../types.js';

export async function openUpgradedPostgres(rows: LegacyRequest[], reporters: LegacyReporter[] = [], sessions: LegacySession[] = [], messages: LegacyMessage[] = [], rights: LegacyRight[] = []): Promise<{ storage: Storage; td: TestDatabase }> {
  const td = await createTestDatabase();
  try {
    return { storage: await build(td, rows, reporters, sessions, messages, rights), td };
  } catch (e) {
    await td.drop();
    throw e;
  }
}

async function build(td: TestDatabase, rows: LegacyRequest[], reporters: LegacyReporter[], sessions: LegacySession[], messages: LegacyMessage[], rights: LegacyRight[]): Promise<Storage> {
  const old = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 2, name: 'test' });
  try {
    await migrate(old, MAIN_SCHEMA, MAIN_STEPS.slice(0, 1));
    for (const r of rows) {
      await old.run(
        `INSERT INTO peer_requests (id, owner, kind, from_key, to_key, level, reason, by, from_session, message_id, created_at, closed_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [r.id, r.owner, r.kind, r.fromKey, r.toKey, r.level, r.reason, r.by, r.fromSession, r.createdAt, r.closedAt, r.outcome],
      );
    }
    for (const r of reporters) {
      await old.run(
        `INSERT INTO reporters (key, kind, machine_id, machine_name, owner, reporter_version, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.key, r.kind, r.machineId, r.machineName, r.owner, r.version, r.firstSeenAt, r.lastSeenAt],
      );
      for (const id of r.sessionIds ?? []) await old.run('INSERT INTO reporter_sessions (reporter_key, session_id) VALUES (?, ?)', [r.key, id]);
    }
    for (const x of sessions) {
      await old.run(
        `INSERT INTO sessions (id, name, status, started_at, last_seen_at, cwd, model, cost_usd, tok_in, tok_out, tok_cr, tok_cw) VALUES (?, ?, 'done', ?, ?, '/w', ?, ?, 0, 0, 0, 0)`,
        [x.id, x.name, x.startedAt, x.startedAt, x.model, x.costUsd],
      );
      if (x.agent) {
        await old.run(`INSERT INTO agents (session_id, id, kind, type, description, status, started_at) VALUES (?, ?, 'subagent', 'Explore', 'look', 'done', ?)`, [x.id, x.agent, x.startedAt]);
      }
    }
    for (const x of messages) {
      await old.run(
        `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, why, approved, handed, seq)
         VALUES (?, ?, 'ka|kb', 'ka', 'kb', ?, ?, 'alpha', 'box-a', 'beta', 'box-b', ?, ?, 'delivered', ?, NULL, 0, 1, ?)`,
        [x.id, x.owner, x.fromSession, x.toSession, x.text, x.sentAt, x.sentAt, x.seq],
      );
    }
    for (const x of rights) {
      await old.run('INSERT INTO peer_rights (from_key, to_key, owner, level, paused, set_at) VALUES (?, ?, ?, ?, ?, 0)', [x.fromKey, x.toKey, x.owner, x.level, Number(x.paused)]);
    }
  } finally {
    await old.close();
  }
  return openPostgresStorage(td.url.replace(/^postgres:\/\//, ''), 0);
}
