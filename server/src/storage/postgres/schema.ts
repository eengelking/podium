// The PostgreSQL schema (#822): the end state of the SQLite adapter's 25 migrations and 5 Activity steps, as one baseline each. A later
// change is a step added to the list, with the next version number, and never an edit to an earlier step.
//
// One text rule: every text column is `COLLATE "C"`, so bytes compare as they are and an index or a unique key behaves as it does on
// SQLite, whatever locale the database was created with. Case-insensitive keys are stored folded (`name_lower`) or folded with
// `podium_lower`, which folds ASCII letters only, as SQLite's `lower()` does.
import { PgDb } from './conn.js';
import { flagScopeWithId, listWithIds, peerPersonKey, personKey, threadWithId, type PersonIndex } from '../chatRows.js';
import { CHAT_IDS_DONE_KEY, idsOf, OWNED_PEER_TABLES, PEER_IDS_DONE_KEY, PERSON_END_COLUMNS, personEndKey, personFirstDay, renameLinkEnd } from '../peerOwnerIds.js';
import { nameKey } from '../rows.js';

type DB = PgDb;

export interface Step { version: number; sql: string; after?: (db: PgDb) => Promise<void> }

/**
 * Gives the person-written messages that exist the id of their author (#1269), by the author's folded name against `people.name_lower`, which `nameKey` also writes. It is JS
 * because SQL cannot fold a name the way `nameKey` does (it collapses runs of spaces and lowercases every letter, where the database's `lower()` is ASCII only). A message whose
 * author matches no person keeps no id, and nobody can change it. Agents' and reporters' messages keep none. Only rows without an id are written, so a run that is repeated adds nothing.
 */
async function fillAuthorIds(db: DB): Promise<void> {
  const ids = new Map((await db.all<{ id: number; name_lower: string }>('SELECT id, name_lower FROM people ORDER BY id')).map((r) => [r.name_lower, Number(r.id)]));
  if (ids.size === 0) return;
  for (const table of ['group_messages', 'public_messages']) {
    for (const r of await db.all<{ author_ref: string }>(`SELECT DISTINCT author_ref FROM ${table} WHERE author_kind = 'person' AND author_id IS NULL ORDER BY author_ref`)) {
      const id = ids.get(nameKey(r.author_ref));
      if (id !== undefined) await db.run(`UPDATE ${table} SET author_id = ? WHERE author_kind = 'person' AND author_ref = ? AND author_id IS NULL`, [id, r.author_ref]);
    }
  }
  for (const r of await db.all<{ from_session: string; owner: string }>("SELECT DISTINCT from_session, owner FROM peer_messages WHERE author = 'person' AND author_id IS NULL ORDER BY from_session, owner")) {
    const id = ids.get(peerPersonKey(r.from_session, r.owner));
    if (id !== undefined) await db.run("UPDATE peer_messages SET author_id = ? WHERE author = 'person' AND from_session = ? AND owner = ? AND author_id IS NULL", [id, r.from_session, r.owner]);
  }
}

/** Gives every session that exists an agent id, oldest first, then binds each stored message to the agents of its two sessions (#1284). See SQLite's `fillAgentIds`. */
async function fillAgentIds(db: DB): Promise<void> {
  await db.run('INSERT INTO agent_ids (session_id) SELECT id FROM sessions ORDER BY started_at, id ON CONFLICT (session_id) DO NOTHING');
  await db.run('UPDATE peer_messages SET from_agent = (SELECT id FROM agent_ids WHERE session_id = peer_messages.from_session) WHERE from_agent IS NULL');
  await db.run('UPDATE peer_messages SET to_agent = (SELECT id FROM agent_ids WHERE session_id = peer_messages.to_session) WHERE to_agent IS NULL');
}

/** The people by folded name, with the time each was made, for the upgrade steps that bind rows to a person's id. */
async function peopleIndex(db: DB): Promise<PersonIndex> {
  return new Map((await db.all<{ id: number; name_lower: string; created_at: number }>('SELECT id, name_lower, created_at FROM people ORDER BY id')).map((r) => [r.name_lower, { id: Number(r.id), createdAt: Number(r.created_at) }]));
}

/** True the first time it is called for `key` (an upgrade step's mark, `PEER_IDS_DONE_KEY` or `CHAT_IDS_DONE_KEY`), and writes the mark; false after, so the step's rewrite of name keys runs once. */
async function firstRun(db: DB, key: string): Promise<boolean> {
  if (await db.get('SELECT 1 AS x FROM settings WHERE key = ?', [key])) return false;
  await db.run("INSERT INTO settings (key, value) VALUES (?, '1')", [key]);
  return true;
}

/** Gives the sessions and reporters that exist the id of their owner (#1284), by the owner's folded name against `people.name_lower`, and only a person who existed when the row was written. See SQLite's `fillOwnerIds`. Only rows without an id are written. */
async function fillOwnerIds(db: DB): Promise<void> {
  const people = await peopleIndex(db);
  if (people.size === 0) return;
  for (const [table, at] of [['sessions', 'started_at'], ['reporters', 'first_seen_at']] as const) {
    for (const r of await db.all<{ owner: string }>(`SELECT DISTINCT owner FROM ${table} WHERE owner IS NOT NULL AND owner_id IS NULL ORDER BY owner`)) {
      const p = people.get(nameKey(r.owner));
      if (p) await db.run(`UPDATE ${table} SET owner_id = ? WHERE owner = ? AND owner_id IS NULL AND ${at} >= ?`, [p.id, r.owner, p.createdAt]);
    }
  }
}

/**
 * Binds the peer-messaging tables to a person by id (#1284), as SQLite's `fillPeerOwnerIds` does: the rights, requests and messages that exist get the id of their owner by the owner's folded
 * name against `people.name_lower`, a row whose owner matches no person keeps none, a person's end of a link (`person:<name>`) becomes `person:<id>` (or `person:gone:<name>`), and the
 * owner defaults are rekeyed by the id, a row of nobody dropped. A row is only given to a person who existed when it was written, and the step runs once (`PEER_IDS_DONE_KEY`); see SQLite's.
 */
