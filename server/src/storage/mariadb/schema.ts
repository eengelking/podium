// The MariaDB schema (#823): the same steps as the PostgreSQL adapter's, so a database at step 1 holds what the upgrade cases load and
// the later steps run on rows that exist. A later change is a step added to the list, with the next version number, and never an edit
// to an earlier step.
//
// Text: every text column is utf8mb4 under `utf8mb4_nopad_bin`, so bytes compare as they are, `Ed` and `ed` are two names, emoji are
// kept, and a trailing space counts, as on SQLite. A column that is a key or in an index is a VARCHAR with a length (MariaDB indexes at
// most 3072 bytes, 4 per character); the others are LONGTEXT. Case-insensitive keys are stored folded (`name_lower`) or folded in the
// query with `asciiLower`, which folds ASCII letters only, as SQLite's `lower()` does.
//
// DDL commits on its own in MariaDB, so a step is not one transaction. Each statement is written to be run again (`IF NOT EXISTS`, an
// insert that skips a row that is there), and the version row is written after a step's last statement, so a runner that stops part way
// through a step does the whole step again at the next start, and ends in the same state.
import { COLLATION, type MariaDbConn } from './conn.js';

export interface Step { version: number; statements: string[] }

/** `TXT` is long text; `K(n)` is text of at most n characters that can be a key; `INT` is a 64-bit integer (times are milliseconds); `REAL` a double. */
const typed = (sql: string): string =>
  sql
    .replace(/\bTXT\b/g, `LONGTEXT CHARACTER SET utf8mb4 COLLATE ${COLLATION}`)
    .replace(/\bK\((\d+)\)/g, `VARCHAR($1) CHARACTER SET utf8mb4 COLLATE ${COLLATION}`)
    .replace(/\bINT\b/g, 'BIGINT')
    .replace(/\bREAL\b/g, 'DOUBLE')
    .replace(/\bAUTO_ID\b/g, 'BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY')
    .replace(/\)\s*TABLE_OPTIONS/g, `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=${COLLATION}`);

/** The statements of a script, one per `;` at a line end, each typed. */
const steps = (sql: string): string[] => typed(sql).split(/;\s*\n/).map((s) => s.trim().replace(/;$/, '')).filter(Boolean);

/** The table that records the main steps, and the one that records the Activity steps. The Activity tables share the database (their names do not overlap the main ones). */
export const MAIN_MIGRATIONS = 'schema_migrations';
export const ACTIVITY_MIGRATIONS = 'activity_schema_migrations';

/** Index names MariaDB makes for a constraint: the primary key, a `uq_` unique key and a `fk_` foreign key. The schema guard leaves them out, as the other adapters' constraint indexes are. */
export const CONSTRAINT_INDEX = /^(PRIMARY|uq_.*|fk_.*)$/;

const ID = 'K(255)';
const REPORTER_KEY = 'K(383)';

