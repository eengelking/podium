---
title: "7.2 Database (SQLite)"
description: "The SQLite databases: path, pragmas, migrations and tables."
group: "Reference"
section: "7.2"
order: 2
---

# 7.2 Database (SQLite)

Path: `PODIUM_DB` env, default `<repo>/data/podium.sqlite` (add `data/` to `.gitignore`). Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`. Migrations are a numbered list applied in order and recorded in `schema_migrations`.

The server reaches the database through async storage interfaces, and SQLite is the only adapter and the default (#313, [DECISIONS 48](../../decisions/48-storage-sits-behind-async-interfaces-with-sqlite-as-the-only-adapter.md)). A plain `PODIUM_DB` path or `:memory:` means a SQLite file; `kind://target` is reserved for choosing another registered kind, and an unknown kind stops the server at start. What the server keeps beside the database, today the TLS CA, lives in `PODIUM_DATA_DIR`, which is the folder of the SQLite file when it is not set. [How it is built](../../architecture/02-components/19-storage.md).

The Activity history (#432) is a second file, `activity.sqlite`, in the same folder (`:memory:` when the main
database is). It has its own schema version in `PRAGMA user_version`, WAL, `synchronous=NORMAL` and incremental
auto-vacuum, and holds only these tables, which nothing in the main database references:

```sql
CREATE TABLE entries (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, loop TEXT NOT NULL, seq INTEGER NOT NULL,
  at INTEGER NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, "by" TEXT, note TEXT, ref TEXT);
  -- unique (session_id, loop, seq); indexes on t and on (session_id, ref); `at` is the entry's own time, `t` the same
  -- instant on the server's clock; "by", note and ref are set only for an entry sent from Podium
CREATE TABLE stored_sessions (session_id TEXT PRIMARY KEY, name TEXT NOT NULL, project TEXT, owner TEXT,
  first_t INTEGER NOT NULL, last_t INTEGER NOT NULL,
  entries INTEGER NOT NULL, bytes INTEGER NOT NULL, oldest_t INTEGER);  -- what the Admin pages show, with no join into the main
  -- database; entries, bytes (an estimate) and oldest_t are kept in step with `entries` (schema version 2)
CREATE TABLE loops (session_id TEXT NOT NULL, loop TEXT NOT NULL, entries INTEGER NOT NULL, first_at INTEGER,
  last_t INTEGER, PRIMARY KEY (session_id, loop));  -- per-loop counts and first and last times, so the live feed's `history`
  -- note and a history page cost one indexed read (schema version 3)
```