async function fillPeerOwnerIds(db: DB): Promise<void> {
  if (!(await firstRun(db, PEER_IDS_DONE_KEY))) return;
  const people = await peopleIndex(db);
  const ids = idsOf(people);
  for (const { table, at } of OWNED_PEER_TABLES) {
    // order-insensitive: each owner name is written on its own rows, whatever the order.
    for (const r of await db.all<{ owner: string }>(`SELECT DISTINCT owner FROM ${table} WHERE owner_id IS NULL ORDER BY owner`)) {
      const p = people.get(nameKey(r.owner));
      if (p) await db.run(`UPDATE ${table} SET owner_id = ? WHERE owner = ? AND owner_id IS NULL AND ${at} >= ?`, [p.id, r.owner, p.createdAt]);
    }
  }
  // The link names first, while the session columns still say which end is the person.
  const links = await db.all<{ link: string; from_session: string; to_session: string }>("SELECT DISTINCT link, from_session, to_session FROM peer_messages WHERE substr(from_session, 1, 7) = 'person:' OR substr(to_session, 1, 7) = 'person:' ORDER BY link, from_session, to_session");
  for (const l of links) {
    const end = l.from_session.startsWith('person:') ? l.from_session : l.to_session;
    const next = renameLinkEnd(l.link, end, personEndKey(end, ids));
    if (next !== null && next !== l.link) await db.run('UPDATE peer_messages SET link = ? WHERE link = ? AND (from_session = ? OR to_session = ?)', [next, l.link, l.from_session, l.to_session]);
  }
  for (const { table, columns } of PERSON_END_COLUMNS) {
    for (const col of columns) {
      // order-insensitive: each old key is moved to its new one, through a marker, so a new key is never taken for an old one.
      let moved = false;
      for (const { k } of await db.all<{ k: string }>(`SELECT DISTINCT ${col} AS k FROM ${table} WHERE substr(${col}, 1, 7) = 'person:' ORDER BY ${col}`)) {
        const to = personEndKey(k, ids);
        if (to === k) continue;
        await db.run(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [`~${to}`, k]);
        moved = true;
      }
      if (moved) await db.run(`UPDATE ${table} SET ${col} = substr(${col}, 2) WHERE substr(${col}, 1, 8) = '~person:'`);
    }
  }
  const settings = await db.all<{ owner_lower: string; trust: number; on_request: string; new_send: string; limits_json: string | null }>('SELECT owner_lower, trust, on_request, new_send, limits_json FROM peer_owner_settings WHERE owner_id IS NULL ORDER BY owner_lower');
  await db.run('DELETE FROM peer_owner_settings WHERE owner_id IS NULL');
  for (const s of settings) {
    const id = ids.get(s.owner_lower);
    if (id !== undefined) await db.run('INSERT INTO peer_owner_settings (owner_lower, owner_id, trust, on_request, new_send, limits_json) VALUES (?, ?, ?, ?, ?, ?)', [String(id), id, s.trust, s.on_request, s.new_send, s.limits_json]);
  }
}

/**
 * Binds the Chat data the older server kept under a person's NAME to the person's id (#1284), as SQLite's `fillChatPersonIds` does: see it for what is rewritten and why a row whose name matches no person
 * (or whose person did not exist yet when it was written) keeps no id. The step runs once (`CHAT_IDS_DONE_KEY`), so a name in a thread name is never an id it wrote before, an all-digit name included.
 */
