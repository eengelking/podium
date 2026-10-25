---
title: "7.2 Database (SQLite)"
description: "The SQLite databases: path, pragmas, migrations and tables."
group: "Reference"
section: "7.2"
order: 2
---

# 7.2 Database (SQLite)

Path: `PODIUM_DB` env, default `<repo>/data/podium.sqlite` (add `data/` to `.gitignore`). Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`. Migrations are a numbered list applied in order and recorded in `schema_migrations`.

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
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);       -- allow_admin_secret_reporting: '1' (default) or '0'; feature.<id>: '0' once the Admin turns a feature flag off and '1' once on, an unset flag taking its default (on, except `respond`, `file-diff`, `peer-messaging`, `session-recording` and `activity-output`, which are off, #206, #319, #347, #353, #431); wall_notice.<id>: '0' once a notice is off; wall_show_background_sessions: '1' when on (default off); model_prices: JSON of only what the Admin changed from the built-in prices, `{ "<key>": { std?, long? } }` (#117); peer_settings: JSON of the orchestrator messaging limits and retention, `{ roundTrips, perMinute, maxChars, retainDays }` (#347); activity_history: JSON of the Admin's Activity history choice, `{ policy, n, unit, capGb }`, an unset row meaning `default` (#432); recording_settings: JSON of the session recording limits, `{ keepHours, budgetMb, sessionMb }`, an unset row meaning `{ 6, 4096, 512 }` (#353); the recordings themselves are in `activity.sqlite`, not here
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

Migration 15 (#206) links a session to the one it continues after a `/clear` (5.8):

```sql
ALTER TABLE sessions ADD COLUMN cleared_from TEXT;                        -- Report.session.clearedFrom; NULL when the session does not continue another
CREATE INDEX sessions_cleared_from ON sessions(cleared_from);             -- finds clearedInto for History
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

## What responding keeps, and where (#206)

Only two things reach the database: the `cleared_from` link above and the Admin's `feature.respond` setting.
Each answer is also written to `admin_log` ([7.7](07-07-hardening.md)) with who sent it, the session and the kind of
answer, never its text.

Everything else is held in the server's memory, in one store per live session, and never in the database, the
state body or the stream:

- the open asks, with their questions, plan text or tool input ([6.2](../06-reporter-protocol/06-02-the-report.md)), at most 8 per session;
- a closed ask's outcome (who answered and when, the terminal's answer summary), until the session goes idle
  with no open ask, for at most 10 minutes, or until its next ask opens;
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
  `failures_daily` and `fleet_daily` from the rows still stored (a day that began before the session retention is
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

<!-- nav:start -->
---

Previous: [7.1 Endpoints](07-01-endpoints.md) · Up: [7. The server](README.md) · Next: [7.3 Ingest rules and derivation](07-03-ingest-rules-and-derivation.md)
<!-- nav:end -->