A session's rows are removed by code (a deleted session, a purge, an Admin delete, or the hourly run that drops the
entries of sessions the main database no longer holds), since no foreign key crosses files.

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,           -- running | waiting | done
  wait_reason TEXT, wait_note TEXT, end_reason TEXT, resume_id TEXT,
  started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, ended_at INTEGER, dropped_at INTEGER,
  cwd TEXT NOT NULL, project_root TEXT, repo_name TEXT,
  git_json TEXT,                                                           -- Report.session.git
  model TEXT, effort TEXT,
  context_tokens INTEGER, context_window INTEGER, context_percent REAL,
  cost_usd REAL, tok_in INTEGER, tok_out INTEGER, tok_cr INTEGER, tok_cw INTEGER,
  rate_limits_json TEXT, blowouts INTEGER NOT NULL DEFAULT 0,
  plan_json TEXT, reporter_version TEXT, engine_version TEXT,
  loop_json TEXT,                                                          -- Report.session.loop; NULL from a reporter older than 0.4.0
  files_json TEXT,                                                         -- Report.session.files; NULL from a reporter older than 0.6.0
  attached INTEGER,                                                        -- Report.session.attached (1 or 0); NULL when unknown
  detached_at INTEGER,                                                     -- when the first report with attached = false arrived; NULL while attached or unknown
  owner TEXT,                                                              -- who the server decided the session belongs to from the token: a person's name, 'Admin', or NULL (auth off, or from before migration 6)
  background_json TEXT,                                                    -- Report.session.background (#119); NULL when the session waits on nothing in the background
  machine_json TEXT,                                                       -- Report.machine ({ name, id }); kept when a later report or hook carries none; NULL when never sent (migration 7)
  usage_json TEXT                                                          -- Report.session.usageByModel (#117, migration 10); NULL from an older reporter
);
CREATE TABLE agents (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL,
  parent_id TEXT, kind TEXT NOT NULL, type TEXT NOT NULL, name TEXT, description TEXT NOT NULL,
  model TEXT, effort TEXT, effort_source TEXT, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  context_tokens INTEGER, context_window INTEGER, context_percent REAL,
  tok_in INTEGER, tok_out INTEGER, tok_cr INTEGER, tok_cw INTEGER, cost_usd_est REAL,
  usage_json TEXT,                                                         -- AgentReport.usageByModel (#117, migration 10); NULL from an older reporter
  skills_json TEXT, last_tool TEXT, tool_calls INTEGER, tool_counts_json TEXT, blowouts INTEGER NOT NULL DEFAULT 0,
  steps_done INTEGER, steps_total INTEGER, prompt_excerpt TEXT, answer_excerpt TEXT, failure_json TEXT,
  PRIMARY KEY (session_id, id)
);
CREATE TABLE agent_texts (   -- migration 8: the whole prompt and answer (6.4), apart so agents stays small
  session_id TEXT NOT NULL, agent_id TEXT NOT NULL, prompt_text TEXT, answer_text TEXT,
  PRIMARY KEY (session_id, agent_id)
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT, t INTEGER NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, data_json TEXT
);
CREATE INDEX events_session_t ON events(session_id, t DESC);  CREATE INDEX events_t ON events(t DESC);
CREATE TABLE blowouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent_id TEXT, t INTEGER NOT NULL,
  kind TEXT NOT NULL,                                                      -- auto-compact | window-exceeded | server-compaction
  tokens_before INTEGER, tokens_after INTEGER, UNIQUE (session_id, agent_id, t, kind)
);
CREATE TABLE samples (                                                     -- one row per second per live session
  session_id TEXT NOT NULL, t INTEGER NOT NULL,                            -- t = whole seconds
  tokens_total INTEGER NOT NULL, tokens_delta INTEGER NOT NULL, peak_context REAL NOT NULL,
  running_agents INTEGER NOT NULL, cost_usd REAL, usage_json TEXT,        -- usage_json: the session's usageByModel at that second (migration 16, #270), stored in full only when it changed or at a minute's first sample, else '='; NULL from an older reporter
  PRIMARY KEY (session_id, t)
);
```

Migration 6 adds the tables for the Admin section (7.7). A token is never stored: only its SHA-256 (migration 17, #277, dropped the last four characters it used to keep).

```sql
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_lower TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_lower TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL,   -- token_last4 existed until migration 17 (#277)
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, rotated_at INTEGER, revoked_at INTEGER, last_report_at INTEGER
);
CREATE TABLE person_machines (person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, machine TEXT NOT NULL, last_seen_at INTEGER NOT NULL, PRIMARY KEY (person_id, machine));
-- person_machines.machine is `name (first four of machine.id)` when the report sent a machine, else the source address.
-- Rows unseen for 30 days are deleted and only a person's 10 most recent are kept (#379, migration 18).
CREATE TABLE admin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, source TEXT NOT NULL);
CREATE TABLE reporters (                                                  -- #142, migration 11 (12 merges rows that share a session, #166): every reporter the server has heard from; retention never touches it, only the Admin (or the forget-by-age setting) removes rows
  key TEXT PRIMARY KEY,                                                    -- the machine id the reporter sends (`<machine id>#<owner>` for a second account on the same machine, #221), else 'addr:<source address>' (a mod that sends none) or 'hooks:<source address>' (settings hooks)
  kind TEXT NOT NULL, machine_id TEXT, machine_name TEXT, source_address TEXT,  -- kind: 'mod' or 'hooks'
  owner TEXT, credential TEXT,                                             -- credential: 'pdm_<key id>' or 'admin secret', never a token; NULL when auth is off
  reporter_version TEXT NOT NULL, engine_version TEXT,                     -- reporter_version is 'hooks' for settings hooks
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE reporter_sessions (reporter_key TEXT NOT NULL REFERENCES reporters(key) ON DELETE CASCADE, session_id TEXT NOT NULL, PRIMARY KEY (reporter_key, session_id));  -- counts a reporter's sessions and finds the recent ones that still exist
CREATE TABLE reporter_ignores (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, pattern TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (kind, pattern));  -- #167, migration 13: a report from a reporter that matches a rule is refused. kind is key, address or version; pattern is text with * for "anything"
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);       -- allow_admin_secret_reporting: '1' (default) or '0'; feature.<id>: '0' once the Admin turns a feature flag off and '1' once on, an unset flag taking its default (on, except `respond`, `file-diff`, `peer-messaging`, `session-recording` and `activity-output`, which are off, #206, #319, #347, #353, #431); wall_notice.<id>: '0' once a notice is off; wall_show_background_sessions: '1' when on (default off); model_prices: JSON of only what the Admin changed from the built-in prices, `{ "<key>": { std?, long? } }` (#117); peer_settings: JSON of the orchestrator messaging limits and retention, `{ roundTrips, perMinute, maxChars, retainDays }` (#347); activity_history: JSON of the Admin's Activity history choice, `{ policy, n, unit, capGb }`, an unset row meaning `default` (#432); recording_settings: JSON of the session recording limits, `{ keepHours, budgetMb, sessionMb }`, an unset row meaning `{ 6, 4096, 512 }` (#353); the recordings themselves are in `activity.sqlite`, not here; chat_scope, `chat.*` and `chat.flag.*`: Chat's server scope, limits and channel flags ([What Chat keeps](#what-chat-keeps-and-where-1034), #1034)
```

Migration 22 (#484) adds the daily rollups that Admin > Reporting reads ([8.1](../08-ui/08-01-what-the-ui-must-do.md#admin-layout-143-mockuppodium-adminhtml)). A rollup row
holds counts, tokens, cost and names (a person, group, model, project and effort), never a prompt, an answer, a tool's
input or a path. A day is a calendar day in the server's time zone (`day` is `YYYY-MM-DD`); every report states that zone.

```sql
CREATE TABLE usage_daily (      -- one row per day, person, model and project; a session counts on the day it was last seen
  day TEXT NOT NULL, owner TEXT NOT NULL, group_name TEXT NOT NULL, model TEXT NOT NULL, project TEXT NOT NULL,  -- '' when none: no owner, no group, no model, no repo
  sessions INTEGER NOT NULL, agents INTEGER NOT NULL, cost_usd REAL NOT NULL,   -- cost_usd: summed only from priced models (the unpriced-model dash stays a dash); unpriced_sessions says how many sessions had none
  unpriced_sessions INTEGER NOT NULL, tok_in INTEGER NOT NULL, tok_out INTEGER NOT NULL, tok_cr INTEGER NOT NULL, tok_cw INTEGER NOT NULL,
  PRIMARY KEY (day, owner, model, project)
);
CREATE TABLE sessions_daily (   -- one row per day, outcome, model, effort and plan; durations in whole seconds
  day TEXT NOT NULL, outcome TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, plan TEXT NOT NULL,   -- outcome: the session's end_reason, or 'running' for one still live when the rollup ran; plan: where the session's plan came from (TaskCreate, TodoWrite, podium_plan) or 'none'
  sessions INTEGER NOT NULL, duration_s INTEGER NOT NULL, max_duration_s INTEGER NOT NULL, agents INTEGER NOT NULL, blowouts INTEGER NOT NULL, max_context_pct REAL NOT NULL,
  PRIMARY KEY (day, outcome, model, effort, plan)
);
CREATE TABLE failures_daily (   -- one row per day, person, failure class and tool
  day TEXT NOT NULL, owner TEXT NOT NULL, class TEXT NOT NULL, tool TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (day, owner, class, tool)
);
CREATE TABLE fleet_daily (      -- one row per day for the fleet as a whole
  day TEXT PRIMARY KEY, active_people INTEGER NOT NULL, active_reporters INTEGER NOT NULL,
  sessions_started INTEGER NOT NULL, peak_live_sessions INTEGER NOT NULL,
  reporter_versions_json TEXT NOT NULL, engine_versions_json TEXT NOT NULL   -- { "<version>": reporters heard from that day }
);
```

Migration 37 (#720; PostgreSQL main step 13) adds the tool counts of every harness to the rollups, under the same rule: names and
counts, never a tool's input, a path or a command. A session counts on the day it was last seen, under the harness stored on it.

```sql
CREATE TABLE tools_daily (          -- one row per day, harness and tool; an MCP tool keeps its `mcp__<server>__<tool>` name
  day TEXT NOT NULL, harness TEXT NOT NULL, tool TEXT NOT NULL, calls INTEGER NOT NULL,
  PRIMARY KEY (day, harness, tool)
);
CREATE TABLE tool_sessions_daily (  -- how many sessions made about `bucket` calls; a session with no tool counts is left out, not counted as zero calls
  day TEXT NOT NULL, harness TEXT NOT NULL, bucket INTEGER NOT NULL, sessions INTEGER NOT NULL,   -- bucket: the calls up to 100, then the next ten up to 1,000, then the next hundred
  PRIMARY KEY (day, harness, bucket)
);
CREATE TABLE harness_versions_daily ( -- how many reporters ran a version of a harness that day
  day TEXT NOT NULL, harness TEXT NOT NULL, version TEXT NOT NULL, reporters INTEGER NOT NULL,
  PRIMARY KEY (day, harness, version)
);
```

Migration 38 (#721; PostgreSQL main step 14) adds what each tool did, under the same rule. `agents.tool_stats_json` is the agent's `toolStats`
as JSON (NULL from a reporter that does not send it); the main loop's own are in `sessions.loop_json`. The same migration makes the tool
counts above include the main loop's own calls, which `tools_daily` read from the agents only until then.

```sql
CREATE TABLE tool_stats_daily (      -- one row per day, harness and tool that has any of it
  day TEXT NOT NULL, harness TEXT NOT NULL, tool TEXT NOT NULL,
  failed INTEGER NOT NULL, asked INTEGER NOT NULL, allowed INTEGER NOT NULL, denied INTEGER NOT NULL, podium INTEGER NOT NULL,
  times_json TEXT NOT NULL,          -- JSON of call length bucket to calls: a bucket is a step of 10%, so a median and a 95th percentile survive being added across days
  PRIMARY KEY (day, harness, tool)
);
```

The three tables fill from the rows still stored on each run, so a database upgraded to this migration holds tool counts only for the days its
sessions are still kept (30), and the Tools report says "Podium has no history before ..." for the earlier days rather than showing zeros.

Migration 39 (#722; PostgreSQL main step 15) adds how long sessions ran and waited on a person, which agents they launched and how deep the chains went, who ran
sessions on a day, and the peak of live sessions in each hour. Names, counts and times only: never a question, a plan, a tool's input, a note or a path. They are
kept per harness, and a session counts on the day it was last seen, as in migration 22.

```sql
CREATE TABLE session_waits (        -- what one session has waited on its person for, added up as its reports arrive; goes with its session
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  permission_ms INTEGER NOT NULL, permission_n INTEGER NOT NULL, question_ms INTEGER NOT NULL, question_n INTEGER NOT NULL, plan_ms INTEGER NOT NULL, plan_n INTEGER NOT NULL,
  tracked_since INTEGER NOT NULL,   -- the first report stored after the upgrade: a session older than this has no row, which is not the same as a session that never waited
  open_kind TEXT, open_since INTEGER  -- the wait in progress, closed by the first report that no longer shows it
);
CREATE TABLE session_time_daily (   -- one row per day and harness
  day TEXT NOT NULL, harness TEXT NOT NULL, sessions INTEGER NOT NULL, duration_s INTEGER NOT NULL, max_duration_s INTEGER NOT NULL,
  tracked_sessions INTEGER NOT NULL, tracked_s INTEGER NOT NULL,   -- the sessions that have a session_waits row, and how long they ran since it began
  permission_s INTEGER NOT NULL, permission_n INTEGER NOT NULL, question_s INTEGER NOT NULL, question_n INTEGER NOT NULL, plan_s INTEGER NOT NULL, plan_n INTEGER NOT NULL,
  PRIMARY KEY (day, harness)
);
CREATE TABLE agents_daily (         -- agents launched; depth 1 is launched by the session itself, capped at 10
  day TEXT NOT NULL, harness TEXT NOT NULL, type TEXT NOT NULL, depth INTEGER NOT NULL, agents INTEGER NOT NULL,
  PRIMARY KEY (day, harness, type, depth)
);
CREATE TABLE person_sessions_daily (
  day TEXT NOT NULL, owner TEXT NOT NULL, group_name TEXT NOT NULL, harness TEXT NOT NULL, sessions INTEGER NOT NULL,
  PRIMARY KEY (day, owner, harness)
);
CREATE TABLE hour_peaks_daily (     -- harness '' is every harness together: the peak of the whole is not the sum of the parts
  day TEXT NOT NULL, harness TEXT NOT NULL, hour INTEGER NOT NULL, peak INTEGER NOT NULL,
  PRIMARY KEY (day, harness, hour)
);
```

Migration 40 (#723; PostgreSQL main step 16) adds what sessions cost and how they ended, kept per harness: counts, tokens and names only, never a prompt, a tool's input or a path.

```sql
CREATE TABLE cost_daily (           -- one row per day, harness, model and effort; a session counts on the day it was last seen
  day TEXT NOT NULL, harness TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
  sessions INTEGER NOT NULL, priced_sessions INTEGER NOT NULL, calls INTEGER NOT NULL, priced_calls INTEGER NOT NULL, cost_usd REAL NOT NULL, call_cost_usd REAL NOT NULL,   -- cost_usd is the priced sessions' only; priced_calls and call_cost_usd are those of the priced sessions that have tool counts, so a cost per call is not inflated by one that has none
  tok_in INTEGER NOT NULL, tok_out INTEGER NOT NULL, tok_cr INTEGER NOT NULL, tok_cw INTEGER NOT NULL,
  ended_low INTEGER NOT NULL, ended_mid INTEGER NOT NULL, ended_high INTEGER NOT NULL, ended_unknown INTEGER NOT NULL,   -- context window used at the end: under 50%, 50% to 80%, above 80%, not reported
  compacted INTEGER NOT NULL, cleared INTEGER NOT NULL,   -- sessions that compacted on their own, and that continue after a /clear
  PRIMARY KEY (day, harness, model, effort)
);
CREATE TABLE tool_cost_daily (      -- the sessions that called one tool on a day: a tool has no cost of its own, so this is what those sessions cost
  day TEXT NOT NULL, harness TEXT NOT NULL, tool TEXT NOT NULL,
  sessions INTEGER NOT NULL, priced_sessions INTEGER NOT NULL, cost_usd REAL NOT NULL, calls INTEGER NOT NULL,
  PRIMARY KEY (day, harness, tool)
);
```

Both fill from the rows still stored on each run, like the other rebuilt tables. Compactions are counted from the stored `compact` events, which are kept 30 days, and a day older than
that is not rebuilt. A database upgraded to this migration has these tables only from the first run after the upgrade, so a period before it says "Podium has no history before ...".

The four daily tables fill from the rows still stored on each run, except `hour_peaks_daily`, which is upserted so an hour's stored peak never goes down once the
samples that made it (kept 24 hours) are gone. A database upgraded to this migration holds waiting only from the upgrade on, so the Sessions page shows a dash for
the days before it and says when waiting began, rather than showing zeros. Agent types, depths and people per day fill for the days the sessions are still kept (30).

Migration 41 (#724; PostgreSQL main step 17) adds what each version of a harness sent, the skills each person used and where each person worked: names and counts only, never a prompt, a tool's input, a command's text or a path.

```sql
ALTER TABLE sessions ADD COLUMN signals_json TEXT;   -- what the harness sent the reporter in this session: signal name (`hook:...`, `field:...`) to count; NULL from a reporter that does not send it
CREATE TABLE feature_versions_daily (  -- sessions on one version of a harness that sent a feature on a day: `hook:...`, `field:...`, `tool:...`; and the reserved names `signals` and `tools`, the sessions to compare against
  day TEXT NOT NULL, harness TEXT NOT NULL, version TEXT NOT NULL, feature TEXT NOT NULL, sessions INTEGER NOT NULL,
  PRIMARY KEY (day, harness, version, feature)
);
CREATE TABLE skills_daily (            -- sessions of one person that used one skill on a harness on a day
  day TEXT NOT NULL, owner TEXT NOT NULL, harness TEXT NOT NULL, skill TEXT NOT NULL, sessions INTEGER NOT NULL,
  PRIMARY KEY (day, owner, harness, skill)
);
CREATE TABLE person_places_daily (     -- sessions of one person in one project (the repository's name) on one git branch on a harness on a day; no path
  day TEXT NOT NULL, owner TEXT NOT NULL, group_name TEXT NOT NULL, harness TEXT NOT NULL, project TEXT NOT NULL, branch TEXT NOT NULL, sessions INTEGER NOT NULL,
  PRIMARY KEY (day, owner, harness, project, branch)
);
```

The three tables fill from the rows still stored on each run, like the other rebuilt tables, and are kept 395 days. `sessions.signals_json` is replaced by each report that carries signals and kept by one that carries none. A database upgraded to this
migration has these tables only from the first run after the upgrade, so a period before it says "Podium has no history before ...". The branch names are the ones the wall already shows, so the rollups keep them for as long as the other rollups.

Migration 15 (#206) links a session to the one it continues after a `/clear` (5.8):

```sql
ALTER TABLE sessions ADD COLUMN cleared_from TEXT;                        -- Report.session.clearedFrom; NULL when the session does not continue another
CREATE INDEX sessions_cleared_from ON sessions(cleared_from);             -- finds clearedInto for History
```

Migration 28 (#851; PostgreSQL main step 4) records the harness a session runs under and who worked out its cost (6.5):

```sql
ALTER TABLE sessions ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude-code';  -- Report.session.harness; every earlier row is a Claude Code session
ALTER TABLE sessions ADD COLUMN cost_source TEXT;                              -- 'harness' when cost_usd is the harness's own figure; NULL when Podium priced it
```

Migration 29 (#940; PostgreSQL main step 5) stores what a harness declares. NULL in each means no report has declared it, which is what every earlier row and every v1 session is:

```sql
ALTER TABLE sessions ADD COLUMN capabilities_json TEXT;  -- Report.capabilities as sent: a JSON Capabilities; a key left out was not declared
ALTER TABLE sessions ADD COLUMN model_label TEXT;        -- Report.session.modelLabel
ALTER TABLE sessions ADD COLUMN model_provider TEXT;     -- Report.session.modelProvider
```

Migration 30 (#945; PostgreSQL main step 6) gives an agent the same two fields. NULL means no report gave one, which is every agent stored before this. A report that sends neither keeps what the agent has, unless it names a different `model` (6.2):

```sql
ALTER TABLE agents ADD COLUMN model_label TEXT;     -- Report.agents[].modelLabel
ALTER TABLE agents ADD COLUMN model_provider TEXT;  -- Report.agents[].modelProvider
```

Migration 17 (#277) drops `people.token_last4`, the last four characters of a person's token, which nothing has read since #218:

```sql
ALTER TABLE people DROP COLUMN token_last4;
```

## What orchestrator messaging keeps, and where (#347)

Migration 20 adds four tables and two reporter columns. Unlike responding, it keeps a message's text, so a person can
read a conversation afterwards ([7.7](07-07-hardening.md#orchestrator-messaging-347)).

```sql
ALTER TABLE reporters ADD COLUMN os TEXT;                                 -- Report.machine.os as last reported; a report without one keeps it
ALTER TABLE reporters ADD COLUMN peers INTEGER;                           -- the `peers` option as last reported (1 or 0); NULL from an older reporter
ALTER TABLE reporters ADD COLUMN reporter_name TEXT NOT NULL DEFAULT 'podium-reporter';  -- #849, migration 27: which reporter sent the row; the key is the machine id (or address) plus `@<name>` for any reporter but `podium-reporter`, so a machine running two reporters has two rows and every earlier key stays valid
CREATE TABLE peer_rights (from_key TEXT, to_key TEXT, owner TEXT, level TEXT, paused INTEGER, set_at INTEGER, PRIMARY KEY (from_key, to_key));
  -- one direction between two of one owner's reporters (the same reporter twice included); level none | see | ask | send.
  -- A `none` row exists only to hold a pause, or a removal under Trust my own reporters
CREATE TABLE peer_owner_settings (owner_lower TEXT PRIMARY KEY, trust INTEGER, on_request TEXT, new_send TEXT, limits_json TEXT);
  -- My reporters > Defaults: Trust my own reporters, the answer to an orchestrator's request, a new right to send, stricter limits
CREATE TABLE peer_requests (id TEXT PRIMARY KEY, owner TEXT, kind TEXT, from_key TEXT, to_key TEXT, level TEXT, reason TEXT, by TEXT,
  from_session TEXT, message_id TEXT, created_at INTEGER, closed_at INTEGER, outcome TEXT);
  -- kind proposal | access | message; outcome allowed | declined | delivered | dropped once closed
CREATE TABLE peer_messages (id TEXT PRIMARY KEY, owner TEXT, link TEXT, from_key TEXT, to_key TEXT, from_session TEXT, to_session TEXT,
  from_name TEXT, from_machine TEXT, to_name TEXT, to_machine TEXT, text TEXT, sent_at INTEGER, state TEXT, state_at INTEGER, why TEXT,
  approved INTEGER, handed INTEGER);
  -- link: the two reporter keys, sorted, joined by |. state approval | ready | handed | queued | delivered | declined | dropped
```

- The Admin's limits and retention are one `settings` row, `peer_settings`, JSON of `{ roundTrips, perMinute, maxChars,
  retainDays }`; an unset or invalid value takes its default. The flag is `feature.peer-messaging`.
- In memory only: the live orchestrators (each one's reporter, owner, name, machine, OS, status and `peers` option,
  refilled by its next report after a restart) and Podium's notices to them (at most 20 each). A restart loses the
  notices; the messages, rights and requests survive it.
- A message's text is never in the state, the stream, the Admin log or the server log.

## What Chat keeps, and where (#1034)

Chat has three tables, one for each audience, so that a missed filter can never send one audience's text to another. A
conversation between agents, or between a person and one agent, is `peer_messages` above. The group channel is
`group_messages` and General is `public_messages`. **`peer_messages` is never copied into, merged with or returned together with the
other two**: each has its own read and write path in the storage interface, and a test holds the server's code to it.

Migration 31 (PostgreSQL main step 7; migration 32 is PostgreSQL main step 8) adds the following. Both adapters carry the same
columns, indexes and rows.

```sql
ALTER TABLE peer_messages ADD COLUMN author TEXT NOT NULL DEFAULT 'agent';  -- 'agent' (an orchestrator, over podium_send) or 'person' (the owner, from Chat). Every earlier row is an agent's
ALTER TABLE peer_messages ADD COLUMN hidden_at INTEGER;                    -- when every agent session in the conversation had left the live set; NULL while it shows
CREATE INDEX peer_messages_hidden ON peer_messages(hidden_at);
CREATE TABLE group_messages (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, group_id TEXT NOT NULL, author_kind TEXT NOT NULL, author_ref TEXT NOT NULL, author_name TEXT NOT NULL,
  text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, issue TEXT, project TEXT, milestone TEXT, reply_to TEXT,
  mentions_json TEXT NOT NULL DEFAULT '[]', seq INTEGER NOT NULL
);
CREATE INDEX group_messages_channel ON group_messages(owner, group_id, created_at, seq);
CREATE INDEX group_messages_created ON group_messages(created_at);
CREATE TABLE public_messages (   -- the same row as group_messages, without owner and group_id: the table is the audience
  id TEXT PRIMARY KEY, author_kind TEXT NOT NULL, author_ref TEXT NOT NULL, author_name TEXT NOT NULL,
  text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, issue TEXT, project TEXT, milestone TEXT, reply_to TEXT,
  mentions_json TEXT NOT NULL DEFAULT '[]', seq INTEGER NOT NULL
);
CREATE INDEX public_messages_channel ON public_messages(created_at, seq);
CREATE TABLE chat_read_state (   -- one person's counts in one thread, kept on the server so the stream can carry counts and no text
  person TEXT NOT NULL, thread TEXT NOT NULL, last_read TEXT, unread INTEGER NOT NULL DEFAULT 0, mentions INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY (person, thread)
);
CREATE INDEX chat_read_state_thread ON chat_read_state(thread);
```

Migration 32 (#1034) records who paused a link between a person and another person's agent, so only they (or an Admin) can
resume it: `ALTER TABLE peer_rights ADD COLUMN paused_by TEXT;` (`sender`, `owner` or `admin`; NULL when the link is not
paused, and for a pause made before it was kept, which either owner may resume).

Migrations 33 and 34 (#1034; PostgreSQL main steps 9 and 10) keep what an Admin does in a person's conversation, so the people in it can always
see it (7.7). Migration 33 names the Admin who paused a link and adds one table; migration 34 adds what a record says:

```sql
ALTER TABLE peer_rights ADD COLUMN paused_by_admin TEXT;   -- the Admin's name while paused_by is 'admin'; NULL otherwise
CREATE TABLE chat_admin_reads (   -- one row per Admin and thread and reading session; never any text
  thread TEXT NOT NULL,           -- 'dm:<a>|<b>' for a conversation, 'group:<person>' for a group, 'public' for General (only an Admin's stops, never a reading), 'ask:<session>', 'activity:<session>:<loop>', 'text:<session>:<agent>' and 'live:<session>:<loop>' for an Admin's read of a person's waiting ask, stored Activity, an agent's whole prompt and answer, or its live Activity (#1073, #1074, #1082)
  admin_key TEXT NOT NULL,        -- the Admin's name, folded
  admin TEXT NOT NULL,            -- the name as shown ("Admin secret" for the admin secret)
  started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (thread, admin_key, started_at)
);
CREATE INDEX chat_admin_reads_seen ON chat_admin_reads(last_seen_at);
ALTER TABLE chat_admin_reads ADD COLUMN kind TEXT NOT NULL DEFAULT 'read';   -- migration 34: 'read', 'cleared', 'paused', 'resumed', 'disconnected', 'reconnected', or (#1078, on an `act:<name>` thread, no migration) 'recording_stopped', 'recording_deleted', 'activity_deleted', 'session_deleted', 'access_revoked', 'person_deleted' or 'reporter_removed'
```

Migration 35 (#1051; PostgreSQL main step 11) keeps a record until each person it names has seen it:

```sql
ALTER TABLE chat_admin_reads ADD COLUMN people TEXT NOT NULL DEFAULT '[]';   -- the people the record is owed to: a JSON list of folded names
ALTER TABLE chat_admin_reads ADD COLUMN seen TEXT NOT NULL DEFAULT '[]';     -- the ones of those who have seen it: a JSON list of folded names
```

A row made before migration 35 owes nobody, so retention treats it as before. General's rows owe nobody either.

A reading is one row for the reads of one thread by one Admin less than 30 minutes apart; `last_seen_at` moves on each read or ping. The other kinds
are one row for each stop (an Admin's remove all messages, pause or resume), never a session. A look at a person's list of conversations is a reading of the
thread `list:<person>`. A row is protected until every person in `people` is in `seen`; after that it goes by retention. A person has seen a row when Podium sent it to their console: they loaded the
group or conversation it is about, or, for a look at their list, their own overview. The row of a conversation they can no longer open is not seen on a thread,
so their own overview lists it (`goneReads`: the newest 20, with the Admin, the time, what it was and the other party's name, never any text) and marks it seen
when it loads, after which it goes by retention. Until then neither the hourly retention (which removes rows last seen before the channels' retention days, and those of a conversation that no
longer exists), the purge of a hidden conversation, nor Delete conversation removes it; once it is seen, they do. Remove all messages never removes
any. An Admin's stop is recorded before it happens, so a stop that cannot be recorded does not happen. Deleting a person removes their group, read counts,
Direct Messages (the ones they own and the ones with their `person:<name>` end), links, requests and owner defaults, and the Admin records owed only to them (they
can never be seen); a record owed to others as well stays for them, without the deleted person. A record that names nobody is not theirs. Sessions, spend, the
Admin log and General keep their name as text.

- **Ids.** A channel message's id is `grp_<scope>_<24 hex>` (group) or `pub_<scope>_<24 hex>` (General). `<scope>` is
  the server's 8 hex digits, made once and kept in `settings` as `chat_scope`, so ids from two servers differ and can be carried
  unchanged later. A direct message keeps its `dlv_` style id.
- **Author.** `author_kind` is `person`, `orchestrator`, `subagent` or `reporter`; `author_ref` is the person's name, the session id
  or the reporter key. `issue`, `project` and `milestone` are optional links. Neither channel table has a `visibility`
  column: the table is the audience. `peer_messages.author` is how a person is a peer in a direct message: a person's message
  has the person's name as its sender and no machine. A person's end of a conversation across owners is `person:<name, folded>` in
  `from_session` or `to_session`, and in `from_key` or `to_key` for the link. An agent's answer to such a person is an `agent` message with `to_session`
  and `to_key` `person:<key>`, `state` `delivered`, no approval and nothing handed to a reporter. The hourly retention never counts a
  `person:` end as a missing session, so neither a person's message nor an answer to one is dropped as an orphan.
- **Mentions.** `mentions_json` is a JSON array of `{ sessionId, peerKey, typed, state, why, stateAt }` ([7.1](07-01-endpoints.md#routes-for-chat-1034)).
- **Order.** A page orders by `created_at, seq` in both adapters (`seq` is the insertion number, so a tie is decided the same
  way everywhere), and a page back starts strictly before its cursor, so a message deleted between two page reads cannot break it.
- **Direct messages.** A conversation is hidden, not deleted, when its agents leave (`hidden_at`); see [7.5](07-05-lifecycle-timers.md). How long it is kept follows the harness's resume window, which `sessions.resume_window_days` holds (NULL when no report has said).
- **Settings rows**, all in `settings`: `chat.retainDays` (days a channel keeps its messages, default 30, 1 to 365),
  `chat.graceHours` (hours a hidden conversation is kept when none of its agents has a resume window, default 24, 1 to 720), `chat.maxChars` (the longest channel message, message to another person's agent,
  or message to one's own agent from Chat, default 4,000, 1 to 20,000) and `chat.perMinute` (posts or messages a minute for one author, default 6, 1
  to 600). A value outside its range is ignored on read and refused on write. `chat.flag.<scope>` holds a channel's flags as
  letters (`p` paused, `d` disconnected), with the scope `public:global` (General, paused for everyone), `public:person:<name>`
  (General, one person's agents) or `group:<owner>`. A scope with neither flag has no row. The flag `feature.chat-everyone`
  is '0' or '1' like the other features, and is off by default.
- A message's text is never in the state, the stream, the Admin log or the server log.

## What responding keeps, and where (#206)

Only two things reach the database: the `cleared_from` link above and the Admin's `feature.respond` setting. A message a person
writes to an agent from Chat is the exception, and is not responding's: it is stored as Chat's, in `peer_messages` (above),
because the person is a peer in a Direct Message and can read the conversation afterwards. Responding's own answers and commands
are still kept nowhere.
Each answer is also written to `admin_log` ([7.7](07-07-hardening.md)) with who sent it, the session and the kind of
answer, never its text.

Everything else is held in the server's memory, in one store per live session, and never in the database, the
state body or the stream:

- the open asks, with their questions, plan text or tool input ([6.2](../06-reporter-protocol/06-02-the-report.md)), at most 8 per session;
- a closed ask's outcome (who answered and when, the terminal's answer summary), until a report shows the session
  running again after it closed, for at most 10 minutes, or until its next ask opens;
- the pending deliveries: the one answer taken for each ask, and at most 20 messages and commands per session,
  each with who sent it, when, and its result once the mod reports one.

What a restart does:

- A pending answer or message does **not** survive a server restart. It is gone, and the person sends it
  again.
- A delivery that a restart lost before the mod took it never reaches the session. One the mod already took
  and reports on afterwards gets a `404` the mod ignores.
- The asks come back by themselves, since the mod re-sends its open asks in every report and announces an ask
  again when a held request gets a `404`.
- This keeps the text of answers, questions and plans off the disk. The cost is small: a delivery normally
  waits a second or two, so only one sent to a session that isn't checking in is at risk.

When the store lets go:

- The store drops a session's asks and deliveries when the session leaves the live set
  ([7.5](07-05-lifecycle-timers.md)), when it reports `done`, and when it is deleted. An ask closes as `ended` then.
- While a session is stale it keeps them, so an answer sent then is delivered once the reporter checks in
  again, unless the ask closed by then ("Session not checking in").
- Turning the `respond` flag off drops every ask and delivery the store holds, and refuses every respond route
  until it is on again.

## Retention

The sweeper runs this hourly:

- Samples older than 24 h are deleted.
- Events older than 30 days are deleted.
- Sessions ended more than 30 days ago are deleted with their rows.
- Admin log rows older than 90 days are deleted, except that the newest 100 rows are always kept, so a quiet
  server keeps some history (#303).
- Chat (#1034): a channel message older than the Admin's `retainDays` (30 days unless the Admin sets another) is deleted from
  General and every group, and the messages of a Direct Message hidden for longer than the longest resume window of its agents (#1113, 30 days unless
  the harness says another) are deleted, or longer than `graceHours` (24 unless set) when neither agent has a window ([7.5](07-05-lifecycle-timers.md)). A Direct Message with a live agent is still removed by the messaging rule below.
- Orchestrator messages on a link whose newest message is older than the Admin's period (30 days unless the Admin
  sets another) are deleted, as are the messages of a session the server no longer holds and closed requests past the
  same period. Rights and requests about a reporter that has been removed go too. Deleting a session deletes its
  messages at once, after dropping any that were still held.
- The `reporters` table is kept, so a reporter outlives its sessions until the Admin removes it, or until the
  forget-by-age setting does. That setting is off by default. In the same hourly run, once the server has been
  up for an hour (so a long outage cannot empty the list before anyone reports), it removes reporters not heard
  from for `days` days (30 unless the Admin sets another) and writes a `reporters_forgotten` entry to the Admin
  log.
- Before it deletes anything, the same run writes the daily rollups (#484): for each day from the oldest
  retained session's day to today, it rebuilds that day's rows in `usage_daily`, `sessions_daily`,
  `failures_daily`, `fleet_daily`, `tools_daily`, `tool_sessions_daily`, `harness_versions_daily`, `tool_stats_daily`, `session_time_daily`, `agents_daily`, `person_sessions_daily`, `hour_peaks_daily`, `cost_daily`, `tool_cost_daily`, `feature_versions_daily`, `skills_daily` and `person_places_daily` from the rows still stored (a day that began before the session retention is
  skipped, since what is left of it would lower its figures, except the day the retention cutoff falls in: when no run
  has written it yet, as on the first run after an upgrade, it is written from what is left, so the oldest day can be
  partly built), in one transaction, so a run twice gives the
  same rows. A day whose raw rows are already gone is left as it is. Rollup rows older than 395 days are deleted.
  `peak_live_sessions` is the highest count of sessions live at one second, read from the day's samples while
  they last and never lowered once written (a day's figure only grows).
- A rollup holds no session content (see the schema). Admin > Server > Data lists each table, its row
  count, its oldest day and how long it is kept.
- The Activity history (#432) is purged by its own run every 5 minutes, not by this hourly one, because the
  Admin may keep it for hours. It lives in `activity.sqlite` and follows the Admin's policy
  ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md)). The hourly run also removes the entries of any session the main
  database no longer holds, so a session's own retention ends its history too (the shorter wins).
- Session recordings (#353) are purged by the same 5-minute run. Each part older than the Admin's *Keep a recording
  for* (6 hours by default, at most 7 days) is removed, and so are the parts of a session the main database no
  longer holds. A recording left with no entry is dropped only once it was started more than that long ago, and never
  while it is running and its session is live. The run compacts the file as for the Activity history, and writes one `recording_purged` entry to the
  Admin log per run that removes something, with counts and sizes and never text.

The thresholds are env-configurable: `RETAIN_SAMPLES_MS`, `RETAIN_EVENTS_MS`, `RETAIN_SESSIONS_MS`,
`RETAIN_ADMIN_LOG_MS` and `RETAIN_ROLLUP_MS` (395 days). `GET /api/admin/log` also returns the period as `retainMs`, and Admin > Admin log says
"Entries are kept for N days."

## PostgreSQL (#822)

`PODIUM_DB=postgres://user:password@host:5432/dbname` (or `postgresql://`) makes PostgreSQL the database
([DECISIONS 53](../../decisions/53-postgresql-is-the-second-storage-adapter-on-the-pg-driver-with-one-process-per.md)). The
database must exist and be empty or made by Podium; the server creates its schemas and tables and migrates them at start. The
tables above, and every rule that comes with them, hold on PostgreSQL as written, with these differences in how they are kept:

- **Two schemas in one database.** The main tables are in the schema `podium`. The Activity history (`entries`,
  `stored_sessions`, `loops`) and the recordings (`rec_sessions`, `rec_entries`) are in `podium_activity`, with their own
  connections, as they are in `activity.sqlite`. Each has its own `schema_migrations` table (`version`, `applied_at`) in place
  of `schema_migrations` in the main file and `PRAGMA user_version` in the Activity file.
- **One baseline migration.** Version 1 of each schema creates the end state of the SQLite migrations (migration 25 included).
  A later change is the next numbered step.
- **Types.** Times are `BIGINT` milliseconds, reals are `DOUBLE PRECISION`, ids that were `INTEGER PRIMARY KEY` are `BIGINT`
  identity columns, and flags stay 0/1 integers. A number the server reads is a JavaScript number; a whole number above
  `Number.MAX_SAFE_INTEGER` is an error.
- **Text compares as bytes.** Every text column is `COLLATE "C"`, and the case-folding the SQLite tables do with `lower()` uses
  `podium_lower`, which folds ASCII letters only.
- **Order.** Where two rows can tie, the order ends on `seq` or `id`: peer messages by `sent_at, seq`, person certificates by
  `issued_at DESC, seq DESC`, sessions by `started_at, id`, blowouts by `t, id`. SQLite migration 25 adds `seq` to
  `peer_messages` and `person_certificates` for it.
- **No pragmas, no VACUUM.** Autovacuum gives back space, and the Activity history's compaction does nothing.
- **Limits.** One server process for each database: the server holds a session advisory lock, and a second server on the same
  database stops at start. Podium does not move data from a SQLite file into PostgreSQL, and it supports no read replica or high
  availability. The password is never logged or returned by `/health`, which show `host:port/dbname`.

<!-- nav:start -->
---

Previous: [7.1 Endpoints](07-01-endpoints.md) · Up: [7. The server](README.md) · Next: [7.3 Ingest rules and derivation](07-03-ingest-rules-and-derivation.md)
<!-- nav:end -->