async function fillChatPersonIds(db: DB): Promise<void> {
  if (!(await firstRun(db, CHAT_IDS_DONE_KEY))) return;
  const people = await peopleIndex(db);
  if (people.size === 0) return;
  for (const r of await db.all<{ owner: string }>('SELECT DISTINCT owner FROM group_messages WHERE owner_id IS NULL ORDER BY owner')) {
    const p = people.get(nameKey(r.owner));
    if (p) await db.run('UPDATE group_messages SET owner_id = ? WHERE owner = ? AND owner_id IS NULL AND created_at >= ?', [p.id, r.owner, p.createdAt]);
  }
  for (const p of people.values()) {
    for (const table of ['group_messages', 'public_messages']) await db.run(`UPDATE ${table} SET author_id = NULL WHERE author_id = ? AND created_at < ?`, [p.id, p.createdAt]);
  }
  for (const r of await db.all<{ name: string; created_by: string; created_at: number }>("SELECT name, created_by, created_at FROM public_channels WHERE created_by_id IS NULL AND created_by <> '' ORDER BY name")) {
    const p = people.get(nameKey(r.created_by));
    if (p && p.createdAt <= Number(r.created_at)) await db.run('UPDATE public_channels SET created_by_id = ? WHERE name = ?', [p.id, r.name]);
  }
  for (const r of await db.all<{ thread: string }>('SELECT DISTINCT thread FROM chat_admin_reads ORDER BY thread')) {
    const to = threadWithId(r.thread, people);
    if (to) await db.run('UPDATE chat_admin_reads SET thread = ? WHERE thread = ?', [to, r.thread]);
  }
  const state = await db.all<{ person: string; thread: string; last_read: string | null; unread: number; mentions: number; updated_at: number }>('SELECT person, thread, last_read, unread, mentions, updated_at FROM chat_read_state WHERE person_id IS NULL ORDER BY person, thread');
  await db.run('DELETE FROM chat_read_state WHERE person_id IS NULL');
  for (const r of state) {
    const p = people.get(nameKey(r.person));
    const thread = threadWithId(r.thread, people);
    if (!p || thread === '') continue;
    await db.run('INSERT INTO chat_read_state (person, person_id, thread, last_read, unread, mentions, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [personKey(p.id), p.id, thread ?? r.thread, r.last_read, Number(r.unread), Number(r.mentions), Number(r.updated_at)]);
  }
  const owed = await db.all<{ person_key: string; thread: string; admin_key: string; started_at: number }>('SELECT person_key, thread, admin_key, started_at FROM chat_admin_owed WHERE person_id IS NULL ORDER BY person_key, thread, admin_key, started_at');
  await db.run('DELETE FROM chat_admin_owed WHERE person_id IS NULL');
  for (const r of owed) {
    const p = people.get(nameKey(r.person_key));
    if (!p) continue;
    const thread = threadWithId(r.thread, people);
    await db.run('INSERT INTO chat_admin_owed (person_key, person_id, thread, admin_key, started_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [personKey(p.id), p.id, thread || r.thread, r.admin_key, Number(r.started_at)]);
  }
  for (const r of await db.all<{ thread: string; admin_key: string; started_at: number; people: string; seen: string }>("SELECT thread, admin_key, started_at, people, seen FROM chat_admin_reads WHERE people <> '[]' OR seen <> '[]' ORDER BY thread, started_at, admin_key")) {
    const ps = listWithIds(r.people, people);
    const ss = listWithIds(r.seen, people);
    if (ps !== null || ss !== null) await db.run('UPDATE chat_admin_reads SET people = ?, seen = ? WHERE thread = ? AND admin_key = ? AND started_at = ?', [ps ?? r.people, ss ?? r.seen, r.thread, r.admin_key, Number(r.started_at)]);
  }
  for (const r of await db.all<{ key: string }>("SELECT key FROM settings WHERE substr(key, 1, 10) = 'chat.flag.' ORDER BY key")) {
    const to = flagScopeWithId(r.key.slice('chat.flag.'.length), people);
    if (to === null) continue;
    if (to === '') await db.run('DELETE FROM settings WHERE key = ?', [r.key]);
    else await db.run('UPDATE settings SET key = ? WHERE key = ?', [`chat.flag.${to}`, r.key]);
  }
}

/** The daily tables that carry a person (#1284): their rows are bound to `people.id` by `owner_id`, with 0 for no person. */
const OWNED_DAILY = ['usage_daily', 'failures_daily', 'skills_daily', 'person_places_daily', 'person_sessions_daily'] as const;

/** Gives the daily rows that exist the id of their owner (#1284), and takes the group off the rows whose owner matches no person. See SQLite's `fillDailyOwnerIds`. Only rows with no id are written, so a step run again adds nothing. */
async function fillDailyOwnerIds(db: DB): Promise<void> {
  const people = await peopleIndex(db);
  for (const table of OWNED_DAILY) {
    for (const r of await db.all<{ owner: string }>(`SELECT DISTINCT owner FROM ${table} WHERE owner_id = 0 ORDER BY owner`)) {
      const p = people.get(nameKey(r.owner));
      if (p) await db.run(`UPDATE ${table} SET owner_id = ? WHERE owner = ? AND owner_id = 0 AND day >= ?`, [p.id, r.owner, personFirstDay(p.createdAt)]);
    }
    if (table !== 'failures_daily' && table !== 'skills_daily') await db.run(`UPDATE ${table} SET group_name = '' WHERE owner_id = 0 AND group_name <> ''`);
  }
}

/** `TXT` is text under the byte-order collation; `INT` is a 64-bit integer (times are milliseconds); `REAL` is a double. */
const typed = (sql: string): string => sql.replace(/\bTXT\b/g, 'TEXT COLLATE "C"').replace(/\bINT\b/g, 'BIGINT').replace(/\bREAL\b/g, 'DOUBLE PRECISION');

/** The schema the main stores live in, and the one the Activity history and recordings live in (their own pool and lock). */
export const MAIN_SCHEMA = 'podium';
export const ACTIVITY_SCHEMA = 'podium_activity';

export const MAIN_STEPS: Step[] = [
  {
    version: 1,
    sql: typed(`
CREATE FUNCTION podium_lower(s TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT translate(s, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') $$;
CREATE TABLE sessions (
  id TXT PRIMARY KEY, name TXT NOT NULL, status TXT NOT NULL,
  wait_reason TXT, wait_note TXT, end_reason TXT, resume_id TXT,
  started_at INT NOT NULL, last_seen_at INT NOT NULL, ended_at INT, dropped_at INT,
  cwd TXT NOT NULL, project_root TXT, repo_name TXT, git_json TXT,
  model TXT, effort TXT,
  context_tokens INT, context_window INT, context_percent REAL,
  cost_usd REAL, tok_in INT, tok_out INT, tok_cr INT, tok_cw INT,
  rate_limits_json TXT, blowouts INT NOT NULL DEFAULT 0,
  plan_json TXT, reporter_version TXT, engine_version TXT,
  loop_json TXT, files_json TXT, attached INT, detached_at INT, owner TXT, machine_json TXT, background_json TXT, usage_json TXT,
  cleared_from TXT, reporter_build TXT, plan_kept_json TXT
);
CREATE INDEX sessions_cleared_from ON sessions(cleared_from);
CREATE TABLE agents (
  session_id TXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TXT NOT NULL,
  parent_id TXT, kind TXT NOT NULL, type TXT NOT NULL, name TXT, description TXT NOT NULL,
  model TXT, effort TXT, effort_source TXT, status TXT NOT NULL,
  started_at INT NOT NULL, ended_at INT,
  context_tokens INT, context_window INT, context_percent REAL,
  tok_in INT, tok_out INT, tok_cr INT, tok_cw INT, cost_usd_est REAL,
  skills_json TXT, last_tool TXT, tool_calls INT, blowouts INT NOT NULL DEFAULT 0,
  steps_done INT, steps_total INT, prompt_excerpt TXT, answer_excerpt TXT, failure_json TXT,
  tool_counts_json TXT, usage_json TXT,
  PRIMARY KEY (session_id, id)
);
CREATE TABLE events (
  id TXT PRIMARY KEY, session_id TXT NOT NULL, agent_id TXT, t INT NOT NULL,
  kind TXT NOT NULL, text TXT NOT NULL, data_json TXT
);
CREATE INDEX events_session_t ON events(session_id, t DESC);
CREATE INDEX events_t ON events(t DESC);
CREATE TABLE blowouts (
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, session_id TXT NOT NULL, agent_id TXT, t INT NOT NULL,
  kind TXT NOT NULL, tokens_before INT, tokens_after INT, UNIQUE (session_id, agent_id, t, kind)
);
CREATE TABLE samples (
  session_id TXT NOT NULL, t INT NOT NULL,
  tokens_total INT NOT NULL, tokens_delta INT NOT NULL, peak_context REAL NOT NULL,
  running_agents INT NOT NULL, cost_usd REAL, usage_json TXT, PRIMARY KEY (session_id, t)
);
CREATE TABLE groups (
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TXT NOT NULL, name_lower TXT NOT NULL UNIQUE, created_at INT NOT NULL
);
CREATE TABLE people (
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TXT NOT NULL, name_lower TXT NOT NULL UNIQUE,
  key_id TXT NOT NULL UNIQUE, token_hash TXT NOT NULL,
  group_id INT REFERENCES groups(id) ON DELETE SET NULL,
  created_at INT NOT NULL, rotated_at INT, revoked_at INT, last_report_at INT
);
CREATE TABLE person_machines (
  person_id INT NOT NULL REFERENCES people(id) ON DELETE CASCADE, machine TXT NOT NULL, last_seen_at INT NOT NULL,
  PRIMARY KEY (person_id, machine)
);
CREATE TABLE admin_log (
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, t INT NOT NULL, kind TXT NOT NULL, detail TXT NOT NULL, source TXT NOT NULL, actor TXT
);
CREATE TABLE settings (key TXT PRIMARY KEY, value TXT NOT NULL);
CREATE TABLE agent_texts (
  session_id TXT NOT NULL, agent_id TXT NOT NULL, prompt_text TXT, answer_text TXT,
  PRIMARY KEY (session_id, agent_id)
);
CREATE TABLE reporters (
  key TXT PRIMARY KEY, kind TXT NOT NULL, machine_id TXT, machine_name TXT, source_address TXT,
  owner TXT, credential TXT, reporter_version TXT NOT NULL, engine_version TXT,
  first_seen_at INT NOT NULL, last_seen_at INT NOT NULL, os TXT, peers INT
);
CREATE TABLE reporter_sessions (
  reporter_key TXT NOT NULL REFERENCES reporters(key) ON DELETE CASCADE, session_id TXT NOT NULL, peers INT,
  PRIMARY KEY (reporter_key, session_id)
);
CREATE INDEX reporter_sessions_session ON reporter_sessions(session_id);
CREATE TABLE reporter_ignores (
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, kind TXT NOT NULL, pattern TXT NOT NULL, created_at INT NOT NULL,
  UNIQUE (kind, pattern)
);
CREATE TABLE peer_rights (
  from_key TXT NOT NULL, to_key TXT NOT NULL, owner TXT NOT NULL,
  level TXT NOT NULL, paused INT NOT NULL DEFAULT 0, set_at INT NOT NULL,
  PRIMARY KEY (from_key, to_key)
);
CREATE TABLE peer_owner_settings (
  owner_lower TXT PRIMARY KEY, trust INT NOT NULL DEFAULT 0, on_request TXT NOT NULL DEFAULT 'ask',
  new_send TXT NOT NULL DEFAULT 'ask', limits_json TXT
);
CREATE TABLE peer_requests (
  id TXT PRIMARY KEY, owner TXT NOT NULL, kind TXT NOT NULL, from_key TXT NOT NULL, to_key TXT NOT NULL,
  level TXT, reason TXT, by TXT NOT NULL, from_session TXT, message_id TXT,
  created_at INT NOT NULL, closed_at INT, outcome TXT
);
CREATE INDEX peer_requests_owner ON peer_requests(owner, closed_at);
CREATE TABLE peer_messages (
  id TXT PRIMARY KEY, owner TXT NOT NULL, link TXT NOT NULL, from_key TXT NOT NULL, to_key TXT NOT NULL,
  from_session TXT NOT NULL, to_session TXT NOT NULL, from_name TXT NOT NULL, from_machine TXT NOT NULL,
  to_name TXT NOT NULL, to_machine TXT NOT NULL, text TXT NOT NULL, sent_at INT NOT NULL,
  state TXT NOT NULL, state_at INT NOT NULL, why TXT, approved INT NOT NULL DEFAULT 0, handed INT NOT NULL DEFAULT 0, seq INT
);
CREATE INDEX peer_messages_link ON peer_messages(link, sent_at);
CREATE INDEX peer_messages_to ON peer_messages(to_session, state);
CREATE INDEX peer_messages_from ON peer_messages(from_session);
CREATE INDEX peer_messages_seq ON peer_messages(sent_at, seq);
CREATE TABLE usage_daily (
  day TXT NOT NULL, owner TXT NOT NULL, group_name TXT NOT NULL, model TXT NOT NULL, project TXT NOT NULL,
  sessions INT NOT NULL, agents INT NOT NULL, cost_usd REAL NOT NULL,
  unpriced_sessions INT NOT NULL, tok_in INT NOT NULL, tok_out INT NOT NULL, tok_cr INT NOT NULL, tok_cw INT NOT NULL,
  PRIMARY KEY (day, owner, model, project)
);
CREATE TABLE sessions_daily (
  day TXT NOT NULL, outcome TXT NOT NULL, model TXT NOT NULL, effort TXT NOT NULL, plan TXT NOT NULL,
  sessions INT NOT NULL, duration_s INT NOT NULL, max_duration_s INT NOT NULL, agents INT NOT NULL, blowouts INT NOT NULL, max_context_pct REAL NOT NULL,
  PRIMARY KEY (day, outcome, model, effort, plan)
);
CREATE TABLE failures_daily (
  day TXT NOT NULL, owner TXT NOT NULL, class TXT NOT NULL, tool TXT NOT NULL, count INT NOT NULL,
  PRIMARY KEY (day, owner, class, tool)
);
CREATE TABLE fleet_daily (
  day TXT PRIMARY KEY, active_people INT NOT NULL, active_reporters INT NOT NULL,
  sessions_started INT NOT NULL, peak_live_sessions INT NOT NULL,
  reporter_versions_json TXT NOT NULL, engine_versions_json TXT NOT NULL
);
CREATE TABLE person_certificates (
  fingerprint_sha256 TXT PRIMARY KEY, serial TXT NOT NULL, issuer_fingerprint TXT NOT NULL,
  person_id INT NOT NULL REFERENCES people(id) ON DELETE CASCADE, cert_pem TXT NOT NULL,
  not_before INT NOT NULL, not_after INT NOT NULL, issued_at INT NOT NULL,
  revoked_at INT, reason TXT, seq INT
);
CREATE INDEX person_certificates_person ON person_certificates(person_id);
CREATE INDEX person_certificates_seq ON person_certificates(person_id, seq);
INSERT INTO groups (name, name_lower, created_at) VALUES ('Administrators', 'administrators', (extract(epoch FROM now()) * 1000)::bigint);
`),
  },
  {
    version: 2,
    // An explicit insertion order for open requests (#890), as peer messages have: two made in the same millisecond used to be told apart
    // by their random id. A row that already exists takes its place from its time and then its id, the only order PostgreSQL can still give it.
    sql: typed(`
ALTER TABLE peer_requests ADD COLUMN seq INT;
UPDATE peer_requests r SET seq = o.n FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM peer_requests) o WHERE o.id = r.id;
CREATE INDEX peer_requests_seq ON peer_requests(created_at, seq);
`),
  },
  {
    version: 3,
    // A machine can run more than one reporter (#849): a reporter row names the reporter that sent it, and the key carries the name for any reporter
    // but the Claude Code one. Rows from before this keep their key and become `podium-reporter` rows.
    sql: typed(`ALTER TABLE reporters ADD COLUMN reporter_name TXT NOT NULL DEFAULT 'podium-reporter';`),
  },
  {
    version: 4,
    // The harness that runs a session (#851) and who worked out its cost. Every session stored before this ran under Claude Code, and the cost
    // it has is Podium's own estimate (NULL cost_source), so the default marks existing rows as Claude Code.
    sql: typed(`
ALTER TABLE sessions ADD COLUMN harness TXT NOT NULL DEFAULT 'claude-code';
ALTER TABLE sessions ADD COLUMN cost_source TXT;
`),
  },
  {
    version: 5,
    // What a harness declares (#940): the capabilities it can report, its model's label and its model's provider. NULL means no report has
    // declared it, which is what every session stored before this, and every v1 session, is.
    sql: typed(`
ALTER TABLE sessions ADD COLUMN capabilities_json TXT;
ALTER TABLE sessions ADD COLUMN model_label TXT;
ALTER TABLE sessions ADD COLUMN model_provider TXT;
`),
  },
  {
    version: 6,
    // An agent's model label and provider (#945), as a session has since #940. NULL means no report gave one, which is every agent stored before this.
    sql: typed(`
ALTER TABLE agents ADD COLUMN model_label TXT;
ALTER TABLE agents ADD COLUMN model_provider TXT;
`),
  },
  {
    version: 7,
    // The Chat page (#1034), as SQLite migration 31 makes it. A direct message records who wrote it (every message stored before this was an agent's) and
    // when every agent in its conversation had left (hidden_at). Group and General messages are tables of their own, one per audience, with the same row
    // shape; a direct message is never copied into either. A person's unread and mention counts are kept per thread.
    sql: typed(`
ALTER TABLE peer_messages ADD COLUMN author TXT NOT NULL DEFAULT 'agent';
ALTER TABLE peer_messages ADD COLUMN hidden_at INT;
CREATE INDEX peer_messages_hidden ON peer_messages(hidden_at);
CREATE TABLE group_messages (
  id TXT PRIMARY KEY, owner TXT NOT NULL, group_id TXT NOT NULL, author_kind TXT NOT NULL, author_ref TXT NOT NULL, author_name TXT NOT NULL,
  text TXT NOT NULL, created_at INT NOT NULL, updated_at INT NOT NULL, issue TXT, project TXT, milestone TXT, reply_to TXT,
  mentions_json TXT NOT NULL DEFAULT '[]', seq INT NOT NULL
);
CREATE INDEX group_messages_channel ON group_messages(owner, group_id, created_at, seq);
CREATE INDEX group_messages_created ON group_messages(created_at);
CREATE TABLE public_messages (
  id TXT PRIMARY KEY, author_kind TXT NOT NULL, author_ref TXT NOT NULL, author_name TXT NOT NULL,
  text TXT NOT NULL, created_at INT NOT NULL, updated_at INT NOT NULL, issue TXT, project TXT, milestone TXT, reply_to TXT,
  mentions_json TXT NOT NULL DEFAULT '[]', seq INT NOT NULL
);
CREATE INDEX public_messages_channel ON public_messages(created_at, seq);
CREATE TABLE chat_read_state (
  person TXT NOT NULL, thread TXT NOT NULL, last_read TXT, unread INT NOT NULL DEFAULT 0, mentions INT NOT NULL DEFAULT 0,
  updated_at INT NOT NULL, PRIMARY KEY (person, thread)
);
CREATE INDEX chat_read_state_thread ON chat_read_state(thread);
`),
  },
  {
    version: 8,
    // Who paused a person's link to another person's agent (#1034), as SQLite migration 32 keeps it. NULL means not paused, or paused before this was kept.
    sql: typed(`ALTER TABLE peer_rights ADD COLUMN paused_by TXT;`),
  },
  {
    version: 9,
    // An Admin reading a person's group or a Direct Message (#1034), as SQLite migration 33 keeps it: one record per reading session, who and when, never any text.
    // The Admin who paused a link is named with the pause (paused_by_admin), so the owner knows whom to ask.
    sql: typed(`
ALTER TABLE peer_rights ADD COLUMN paused_by_admin TXT;
CREATE TABLE chat_admin_reads (
  thread TXT NOT NULL, admin_key TXT NOT NULL, admin TXT NOT NULL, started_at INT NOT NULL, last_seen_at INT NOT NULL,
  PRIMARY KEY (thread, admin_key, started_at)
);
CREATE INDEX chat_admin_reads_seen ON chat_admin_reads(last_seen_at);
`),
  },
  {
    version: 10,
    // What an Admin record says (#1034), as SQLite migration 34 keeps it: a reading (every record before this one), or one of the Admin's stops that stay on
    // the record for good: removed all messages, paused, resumed.
    sql: typed(`ALTER TABLE chat_admin_reads ADD COLUMN kind TXT NOT NULL DEFAULT 'read';`),
  },
  {
    version: 11,
    // An Admin record is kept until the person has seen it (#1051), as SQLite migration 35 keeps it: who it is owed to (`people`) and who has seen it (`seen`),
    // each a JSON list of folded names. The rows already there owe nothing, so retention treats them as before.
    sql: typed(`
ALTER TABLE chat_admin_reads ADD COLUMN people TXT NOT NULL DEFAULT '[]';
ALTER TABLE chat_admin_reads ADD COLUMN seen TXT NOT NULL DEFAULT '[]';
`),
  },
  {
    version: 12,
    // The days the harness lets a person resume a session once it is closed (#1113), as SQLite migration 36 keeps it. NULL means no report has said: the default of 30 days applies.
    sql: typed('ALTER TABLE sessions ADD COLUMN resume_window_days INT;'),
  },
  {
    version: 13,
    // The tool counts behind Admin > Reporting > Tools (#720), as SQLite migration 37 keeps them: names and counts only, per harness.
    sql: typed(`
CREATE TABLE tools_daily (
  day TXT NOT NULL, harness TXT NOT NULL, tool TXT NOT NULL, calls INT NOT NULL,
  PRIMARY KEY (day, harness, tool)
);
CREATE TABLE tool_sessions_daily (
  day TXT NOT NULL, harness TXT NOT NULL, bucket INT NOT NULL, sessions INT NOT NULL,
  PRIMARY KEY (day, harness, bucket)
);
CREATE TABLE harness_versions_daily (
  day TXT NOT NULL, harness TXT NOT NULL, version TXT NOT NULL, reporters INT NOT NULL,
  PRIMARY KEY (day, harness, version)
);
`),
  },
  {
    version: 14,
    // What each tool did beyond being called (#721), as SQLite migration 38 keeps it: the agent's per-tool stats as JSON, and the day's totals per harness and tool.
    sql: typed(`
ALTER TABLE agents ADD COLUMN tool_stats_json TXT;
CREATE TABLE tool_stats_daily (
  day TXT NOT NULL, harness TXT NOT NULL, tool TXT NOT NULL,
  failed INT NOT NULL, asked INT NOT NULL, allowed INT NOT NULL, denied INT NOT NULL, podium INT NOT NULL, times_json TXT NOT NULL,
  PRIMARY KEY (day, harness, tool)
);
`),
  },
  {
    version: 15,
    // How long sessions ran and waited on their person, which agents they launched, who ran them and when they overlapped (#722), as SQLite migration 39 keeps them:
    // names, counts and times only. `session_waits` goes with its session.
    sql: typed(`
CREATE TABLE session_waits (
  session_id TXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  permission_ms INT NOT NULL, permission_n INT NOT NULL, question_ms INT NOT NULL, question_n INT NOT NULL, plan_ms INT NOT NULL, plan_n INT NOT NULL,
  tracked_since INT NOT NULL, open_kind TXT, open_since INT
);
CREATE TABLE session_time_daily (
  day TXT NOT NULL, harness TXT NOT NULL, sessions INT NOT NULL, duration_s INT NOT NULL, max_duration_s INT NOT NULL,
  tracked_sessions INT NOT NULL, tracked_s INT NOT NULL,
  permission_s INT NOT NULL, permission_n INT NOT NULL, question_s INT NOT NULL, question_n INT NOT NULL, plan_s INT NOT NULL, plan_n INT NOT NULL,
  PRIMARY KEY (day, harness)
);
CREATE TABLE agents_daily (
  day TXT NOT NULL, harness TXT NOT NULL, type TXT NOT NULL, depth INT NOT NULL, agents INT NOT NULL,
  PRIMARY KEY (day, harness, type, depth)
);
CREATE TABLE person_sessions_daily (
  day TXT NOT NULL, owner TXT NOT NULL, group_name TXT NOT NULL, harness TXT NOT NULL, sessions INT NOT NULL,
  PRIMARY KEY (day, owner, harness)
);
CREATE TABLE hour_peaks_daily (
  day TXT NOT NULL, harness TXT NOT NULL, hour INT NOT NULL, peak INT NOT NULL,
  PRIMARY KEY (day, harness, hour)
);
`),
  },
  {
    version: 16,
    // What sessions cost and how they ended (#723), as SQLite migration 40 keeps it: counts, tokens and names only.
    sql: typed(`
CREATE TABLE cost_daily (
  day TXT NOT NULL, harness TXT NOT NULL, model TXT NOT NULL, effort TXT NOT NULL,
  sessions INT NOT NULL, priced_sessions INT NOT NULL, calls INT NOT NULL, priced_calls INT NOT NULL, cost_usd REAL NOT NULL, call_cost_usd REAL NOT NULL,
  tok_in INT NOT NULL, tok_out INT NOT NULL, tok_cr INT NOT NULL, tok_cw INT NOT NULL,
  ended_low INT NOT NULL, ended_mid INT NOT NULL, ended_high INT NOT NULL, ended_unknown INT NOT NULL,
  compacted INT NOT NULL, cleared INT NOT NULL,
  PRIMARY KEY (day, harness, model, effort)
);
CREATE TABLE tool_cost_daily (
  day TXT NOT NULL, harness TXT NOT NULL, tool TXT NOT NULL,
  sessions INT NOT NULL, priced_sessions INT NOT NULL, cost_usd REAL NOT NULL, calls INT NOT NULL,
  PRIMARY KEY (day, harness, tool)
);
`),
  },
  {
    version: 17,
    // What each version of a harness sent (#724), as SQLite migration 41 keeps it: names and counts only.
    sql: typed(`
ALTER TABLE sessions ADD COLUMN signals_json TXT;
CREATE TABLE feature_versions_daily (
  day TXT NOT NULL, harness TXT NOT NULL, version TXT NOT NULL, feature TXT NOT NULL, sessions INT NOT NULL,
  PRIMARY KEY (day, harness, version, feature)
);
CREATE TABLE skills_daily (
  day TXT NOT NULL, owner TXT NOT NULL, harness TXT NOT NULL, skill TXT NOT NULL, sessions INT NOT NULL,
  PRIMARY KEY (day, owner, harness, skill)
);
CREATE TABLE person_places_daily (
  day TXT NOT NULL, owner TXT NOT NULL, group_name TXT NOT NULL, harness TXT NOT NULL, project TXT NOT NULL, branch TXT NOT NULL, sessions INT NOT NULL,
  PRIMARY KEY (day, owner, harness, project, branch)
);
`),
  },
  {
    version: 18,
    // How often sessions were answered from Podium and how long they had waited (#725), as SQLite migration 42 keeps it: kinds, days and wait classes only.
    sql: typed(`
CREATE TABLE answers_daily (
  day TXT NOT NULL, harness TXT NOT NULL, kind TXT NOT NULL, bucket INT NOT NULL, count INT NOT NULL,
  PRIMARY KEY (day, harness, kind, bucket)
);
`),
  },
  {
    version: 19,
    // An index on the sample time (#755), as SQLite migration 43 keeps it: the fleet-wide token and cost queries and the retention delete read by time alone.
    sql: 'CREATE INDEX samples_t ON samples(t);',
  },
  {
    version: 20,
    // Who an Admin record is still owed to (#1061), as SQLite migration 44 keeps it: one row per person and record while the person has not seen it, so a person's
    // unseen records are read by the person and not found by parsing the lists of every record. The store fills it once from the records already there.
    sql: typed(`
CREATE TABLE chat_admin_owed (
  person_key TXT NOT NULL, thread TXT NOT NULL, admin_key TXT NOT NULL, started_at INT NOT NULL,
  PRIMARY KEY (person_key, thread, admin_key, started_at)
);
CREATE INDEX chat_admin_owed_record ON chat_admin_owed(thread, admin_key, started_at);
`),
  },
  {
    version: 21,
    // Public channels beside General (#1035), as SQLite migration 45 keeps them: a channel key on `public_messages` (every message already there is General's) and the
    // list of the other channels, with one channel per link through a unique key over the folded `<kind>:<reference>` (NULL when there is no link).
    sql: typed(`
ALTER TABLE public_messages ADD COLUMN channel TXT NOT NULL DEFAULT 'general';
CREATE INDEX public_messages_in_channel ON public_messages(channel, created_at, seq);
CREATE TABLE public_channels (
  name TXT PRIMARY KEY, description TXT NOT NULL DEFAULT '', link_kind TXT, link_ref TXT, link_key TXT UNIQUE,
  created_by TXT NOT NULL, created_by_name TXT NOT NULL, created_at INT NOT NULL, updated_at INT NOT NULL
);
`),
  },
  {
    version: 22,
    // A person edits or deletes their own Chat message (#1269), as SQLite migration 46 keeps it: when the text last changed and when the author deleted it, NULL for every
    // message already there, on the two channel tables and on `peer_messages` (so a direct message needs no later step). `author_id` is the writer's `people.id`, with no foreign key
    // (a message kept after its person is deleted names nobody); `fillAuthorIds` gives the ones that exist their author's id, in the same transaction.
    sql: typed(`
ALTER TABLE group_messages ADD COLUMN edited_at INT;
ALTER TABLE group_messages ADD COLUMN deleted_at INT;
ALTER TABLE group_messages ADD COLUMN author_id INT;
ALTER TABLE public_messages ADD COLUMN edited_at INT;
ALTER TABLE public_messages ADD COLUMN deleted_at INT;
ALTER TABLE public_messages ADD COLUMN author_id INT;
ALTER TABLE peer_messages ADD COLUMN edited_at INT;
ALTER TABLE peer_messages ADD COLUMN deleted_at INT;
ALTER TABLE peer_messages ADD COLUMN author_id INT;
`),
    after: fillAuthorIds,
  },
  {
    version: 23,
    // The conversations of people and agents (#1278, DECISIONS 74), as SQLite migration 47 keeps them: `conversations` with `members_key` (a hash of who is in it now, an index and not a
    // unique key), `conversation_members` and `conversation_messages`, a fourth audience beside the channels and `peer_messages` and never merged with them.
    sql: typed(`
CREATE TABLE conversations (id TXT PRIMARY KEY, created_by INT, created_at INT NOT NULL, members_key TXT NOT NULL);
CREATE INDEX conversations_members ON conversations(members_key);
CREATE TABLE conversation_members (
  conversation_id TXT NOT NULL, member_kind TXT NOT NULL, member_ref TXT NOT NULL, member_name TXT NOT NULL, added_by INT, joined_at INT NOT NULL, left_at INT,
  PRIMARY KEY (conversation_id, member_kind, member_ref)
);
CREATE INDEX conversation_members_ref ON conversation_members(member_kind, member_ref);
CREATE TABLE conversation_messages (
  id TXT PRIMARY KEY, conversation_id TXT NOT NULL, author_kind TXT NOT NULL, author_ref TXT NOT NULL, author_name TXT NOT NULL, author_id INT, text TXT NOT NULL,
  created_at INT NOT NULL, updated_at INT NOT NULL, reply_to TXT, seq INT NOT NULL, edited_at INT, deleted_at INT, handed_at INT
);
CREATE INDEX conversation_messages_page ON conversation_messages(conversation_id, created_at, seq);
CREATE INDEX conversation_messages_created ON conversation_messages(created_at);
`),
  },
  {
    version: 24,
    // Every agent has an id the server gives it, never reused (#1284), as SQLite migration 48 keeps it: an identity key that is never handed out twice, one row per session id, and the
    // agent each direct message was written by and aimed at (NULL for a person's end). `fillAgentIds` gives the sessions that exist ids, oldest first, and the messages those of their sessions.
    sql: typed(`
CREATE TABLE agent_ids (id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, session_id TXT NOT NULL UNIQUE);
ALTER TABLE peer_messages ADD COLUMN from_agent INT;
ALTER TABLE peer_messages ADD COLUMN to_agent INT;
`),
    after: fillAgentIds,
  },
  {
    version: 25,
    // A session and a reporter belong to a person by id, never by name (#1284), as SQLite migration 49 keeps it: `owner_id` is `people.id` (no foreign key), NULL for the admin secret's rows and
    // for a row whose owner matches no person. `fillOwnerIds` gives the others their person's id.
    sql: typed(`
ALTER TABLE sessions ADD COLUMN owner_id INT;
ALTER TABLE reporters ADD COLUMN owner_id INT;
`),
    after: fillOwnerIds,
  },
  {
    version: 26,
    // The peer-messaging tables belong to a person by id, never by name (#1284), as SQLite migration 50 keeps it: `owner_id` is `people.id` on the rights, requests and messages (NULL for a row whose owner
    // matches no person), and the owner defaults are found by it. `fillPeerOwnerIds` gives the others their person's id, rewrites a person's end of a link to `person:<id>`, and rekeys the defaults.
    sql: typed(`
ALTER TABLE peer_rights ADD COLUMN owner_id INT;
ALTER TABLE peer_requests ADD COLUMN owner_id INT;
ALTER TABLE peer_messages ADD COLUMN owner_id INT;
ALTER TABLE peer_owner_settings ADD COLUMN owner_id INT;
CREATE INDEX peer_owner_settings_owner_id ON peer_owner_settings(owner_id);
`),
    after: fillPeerOwnerIds,
  },
  {
    version: 27,
    // Chat belongs to a person by id, never by name (#1284), as SQLite migration 51 keeps it: `group_messages.owner_id`, `person_id` on the read counts and on what an Admin record is owed (the older
    // name key beside it now holds `#<id>`), and `public_channels.created_by_id`, all with no foreign key and NULL where the name matched no person. `fillChatPersonIds` gives the rest their person's id.
    sql: typed(`
ALTER TABLE group_messages ADD COLUMN owner_id INT;
CREATE INDEX group_messages_owner ON group_messages(owner_id, created_at, seq);
ALTER TABLE chat_read_state ADD COLUMN person_id INT;
CREATE INDEX chat_read_state_person ON chat_read_state(person_id, thread);
ALTER TABLE chat_admin_owed ADD COLUMN person_id INT;
CREATE INDEX chat_admin_owed_person ON chat_admin_owed(person_id, thread);
ALTER TABLE public_channels ADD COLUMN created_by_id INT;
`),
    after: fillChatPersonIds,
  },
  {
    version: 28,
    // The daily rows that name a person are bound to the person by id (#1284), as SQLite migration 52 keeps it: `owner_id` is `people.id` (no foreign key), 0 is no person, and a row's key gains it so a
    // person deleted and a newcomer who takes the name keep apart their rows of one day. `fillDailyOwnerIds` gives the rows of people that exist their id and takes the group off the others.
    sql: typed(`
ALTER TABLE usage_daily ADD COLUMN owner_id INT NOT NULL DEFAULT 0;
ALTER TABLE usage_daily DROP CONSTRAINT usage_daily_pkey, ADD PRIMARY KEY (day, owner_id, owner, model, project);
ALTER TABLE failures_daily ADD COLUMN owner_id INT NOT NULL DEFAULT 0;
ALTER TABLE failures_daily DROP CONSTRAINT failures_daily_pkey, ADD PRIMARY KEY (day, owner_id, owner, class, tool);
ALTER TABLE person_sessions_daily ADD COLUMN owner_id INT NOT NULL DEFAULT 0;
ALTER TABLE person_sessions_daily DROP CONSTRAINT person_sessions_daily_pkey, ADD PRIMARY KEY (day, owner_id, owner, harness);
ALTER TABLE skills_daily ADD COLUMN owner_id INT NOT NULL DEFAULT 0;
ALTER TABLE skills_daily DROP CONSTRAINT skills_daily_pkey, ADD PRIMARY KEY (day, owner_id, owner, harness, skill);
ALTER TABLE person_places_daily ADD COLUMN owner_id INT NOT NULL DEFAULT 0;
ALTER TABLE person_places_daily DROP CONSTRAINT person_places_daily_pkey, ADD PRIMARY KEY (day, owner_id, owner, harness, project, branch);
`),
    after: fillDailyOwnerIds,
  },
  {
    version: 29,
    // Who a message of a conversation was for, and what became of it (#1282), as SQLite migration 53 keeps it: one row per member a message went to or named; `named` is 1 for a member the writer
    // addressed with an @; `state` is an agent's `queued`, `delivered` or `dropped` and NULL for a person. A message with no row was sent to everyone and keeps no delivery line.
    sql: typed(`
CREATE TABLE conversation_deliveries (
  conversation_id TXT NOT NULL, message_id TXT NOT NULL, member_kind TXT NOT NULL, member_ref TXT NOT NULL, member_name TXT NOT NULL, named INT NOT NULL, state TXT, state_at INT,
  PRIMARY KEY (conversation_id, message_id, member_kind, member_ref)
);
`),
  },
];

export const ACTIVITY_STEPS: Step[] = [
  {
    version: 1,
    sql: typed(`
CREATE TABLE entries (
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TXT NOT NULL, loop TXT NOT NULL, seq INT NOT NULL, at INT NOT NULL, t INT NOT NULL,
  kind TXT NOT NULL, text TXT NOT NULL, "by" TXT, note TXT, ref TXT, command TXT, command_cut INT
);
CREATE UNIQUE INDEX entries_loop_seq ON entries (session_id, loop, seq);
CREATE INDEX entries_t ON entries (t);
CREATE INDEX entries_ref ON entries (session_id, ref) WHERE ref IS NOT NULL;
CREATE INDEX entries_session_t ON entries (session_id, t, loop);
CREATE TABLE stored_sessions (
  session_id TXT PRIMARY KEY, name TXT NOT NULL, project TXT, owner TXT,
  first_t INT NOT NULL, last_t INT NOT NULL,
  entries INT NOT NULL DEFAULT 0, bytes INT NOT NULL DEFAULT 0, oldest_t INT
);
CREATE TABLE loops (
  session_id TXT NOT NULL, loop TXT NOT NULL, entries INT NOT NULL, first_at INT, last_t INT,
  PRIMARY KEY (session_id, loop)
);
CREATE TABLE rec_sessions (
  session_id TXT PRIMARY KEY, name TXT NOT NULL, project TXT, owner TXT, state TXT NOT NULL, limit_kind TXT, loops TXT NOT NULL,
  started_by TXT, started_at INT, stopped_by TXT, stopped_at INT,
  entries INT NOT NULL DEFAULT 0, bytes INT NOT NULL DEFAULT 0, oldest_t INT, last_t INT
);
CREATE TABLE rec_entries (
  n INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TXT NOT NULL, loop TXT NOT NULL, seq INT NOT NULL, at INT NOT NULL, t INT NOT NULL,
  kind TXT NOT NULL, text TXT NOT NULL, name TXT, call_seq INT, failed INT, cut INT, lost INT, "by" TXT, b INT NOT NULL
);
CREATE UNIQUE INDEX rec_entries_loop_seq ON rec_entries (session_id, loop, seq);
CREATE INDEX rec_entries_session_n ON rec_entries (session_id, n);
CREATE INDEX rec_entries_t ON rec_entries (t);
`),
  },
];

/** Creates `schema` if it is missing, then applies each step above the stored version, one transaction each. Returns the version it ends on. */
export async function migrate(db: PgDb, schema: string, steps: readonly Step[]): Promise<number> {
  await db.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await db.exec(`CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (version BIGINT PRIMARY KEY, applied_at BIGINT NOT NULL)`);
  const have = new Set((await db.all<{ version: number }>(`SELECT version FROM ${schema}.schema_migrations`)).map((r) => r.version));
  let version = Math.max(0, ...have);
  for (const step of steps) {
    if (have.has(step.version)) continue;
    await db.tx(async () => {
      await db.exec(step.sql);
      await step.after?.(db);
      await db.run(`INSERT INTO ${schema}.schema_migrations (version, applied_at) VALUES (?, ?)`, [step.version, Date.now()]);
    });
    version = Math.max(version, step.version);
  }
  return version;
}