export const MAIN_STEPS: Step[] = [
  {
    version: 1,
    statements: steps(`
CREATE TABLE IF NOT EXISTS sessions (
  id ${ID} PRIMARY KEY, name TXT NOT NULL, status TXT NOT NULL,
  wait_reason TXT, wait_note TXT, end_reason TXT, resume_id TXT,
  started_at INT NOT NULL, last_seen_at INT NOT NULL, ended_at INT, dropped_at INT,
  cwd TXT NOT NULL, project_root TXT, repo_name TXT, git_json TXT,
  model TXT, effort TXT,
  context_tokens INT, context_window INT, context_percent REAL,
  cost_usd REAL, tok_in INT, tok_out INT, tok_cr INT, tok_cw INT,
  rate_limits_json TXT, blowouts INT NOT NULL DEFAULT 0,
  plan_json TXT, reporter_version TXT, engine_version TXT,
  loop_json TXT, files_json TXT, attached INT, detached_at INT, owner TXT, machine_json TXT, background_json TXT, usage_json TXT,
  cleared_from ${ID}, reporter_build TXT, plan_kept_json TXT
) TABLE_OPTIONS;
CREATE INDEX IF NOT EXISTS sessions_cleared_from ON sessions(cleared_from);
CREATE TABLE IF NOT EXISTS agents (
  session_id ${ID} NOT NULL, id ${ID} NOT NULL,
  parent_id TXT, kind TXT NOT NULL, type TXT NOT NULL, name TXT, description TXT NOT NULL,
  model TXT, effort TXT, effort_source TXT, status TXT NOT NULL,
  started_at INT NOT NULL, ended_at INT,
  context_tokens INT, context_window INT, context_percent REAL,
  tok_in INT, tok_out INT, tok_cr INT, tok_cw INT, cost_usd_est REAL,
  skills_json TXT, last_tool TXT, tool_calls INT, blowouts INT NOT NULL DEFAULT 0,
  steps_done INT, steps_total INT, prompt_excerpt TXT, answer_excerpt TXT, failure_json TXT,
  tool_counts_json TXT, usage_json TXT,
  PRIMARY KEY (session_id, id),
  CONSTRAINT fk_agents_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS events (
  id ${ID} PRIMARY KEY, session_id ${ID} NOT NULL, agent_id TXT, t INT NOT NULL,
  kind TXT NOT NULL, text TXT NOT NULL, data_json TXT
) TABLE_OPTIONS;
CREATE INDEX IF NOT EXISTS events_session_t ON events(session_id, t DESC);
CREATE INDEX IF NOT EXISTS events_t ON events(t DESC);
CREATE TABLE IF NOT EXISTS blowouts (
  id AUTO_ID, session_id ${ID} NOT NULL, agent_id ${ID}, t INT NOT NULL,
  kind K(64) NOT NULL, tokens_before INT, tokens_after INT, CONSTRAINT uq_blowouts UNIQUE (session_id, agent_id, t, kind)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS samples (
  session_id ${ID} NOT NULL, t INT NOT NULL,
  tokens_total INT NOT NULL, tokens_delta INT NOT NULL, peak_context REAL NOT NULL,
  running_agents INT NOT NULL, cost_usd REAL, usage_json TXT, PRIMARY KEY (session_id, t)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS "groups" (
  id AUTO_ID, name TXT NOT NULL, name_lower K(255) NOT NULL, created_at INT NOT NULL, CONSTRAINT uq_groups_name UNIQUE (name_lower)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS people (
  id AUTO_ID, name TXT NOT NULL, name_lower K(255) NOT NULL,
  key_id K(255) NOT NULL, token_hash TXT NOT NULL,
  group_id INT,
  created_at INT NOT NULL, rotated_at INT, revoked_at INT, last_report_at INT,
  CONSTRAINT uq_people_name UNIQUE (name_lower), CONSTRAINT uq_people_key UNIQUE (key_id),
  CONSTRAINT fk_people_group FOREIGN KEY (group_id) REFERENCES "groups"(id) ON DELETE SET NULL
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS person_machines (
  person_id INT NOT NULL, machine K(255) NOT NULL, last_seen_at INT NOT NULL,
  PRIMARY KEY (person_id, machine),
  CONSTRAINT fk_person_machines_person FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS admin_log (
  id AUTO_ID, t INT NOT NULL, kind TXT NOT NULL, detail TXT NOT NULL, source TXT NOT NULL, actor TXT
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS settings ("key" K(255) PRIMARY KEY, value TXT NOT NULL) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS agent_texts (
  session_id ${ID} NOT NULL, agent_id ${ID} NOT NULL, prompt_text TXT, answer_text TXT,
  PRIMARY KEY (session_id, agent_id)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS reporters (
  "key" ${REPORTER_KEY} PRIMARY KEY, kind TXT NOT NULL, machine_id TXT, machine_name TXT, source_address TXT,
  owner TXT, credential TXT, reporter_version TXT NOT NULL, engine_version TXT,
  first_seen_at INT NOT NULL, last_seen_at INT NOT NULL, os TXT, peers INT
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS reporter_sessions (
  reporter_key ${REPORTER_KEY} NOT NULL, session_id ${ID} NOT NULL, peers INT,
  PRIMARY KEY (reporter_key, session_id),
  CONSTRAINT fk_reporter_sessions_reporter FOREIGN KEY (reporter_key) REFERENCES reporters("key") ON DELETE CASCADE
) TABLE_OPTIONS;
CREATE INDEX IF NOT EXISTS reporter_sessions_session ON reporter_sessions(session_id);
CREATE TABLE IF NOT EXISTS reporter_ignores (
  id AUTO_ID, kind K(64) NOT NULL, pattern K(255) NOT NULL, created_at INT NOT NULL,
  CONSTRAINT uq_reporter_ignores UNIQUE (kind, pattern)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS peer_rights (
  from_key ${REPORTER_KEY} NOT NULL, to_key ${REPORTER_KEY} NOT NULL, owner TXT NOT NULL,
  level TXT NOT NULL, paused INT NOT NULL DEFAULT 0, set_at INT NOT NULL,
  PRIMARY KEY (from_key, to_key)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS peer_owner_settings (
  owner_lower K(255) PRIMARY KEY, trust INT NOT NULL DEFAULT 0, on_request TXT NOT NULL DEFAULT 'ask',
  new_send TXT NOT NULL DEFAULT 'ask', limits_json TXT
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS peer_requests (
  id ${ID} PRIMARY KEY, owner K(255) NOT NULL, kind TXT NOT NULL, from_key TXT NOT NULL, to_key TXT NOT NULL,
  level TXT, reason TXT, "by" TXT NOT NULL, from_session TXT, message_id TXT,
  created_at INT NOT NULL, closed_at INT, outcome TXT
) TABLE_OPTIONS;
CREATE INDEX IF NOT EXISTS peer_requests_owner ON peer_requests(owner, closed_at);
CREATE TABLE IF NOT EXISTS peer_messages (
  id ${ID} PRIMARY KEY, owner TXT NOT NULL, link K(760) NOT NULL, from_key TXT NOT NULL, to_key TXT NOT NULL,
  from_session ${ID} NOT NULL, to_session ${ID} NOT NULL, from_name TXT NOT NULL, from_machine TXT NOT NULL,
  to_name TXT NOT NULL, to_machine TXT NOT NULL, text TXT NOT NULL, sent_at INT NOT NULL,
  state K(64) NOT NULL, state_at INT NOT NULL, why TXT, approved INT NOT NULL DEFAULT 0, handed INT NOT NULL DEFAULT 0, seq INT
) TABLE_OPTIONS;
CREATE INDEX IF NOT EXISTS peer_messages_link ON peer_messages(link, sent_at);
CREATE INDEX IF NOT EXISTS peer_messages_to ON peer_messages(to_session, state);
CREATE INDEX IF NOT EXISTS peer_messages_from ON peer_messages(from_session);
CREATE INDEX IF NOT EXISTS peer_messages_seq ON peer_messages(sent_at, seq);
CREATE TABLE IF NOT EXISTS usage_daily (
  day K(32) NOT NULL, owner K(128) NOT NULL, group_name TXT NOT NULL, model K(191) NOT NULL, project K(255) NOT NULL,
  sessions INT NOT NULL, agents INT NOT NULL, cost_usd REAL NOT NULL,
  unpriced_sessions INT NOT NULL, tok_in INT NOT NULL, tok_out INT NOT NULL, tok_cr INT NOT NULL, tok_cw INT NOT NULL,
  PRIMARY KEY (day, owner, model, project)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS sessions_daily (
  day K(32) NOT NULL, outcome K(64) NOT NULL, model K(191) NOT NULL, effort K(64) NOT NULL, plan K(64) NOT NULL,
  sessions INT NOT NULL, duration_s INT NOT NULL, max_duration_s INT NOT NULL, agents INT NOT NULL, blowouts INT NOT NULL, max_context_pct REAL NOT NULL,
  PRIMARY KEY (day, outcome, model, effort, plan)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS failures_daily (
  day K(32) NOT NULL, owner K(128) NOT NULL, class K(64) NOT NULL, tool K(255) NOT NULL, count INT NOT NULL,
  PRIMARY KEY (day, owner, class, tool)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS fleet_daily (
  day K(32) PRIMARY KEY, active_people INT NOT NULL, active_reporters INT NOT NULL,
  sessions_started INT NOT NULL, peak_live_sessions INT NOT NULL,
  reporter_versions_json TXT NOT NULL, engine_versions_json TXT NOT NULL
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS person_certificates (
  fingerprint_sha256 K(191) PRIMARY KEY, serial TXT NOT NULL, issuer_fingerprint TXT NOT NULL,
  person_id INT NOT NULL, cert_pem TXT NOT NULL,
  not_before INT NOT NULL, not_after INT NOT NULL, issued_at INT NOT NULL,
  revoked_at INT, reason TXT, seq INT,
  CONSTRAINT fk_person_certificates_person FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
) TABLE_OPTIONS;
CREATE INDEX IF NOT EXISTS person_certificates_person ON person_certificates(person_id);
CREATE INDEX IF NOT EXISTS person_certificates_seq ON person_certificates(person_id, seq);
INSERT INTO "groups" (name, name_lower, created_at) SELECT 'Administrators', 'administrators', CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS SIGNED) FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM "groups" WHERE name_lower = 'administrators');
`),
  },
  {
    version: 2,
    // An explicit insertion order for open requests (#890), as peer messages have. A row that already exists takes its place from its time
    // and then its id, as the other adapters number it. Run again, the numbering comes out the same.
    statements: steps(`
ALTER TABLE peer_requests ADD COLUMN IF NOT EXISTS seq INT;
UPDATE peer_requests r JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS n FROM peer_requests) o ON o.id = r.id SET r.seq = o.n;
CREATE INDEX IF NOT EXISTS peer_requests_seq ON peer_requests(created_at, seq);
`),
  },
  {
    version: 3,
    // A machine can run more than one reporter (#849). Rows from before this keep their key and become `podium-reporter` rows.
    statements: steps(`ALTER TABLE reporters ADD COLUMN IF NOT EXISTS reporter_name TXT NOT NULL DEFAULT 'podium-reporter';`),
  },
  {
    version: 4,
    // The harness that runs a session (#851) and who worked out its cost. Every session stored before this ran under Claude Code.
    statements: steps(`
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS harness TXT NOT NULL DEFAULT 'claude-code';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cost_source TXT;
`),
  },
  {
    version: 5,
    // What a harness declares (#940). NULL means no report has declared it.
    statements: steps(`
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS capabilities_json TXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model_label TXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model_provider TXT;
`),
  },
  {
    version: 6,
    // An agent's model label and provider (#945).
    statements: steps(`
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_label TXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_provider TXT;
`),
  },
  {
    version: 7,
    // The Chat page (#1034), as SQLite migration 31 and PostgreSQL step 7 make it.
    statements: steps(`
ALTER TABLE peer_messages ADD COLUMN IF NOT EXISTS author TXT NOT NULL DEFAULT 'agent';
ALTER TABLE peer_messages ADD COLUMN IF NOT EXISTS hidden_at INT;
CREATE INDEX IF NOT EXISTS peer_messages_hidden ON peer_messages(hidden_at);
CREATE TABLE IF NOT EXISTS group_messages (
  id ${ID} PRIMARY KEY, owner K(255) NOT NULL, group_id K(255) NOT NULL, author_kind TXT NOT NULL, author_ref TXT NOT NULL, author_name TXT NOT NULL,
  text TXT NOT NULL, created_at INT NOT NULL, updated_at INT NOT NULL, issue TXT, project TXT, milestone TXT, reply_to TXT,
  mentions_json TXT NOT NULL DEFAULT '[]', seq INT NOT NULL
) TABLE_OPTIONS;
CREATE INDEX IF NOT EXISTS group_messages_channel ON group_messages(owner, group_id, created_at, seq);
CREATE INDEX IF NOT EXISTS group_messages_created ON group_messages(created_at);
CREATE TABLE IF NOT EXISTS public_messages (
  id ${ID} PRIMARY KEY, author_kind TXT NOT NULL, author_ref TXT NOT NULL, author_name TXT NOT NULL,
  text TXT NOT NULL, created_at INT NOT NULL, updated_at INT NOT NULL, issue TXT, project TXT, milestone TXT, reply_to TXT,
  mentions_json TXT NOT NULL DEFAULT '[]', seq INT NOT NULL
) TABLE_OPTIONS;
CREATE INDEX IF NOT EXISTS public_messages_channel ON public_messages(created_at, seq);
CREATE TABLE IF NOT EXISTS chat_read_state (
  person K(255) NOT NULL, thread K(255) NOT NULL, last_read TXT, unread INT NOT NULL DEFAULT 0, mentions INT NOT NULL DEFAULT 0,
  updated_at INT NOT NULL, PRIMARY KEY (person, thread)
) TABLE_OPTIONS;
CREATE INDEX IF NOT EXISTS chat_read_state_thread ON chat_read_state(thread);
`),
  },
  {
    version: 8,
    // Who paused a person's link to another person's agent (#1034), as SQLite migration 32 keeps it.
    statements: steps(`ALTER TABLE peer_rights ADD COLUMN IF NOT EXISTS paused_by TXT;`),
  },
  {
    version: 9,
    // An Admin reading a person's group or a Direct Message (#1034), as SQLite migration 33 keeps it: who and when, never any text.
    statements: steps(`
ALTER TABLE peer_rights ADD COLUMN IF NOT EXISTS paused_by_admin TXT;
CREATE TABLE IF NOT EXISTS chat_admin_reads (
  thread K(255) NOT NULL, admin_key ${REPORTER_KEY} NOT NULL, admin TXT NOT NULL, started_at INT NOT NULL, last_seen_at INT NOT NULL,
  PRIMARY KEY (thread, admin_key, started_at)
) TABLE_OPTIONS;
CREATE INDEX IF NOT EXISTS chat_admin_reads_seen ON chat_admin_reads(last_seen_at);
`),
  },
  {
    version: 10,
    // What an Admin record says (#1034), as SQLite migration 34 keeps it.
    statements: steps(`ALTER TABLE chat_admin_reads ADD COLUMN IF NOT EXISTS kind TXT NOT NULL DEFAULT 'read';`),
  },
  {
    version: 11,
    // An Admin record is kept until the person has seen it (#1051), as SQLite migration 35 keeps it.
    statements: steps(`
ALTER TABLE chat_admin_reads ADD COLUMN IF NOT EXISTS people TXT NOT NULL DEFAULT '[]';
ALTER TABLE chat_admin_reads ADD COLUMN IF NOT EXISTS seen TXT NOT NULL DEFAULT '[]';
`),
  },
  {
    version: 12,
    // The days the harness lets a person resume a session once it is closed (#1113), as SQLite migration 36 keeps it.
    statements: steps('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS resume_window_days INT;'),
  },
  {
    version: 13,
    // The tool counts behind Admin > Reporting > Tools (#720), as SQLite migration 37 keeps them.
    statements: steps(`
CREATE TABLE IF NOT EXISTS tools_daily (
  day K(32) NOT NULL, harness K(64) NOT NULL, tool K(255) NOT NULL, calls INT NOT NULL,
  PRIMARY KEY (day, harness, tool)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS tool_sessions_daily (
  day K(32) NOT NULL, harness K(64) NOT NULL, bucket INT NOT NULL, sessions INT NOT NULL,
  PRIMARY KEY (day, harness, bucket)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS harness_versions_daily (
  day K(32) NOT NULL, harness K(64) NOT NULL, version K(128) NOT NULL, reporters INT NOT NULL,
  PRIMARY KEY (day, harness, version)
) TABLE_OPTIONS;
`),
  },
  {
    version: 14,
    // What each tool did beyond being called (#721), as SQLite migration 38 keeps it.
    statements: steps(`
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tool_stats_json TXT;
CREATE TABLE IF NOT EXISTS tool_stats_daily (
  day K(32) NOT NULL, harness K(64) NOT NULL, tool K(255) NOT NULL,
  failed INT NOT NULL, asked INT NOT NULL, allowed INT NOT NULL, denied INT NOT NULL, podium INT NOT NULL, times_json TXT NOT NULL,
  PRIMARY KEY (day, harness, tool)
) TABLE_OPTIONS;
`),
  },
  {
    version: 15,
    // How long sessions ran and waited on their person, which agents they launched, who ran them and when they overlapped (#722), as SQLite
    // migration 39 keeps them. `session_waits` goes with its session.
    statements: steps(`
CREATE TABLE IF NOT EXISTS session_waits (
  session_id ${ID} PRIMARY KEY,
  permission_ms INT NOT NULL, permission_n INT NOT NULL, question_ms INT NOT NULL, question_n INT NOT NULL, plan_ms INT NOT NULL, plan_n INT NOT NULL,
  tracked_since INT NOT NULL, open_kind TXT, open_since INT,
  CONSTRAINT fk_session_waits_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS session_time_daily (
  day K(32) NOT NULL, harness K(64) NOT NULL, sessions INT NOT NULL, duration_s INT NOT NULL, max_duration_s INT NOT NULL,
  tracked_sessions INT NOT NULL, tracked_s INT NOT NULL,
  permission_s INT NOT NULL, permission_n INT NOT NULL, question_s INT NOT NULL, question_n INT NOT NULL, plan_s INT NOT NULL, plan_n INT NOT NULL,
  PRIMARY KEY (day, harness)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS agents_daily (
  day K(32) NOT NULL, harness K(64) NOT NULL, type K(191) NOT NULL, depth INT NOT NULL, agents INT NOT NULL,
  PRIMARY KEY (day, harness, type, depth)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS person_sessions_daily (
  day K(32) NOT NULL, owner K(128) NOT NULL, group_name TXT NOT NULL, harness K(64) NOT NULL, sessions INT NOT NULL,
  PRIMARY KEY (day, owner, harness)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS hour_peaks_daily (
  day K(32) NOT NULL, harness K(64) NOT NULL, hour INT NOT NULL, peak INT NOT NULL,
  PRIMARY KEY (day, harness, hour)
) TABLE_OPTIONS;
`),
  },
  {
    version: 16,
    // What sessions cost and how they ended (#723), as SQLite migration 40 keeps it.
    statements: steps(`
CREATE TABLE IF NOT EXISTS cost_daily (
  day K(32) NOT NULL, harness K(64) NOT NULL, model K(191) NOT NULL, effort K(64) NOT NULL,
  sessions INT NOT NULL, priced_sessions INT NOT NULL, calls INT NOT NULL, priced_calls INT NOT NULL, cost_usd REAL NOT NULL, call_cost_usd REAL NOT NULL,
  tok_in INT NOT NULL, tok_out INT NOT NULL, tok_cr INT NOT NULL, tok_cw INT NOT NULL,
  ended_low INT NOT NULL, ended_mid INT NOT NULL, ended_high INT NOT NULL, ended_unknown INT NOT NULL,
  compacted INT NOT NULL, cleared INT NOT NULL,
  PRIMARY KEY (day, harness, model, effort)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS tool_cost_daily (
  day K(32) NOT NULL, harness K(64) NOT NULL, tool K(255) NOT NULL,
  sessions INT NOT NULL, priced_sessions INT NOT NULL, cost_usd REAL NOT NULL, calls INT NOT NULL,
  PRIMARY KEY (day, harness, tool)
) TABLE_OPTIONS;
`),
  },
  {
    version: 17,
    // What each version of a harness sent (#724), as SQLite migration 41 keeps it.
    statements: steps(`
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS signals_json TXT;
CREATE TABLE IF NOT EXISTS feature_versions_daily (
  day K(32) NOT NULL, harness K(64) NOT NULL, version K(128) NOT NULL, feature K(191) NOT NULL, sessions INT NOT NULL,
  PRIMARY KEY (day, harness, version, feature)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS skills_daily (
  day K(32) NOT NULL, owner K(128) NOT NULL, harness K(64) NOT NULL, skill K(255) NOT NULL, sessions INT NOT NULL,
  PRIMARY KEY (day, owner, harness, skill)
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS person_places_daily (
  day K(32) NOT NULL, owner K(128) NOT NULL, group_name TXT NOT NULL, harness K(64) NOT NULL, project K(255) NOT NULL, branch K(255) NOT NULL, sessions INT NOT NULL,
  PRIMARY KEY (day, owner, harness, project, branch)
) TABLE_OPTIONS;
`),
  },
  {
    version: 18,
    // How often sessions were answered from Podium and how long they had waited (#725), as SQLite migration 42 keeps it.
    statements: steps(`
CREATE TABLE IF NOT EXISTS answers_daily (
  day K(32) NOT NULL, harness K(64) NOT NULL, kind K(64) NOT NULL, bucket INT NOT NULL, count INT NOT NULL,
  PRIMARY KEY (day, harness, kind, bucket)
) TABLE_OPTIONS;
`),
  },
];

