// The PostgreSQL schema (#822): the end state of the SQLite adapter's 25 migrations and 5 Activity steps, as one baseline each. A later
// change is a step added to the list, with the next version number, and never an edit to an earlier step.
//
// One text rule: every text column is `COLLATE "C"`, so bytes compare as they are and an index or a unique key behaves as it does on
// SQLite, whatever locale the database was created with. Case-insensitive keys are stored folded (`name_lower`) or folded with
// `podium_lower`, which folds ASCII letters only, as SQLite's `lower()` does.
import { PgDb } from './conn.js';

export interface Step { version: number; sql: string }

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
      await db.run(`INSERT INTO ${schema}.schema_migrations (version, applied_at) VALUES (?, ?)`, [step.version, Date.now()]);
    });
    version = Math.max(version, step.version);
  }
  return version;
}