export const ACTIVITY_STEPS: Step[] = [
  {
    version: 1,
    statements: steps(`
CREATE TABLE IF NOT EXISTS entries (
  id AUTO_ID,
  session_id ${ID} NOT NULL, "loop" K(255) NOT NULL, seq INT NOT NULL, at INT NOT NULL, t INT NOT NULL,
  kind TXT NOT NULL, text TXT NOT NULL, "by" TXT, note TXT, ref K(255), command TXT, command_cut INT
) TABLE_OPTIONS;
CREATE UNIQUE INDEX IF NOT EXISTS entries_loop_seq ON entries (session_id, "loop", seq);
CREATE INDEX IF NOT EXISTS entries_t ON entries (t);
CREATE INDEX IF NOT EXISTS entries_ref ON entries (session_id, ref);
CREATE INDEX IF NOT EXISTS entries_session_t ON entries (session_id, t, "loop");
CREATE TABLE IF NOT EXISTS stored_sessions (
  session_id ${ID} PRIMARY KEY, name TXT NOT NULL, project TXT, owner TXT,
  first_t INT NOT NULL, last_t INT NOT NULL,
  entries INT NOT NULL DEFAULT 0, bytes INT NOT NULL DEFAULT 0, oldest_t INT
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS loops (
  session_id ${ID} NOT NULL, "loop" K(255) NOT NULL, entries INT NOT NULL, first_at INT, last_t INT,
  PRIMARY KEY (session_id, "loop")
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS rec_sessions (
  session_id ${ID} PRIMARY KEY, name TXT NOT NULL, project TXT, owner TXT, state TXT NOT NULL, limit_kind TXT, loops TXT NOT NULL,
  started_by TXT, started_at INT, stopped_by TXT, stopped_at INT,
  entries INT NOT NULL DEFAULT 0, bytes INT NOT NULL DEFAULT 0, oldest_t INT, last_t INT
) TABLE_OPTIONS;
CREATE TABLE IF NOT EXISTS rec_entries (
  n AUTO_ID,
  session_id ${ID} NOT NULL, "loop" K(255) NOT NULL, seq INT NOT NULL, at INT NOT NULL, t INT NOT NULL,
  kind TXT NOT NULL, text TXT NOT NULL, name TXT, call_seq INT, failed INT, cut INT, lost INT, "by" TXT, b INT NOT NULL
) TABLE_OPTIONS;
CREATE UNIQUE INDEX IF NOT EXISTS rec_entries_loop_seq ON rec_entries (session_id, "loop", seq);
CREATE INDEX IF NOT EXISTS rec_entries_session_n ON rec_entries (session_id, n);
CREATE INDEX IF NOT EXISTS rec_entries_t ON rec_entries (t);
`),
  },
];

/** Called before each statement a migration runs, with the step and the statement's place in it. A test stops the runner here. */
export type BeforeStatement = (version: number, index: number) => void | Promise<void>;

/**
 * Sets the database to utf8mb4 under the byte collation, makes `table` (the record of applied steps) if it is missing, then runs each
 * step above the stored version, statement by statement, and records the step after its last statement. Returns the version it ends on.
 */
export async function migrate(db: MariaDbConn, table: string, list: readonly Step[], before?: BeforeStatement): Promise<number> {
  await db.exec(`ALTER DATABASE CHARACTER SET utf8mb4 COLLATE ${COLLATION}`);
  await db.exec(typed(`CREATE TABLE IF NOT EXISTS ${table} (version INT PRIMARY KEY, applied_at INT NOT NULL) TABLE_OPTIONS`));
  const have = new Set((await db.all<{ version: number }>(`SELECT version FROM ${table}`)).map((r) => r.version));
  let version = Math.max(0, ...have);
  for (const step of list) {
    if (have.has(step.version)) continue;
    for (const [i, statement] of step.statements.entries()) {
      await before?.(step.version, i);
      await db.exec(statement);
    }
    await db.run(`INSERT INTO ${table} (version, applied_at) VALUES (?, ?)`, [step.version, Date.now()]);
    version = Math.max(version, step.version);
  }
  return version;
}
