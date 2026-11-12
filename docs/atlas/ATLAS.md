---
title: "Atlas tables"
description: "A table of every part of Podium and every reporter hook, the key functions, the flows between them and where data lives."
group: Reference
---

# Atlas

A short reference to every part of Podium, for someone who wants the map before the detail. It is the text
companion to the interactive page [`docs/atlas/podium-atlas.html`](podium-atlas.html) (open it in a browser):
the first section lists the thirty-five parts on that page's system map, the second lists the reporter's hooks and
timers one by one, then the key functions, the flows between them, the four ways to run it and where data lives. The detail behind each row is in [Architecture](../architecture/README.md), [Server](../SERVER.md) and
[Reporter](../REPORTER.md); intended behavior is in [Spec](../spec/README.md).

Contents:

- [How to read the tables](#how-to-read-the-tables)
- [The parts](#the-parts)
- [The reporter's hooks and timers](#the-reporters-hooks-and-timers)
- [Key functions](#key-functions)
- [The flows](#the-flows)
- [Four ways to run it](#four-ways-to-run-it)
- [Where data lives](#where-data-lives)

## How to read the tables

**Location** is where the item runs:

| Location | Where it runs |
|---|---|
| Reporter | Inside each coding-harness process, on the machine that runs the session |
| Network | Between the two: a listener or a proxy that carries reports and browsers |
| Server | The Podium server process |
| Storage | The database behind the server: the two SQLite files, a PostgreSQL database or a MariaDB database |
| Console | The React page in your browser |

Sessions call out to the server; the server never calls in to a session. Anything the server wants a session
to do travels back in the reply to a report.

## The parts

### Reporter

| Location | Item | Description |
|---|---|---|
| Reporter | Hooks and reducers | The harness's callbacks on tool calls, turns and session start and end, folded into an in-memory model. They wait on nothing but a person's answer, a peer tool call and the final report. The plan and failure reducers are in `plugin/core/`; the session model and the hook wiring are in the Claude Code adapter today. Each reporter also counts, per session, the hooks that ran and the listed fields their events carried (`plugin/core/signals.ts`, at most 64 names) and sends them as `signals` with each report, so the server can tell which version of a harness stopped sending something: names and counts only. |
| Reporter | Transport and timer | A timer that posts a full snapshot and any unsent events to the server, and reads the reply, which can carry a callout for the person (`adminNotices`, shown once as a toast and, in Claude Code, a transcript line, and never sent to the model; in OpenCode a line above the prompt too). Backs off while the server is offline. `Transport` is in `plugin/core/`; the timer and the report builder are in the Claude Code adapter today. |
| Reporter | Coding harness session | The process being watched: one session of a coding harness (Claude Code or OpenCode) on a developer's machine, an orchestrator plus the agents it launches. Podium never wraps or replaces it. |
| Reporter | Harness adapter | The harness-specific half of a reporter. Today it is `plugin/claudecode/` (the hook wiring, the model and price table, the engine API use, `/podium` and the in-session tools) and `plugin/opencode/` (#855) is the OpenCode reporter: a plugin against `@opencode/plugin` that folds the event bus into one record per root session, flushes every second (the `flushIntervalMs` option, never below 200 ms), and reports effort (the model's variant), the context window (`window.ts`, from OpenCode's model list), skills, usage by model, failure detail and changed files, and with the matching consent a file diff on request, the activity feed and a shell call's output, full prompts and the session recording (the recorder, diff reader and feed budgets are the ones in `plugin/core/`), and `peers: true` when `PODIUM_PEERS` is on (#969). It adds the `plan` tool and, with `PODIUM_PEERS`, `podium_peers`, `podium_send`, `podium_request_access` and `podium_chat_read` (`tools.ts`, `peers.ts`), registers `/podium`, shows the connection's status and the answer to `/podium` as a toast (`notice.ts`, over a `notice` event on the plugin RPC bridge to the TUI part) and in the prompt's footer (a `status` event, and `statusSlot.ts` claims `prompt.footer.status`; #987), holds an Admin callout until the TUI part says it showed it (the `shown` call, offered again every 10 s until then; `ToastKeeper` shows it again after other toasts; `AdminBoard` keeps up to 5 lines above the prompt in `session.composer.top`, 10 minutes each; a headless session shows no callout), opens the settings window for `/podium config` (#1001: a `config` event on the bridge carries the live settings to the TUI part, `configWindow.ts`, which draws the window in the terminal of the session that asked and writes a changed setting to `~/.podium/config.env` itself, only from the person's own press in a dialog, through `writeSettingsLine` in `plugin/core/settingsWindow.ts`, which changes only allow-listed keys to a checked value; no bridge method writes a setting, on purpose, because any plugin or the model's shell could call a bridge route; the server, name and context rows are shown and never changed; with no TUI part attached the answer says where the settings are), says it is attached under an id of its own and says it is leaving when it closes (`attach`, `detach`; `attachment.ts` tracks the TUI parts, and when the last one detaches `Reporter.detached` ends every root that is not running, has no ask open and is not compacting at once with the reason `detached`, without the idle wait; a TUI killed outright still ends through the attach time limit and the idle wait, which are unchanged), takes the `/podium` words `allow`, `decline`, `deliver`, `name`, `context` and `config` (`command.ts`; `name` is kept in the plugin's storage), reads the dev-build stamp (`build.ts`), reports what an idle session still runs through the `experimental.idle` hook, offers the messaging tools only once Podium says the session takes part (`ctx.tool.reload`), and explains a failure through `ctx.experimental.generate` only with `PODIUM_EXPLAIN_FAILURES` on. It answers a question and a message from Podium where the person turned on `PODIUM_RESPOND` and `PODIUM_ACTIVITY_FEED`, and a permission and `/compact` too only at the respond level `everything` (`PODIUM_RESPOND` names the level: `questions`, `questions-and-plans` or `everything`, and `true` is `questions`; #858: `answering.ts` drives it from the flush tick, `plugin/core/respond.ts` does the announcing, waiting and reporting back, and the Claude Code adapter uses the same `Responder` (#971), `host.ts` calls OpenCode with a `msg_` id OpenCode accepts, and a question goes through the TUI part `tui.ts` when one is attached, otherwise through the local route in `service.json`; plan approval and `/clear` are not offered). Its settings are the plugin options, then the environment, then the defaults (server `http://127.0.0.1:4317`, idle 60 seconds, never below 5); a project's plugin options set only `idleSeconds`, `flushIntervalMs`, `heartbeatMs` (never below 1,000 ms), `sessionName` and `fileDiffPreload`, and every consent option comes from the environment and `~/.podium/config.env` only. Its secure connection (#948) is `plugin/opencode/tls.ts`, which finds the reporter config file in `~/.podium/` and connects over mutual TLS in-process through the shared client in `plugin/core/tls/`, is started once per location and is stopped when the last load closes; its TLS settings (`PODIUM_REPORTER_CONFIG`, `PODIUM_REPORTER_CONTEXT`) come only from the environment and `~/.podium/config.env`, never `opencode.json`. The Claude Code adapter's TLS link (`tlsLink.ts`) starts the helper script and talks to it. Everything shared is in `plugin/core/`, which an adapter imports and which never imports an adapter. `scripts/plugin-build.mjs` builds `dist/<harness>/` for each harness with a manifest (`claudecode` by its `.claude-plugin/plugin.json`, `opencode`, a package, by its `package.json`; the build leaves out the `*.node.test.ts` tests; CI's `test-opencode` job tests it), and the built folders `dist/claudecode/` and `dist/opencode/` are tracked on `main`: the release-prep PR rebuilds them (`npm run plugin:build:release`, which empties `dist/` first), and `scripts/plugin-dist-check.mjs` fails any PR into `main`, and any push to it, unless `dist/` is exactly a clean build of `plugin/` (same files and bytes, nothing extra, no dev stamp, every harness at the product version). A developer's stamped build goes to the git-ignored `dist-dev/`. `release.yml` runs the check, zips the tracked `dist/` and fails a release whose zip differs from it, for each harness. A release carries two archives, `podium-reporter-<version>.zip` and `podium-opencode-<version>.zip`, and a nightly both with `-nightly-<date>` added. OpenCode installs from `main` with `opencode plugin add "git+https://github.com/eengelking/podium.git#main::path:dist/opencode"`, or from the archive unzipped into `~/.config/opencode/plugins/podium/`. The marketplace entry is Claude Code's. |
| Reporter | In-session tools | How Podium reaches back into a session: answers to questions, plans and permission prompts, messages from your other orchestrators, and `/podium`. The peer message frame is in `plugin/core/`; the rest is in the Claude Code adapter. |
| Reporter | TLS helper | The mutual-TLS client every reporter shares (`plugin/core/tls/client.mjs`, #927) and the script around it that the Claude Code mod starts once per session (`plugin/core/tls/helper.mjs`: the Unix socket or, on Windows, the request folder, the `ready` line, the signals and the check that the parent is alive). It holds the client certificate, makes the mutual-TLS connection, renews the certificate under a lock several sessions share, and forwards only the routes in `plugin/core/tls/routes.mjs`, the one list the server's plain-HTTP gate imports too. The OpenCode reporter has no script: `plugin/opencode/tls.ts` runs the same client in its own process, from a reporter config file found in `~/.podium/` (never from `opencode.json`), starts it once per location and stops it on cleanup, and prints each problem once as a `podium-reporter: ...` line that also leads its status line. A reporter picks its config file by `PODIUM_REPORTER_CONFIG`, then `PODIUM_REPORTER_CONTEXT`, then the current context in `~/.podium/contexts.json`, then the newest `reporter-config-*.pem`. The Claude Code adapter keeps only `hooks/tlsLink.ts`, which starts the script and talks to it. |
| Reporter | Collectors | Small readers for what hooks do not carry: git branch, changed files, project root and repository name (`place.ts`), machine id and build (in `plugin/core/`), and models (in the Claude Code adapter). |
| Reporter | Activity, diff, recorder | Three opt-in readers that capture more than the wall needs: recent tool calls, a file diff (on request, or loaded ahead while the owner has the console page open), and a whole-session recording. Each is redacted and size-capped. The recorder (`recording.ts`), the diff reader (`fileDiff.ts`), the feed and its budgets (`feed.ts`) and diff redaction are in `plugin/core/`, shared by both reporters (#969); each adapter supplies the data from its own hooks or events. |
| Reporter | Simulator, settings hooks | Other ways to report: a simulator that fakes a busy fleet, and Claude Code's settings hooks for sessions started without the mod. |

### Network

| Location | Item | Description |
|---|---|---|
| Network | HTTP :4317 | The main listener: the console, the API, Admin, and reporters that send a token. Plain HTTP, bound to `127.0.0.1` by default. |
| Network | mTLS :4318 | Only with built-in TLS on. HTTPS that requires a client certificate from the Podium CA, and answers 404 to anything but reporter routes. A valid client certificate is trusted from the first connection; the HTTP reporter gate stays open until the first-run decision about reporters over HTTP is stored. |
| Network | Reverse proxy | Optional. Your own TLS-terminating proxy in front of the console, for a network you do not trust. |

### Server

| Location | Item | Description |
|---|---|---|
| Server | Ingest | Validates each report field by field, then stores it in one database transaction. A session id that starts with `person:`, is only dots or holds a pipe, a plus or a slash is refused (`badSessionId`), since Chat uses those to name a person's end and join two ends. A report may carry `signals`, counts of the hooks and event fields the harness sent the reporter (`hook:…` and `field:…`, at most 64 names); a name of another form is dropped, and a reporter older than 1.6.0 sends none. |
| Server | Fleet | Owns the set of live sessions and the clock, and turns rows into the `SessionView` every browser sees (state, context fill, cost). It takes one `Storage`, loads its settings in `init()` before the server listens, and sends every broadcast through one ordered queue. |
| Server | Sweeper | A one-second loop that marks quiet sessions stale, drops lost ones, removes ended ones and fills quiet seconds in the charts. A timer body whose previous run is still going is skipped. |
| Server | State and stream | `GET /state` for the first paint and `GET /stream`, a server-sent-events feed of changes: `snapshot`, `session`, `activity`, `removed`, `tick`, `wall`, `chat`, `replay` and `reads` (a counter only, sent when an Admin begins or keeps reading a session's ask or stored Activity; it names no one). |
| Server | Routers and identity | The routes for reports, hooks, state, stream and sessions, and the code that turns a certificate or token into an owner. |
| Server | Guard chain | Middleware that runs first on the HTTP port: Host check, security headers, the reporter HTTP gate, request log and the failed-request limiter. |
| Server | Admin API | A separate router for people, groups, reporters, settings, feature flags, certificates, usage reports (including a Tools report of tool calls, failure rate, permission prompts and call length across every harness, and Sessions and Usage reports of session time, waits on a person, agents and the busiest hours, and cost per tool call and per session, the token split and cache hit rate, the model and effort mix and how full the context was at the end, and a Harness updates report of the hooks, event fields and tool names a newer harness version stopped sending, the reporters behind the newest version and the platform of each reporter, with skills used on the Tools report and projects and branches per person on the Usage report), the Admin log and a read-only About page (`GET /api/admin/about`: versions, runtime, database engine, reporters in use) and `GET /api/admin/notice`, which tells an unlocked Admin how many features stopped after a harness update (the top bar's pill) without counting as Admin activity. The Admin flag `my-usage` (off by default; it also lets a browser sign in) opens a My usage page, `GET /api/fleet/respond/usage/:report` on the respond router, for the Spend, Sessions, Failures and Tools reports of the signed-in person only: the person comes from the respond session, never from the request, and an Admin gets their own figures too. |
| Server | Messaging service | Lets one person's orchestrators on different machines find and message each other, with rights, limits and an audit trail. It also carries Chat (`fleet.chat`, `ChatService`): the General and My group channels in their own tables, the Direct Messages a person can add to, and a person writing to another person's agent once that agent's owner allows it. An agent answers a person with `podium_send` to `person:<name>`, its own owner without any link, and an agent an `@` called into a channel can read its last hour with `podium_chat_read` (only that hour, only a channel it was called into, about 30,000 characters, framed as people's text) and answer there with `podium_send` to `channel:group` or `channel:general` (the address the message ends with; the server refuses the post, a 403, unless a delivered `@` of that session is stored in that channel within the last hour, after the per-agent rate limit; the answer shows to everyone who can read the channel). An Admin cannot write in another person's group. An Admin's reading of a person's group or Direct Message is recorded in `chat_admin_reads` (reading sessions end after 30 minutes without a read, and a reading is live for 30 seconds), and its people are told in the console, by a permanent record line and by a callout in their reporter sessions (a toast of 60 seconds on both harnesses). The `chat` stream event goes to the people in a thread when a reading starts or comes back and at every ping, not on a plain read. The callout for a reading is derived from the records of the last 5 minutes on every report, not pushed once, and a record is kept until each person it is owed to has seen it (`people` and `seen`). An Admin's read of a session's content is recorded in the same table under the threads `ask:<session>` and `activity:<session>:<loop>` (`AdminReads.noteSession`, before the content is sent; Admin log kinds `ask_read` and `activity_admin_read`, once per reading session, never the text), the stream carries a `reads` counter only, sent when a read begins and not at a ping (the owner's console reads again when the end of a reading it holds passes), and the owner's console reads `GET /api/fleet/respond/session-reads` and `GET /api/fleet/respond/sessions/:id/admin-reads/:kind`, while the Admin's open read posts `…/admin-reads/:kind/reading` every 15 seconds; the callout comes from the stored session's owner, so a session peer messaging does not know is told too. An Admin's read of a conversation between agents on the Admin and respond routes is recorded the same way before the text is answered (`ChatService.noteConversationRead`; the Admin router answers 503 where it cannot record). A person's Chat is read only in Chat: the Admin and respond routes that return a conversation's text refuse it, Traffic leaves it out, and a person's text goes to another person's agent only when its reporter declared `adminNotices: true` (`capabilities.adminNotices` in a v2 report, a top-level `adminNotices` in the v1 Claude Code report, held in memory by `RespondStore.adminNotices`) and takes messages from Podium. An Admin's stop or delete of a person's own things (a recording stopped or deleted, stored activity deleted, a session deleted, a token or all tokens revoked, a person deleted, a reporter removed) is recorded and told the same two ways: `fleet.adminActs` (`AdminActs`), called by the Admin API handlers and by `Fleet.deleteSessionAs` for a session deleted with the admin secret, writes a record first, so a failure to record stops the act, on the thread `act:<name>` in `chat_admin_reads` (seven more text kinds, no schema change) and pushes a callout to each of the person's live sessions in `adminNotices`; an Admin acting on their own things, or a session with no owner, records nothing, and a deleted person's live sessions are told but no record is kept. The person's overview carries `goneReads`, the unseen Admin records of a conversation that no longer exists, and the `act:` records above (newest first, at most 20, marked seen on load, never any text). Deleting a person forgets their Chat data, removes or trims the Admin records owed to them, and `DELETE /api/fleet/sessions/:id` deletes only the caller's own session. An Admin can also pause or resume any Direct Message link (the pause names the Admin), and an Admin's disconnect or reconnect of a person's group is recorded and told too and browse a person's Chat overview, names and counts only; a browse is recorded under `list:<name>` and told like a read. |
| Server | CA and certificates | Podium is its own certificate authority: it issues, renews and revokes the serving and per-person certificates, and rotates its CA. |
| Server | Live brokers | In-memory holders for the most sensitive live data: open asks, the live activity feed and pending diff requests. A restart forgets them. |
| Server | Logging and outside calls | Structured, redacted log events, optional shipping to VictoriaLogs, and a once-a-day check for a newer release. |

### Storage

| Location | Item | Description |
|---|---|---|
| Storage | Storage interface | The contract the app calls, and the only storage it knows: the async `Storage` interfaces written out in `server/src/storage/types.ts`, with the neutral row types, flag and notice tables and setting limits beside them (`rows.ts`, `features.ts`, `settings.ts`), and `openStorage` in `storage/index.ts`. The server reads `PODIUM_DB` once through `storageSpec` (an unknown kind throws at startup); `openStorage`, which is async, picks an adapter by kind from a registry (`DEFAULT_STORAGE_KIND` is `sqlite`; `postgres` and `mariadb` are the other kinds, and `postgresql://` is an alias for `postgres`; each kind declares its own default target, which `postgres` and `mariadb` do not have, and a `label()` for the log and the health check: `host:port/dbname`, never a user or password) and loads it on demand. `/health` shows that label as `dbPath` and the kind as `dbKind`. It names no database, and no app code opens one. The interface is fixed; the adapter behind it can be replaced. |
| Storage | SQLite adapter (the default) | One of three adapters, in `server/src/storage/sqlite/`. It implements the `Storage` interfaces and owns the SQL, the 42 numbered migrations, one lock per connection, and both database files. Options only it honors stay inside it (`vacuumPages` on `SqliteActivityHistoryOpts`). Migration 25 adds a `seq` column to `peer_messages` and `person_certificates`, an explicit insertion order that replaces SQLite's `rowid` on a tie. Migration 27 adds `reporter_name` to `reporters`, and a reporter's key carries it for any reporter but the Claude Code one (`podium-reporter-claudecode`, or the legacy `podium-reporter` read as the same, #967), so one machine can hold a row per reporter. Migration 28 adds `harness` and `cost_source` to `sessions`: the harness a session runs under (existing rows become `claude-code`) and `harness` when its cost is the harness's own figure, which ingest keeps as it came and never reprices. Migration 29 adds `capabilities_json`, `model_label` and `model_provider` to `sessions`: what a harness declares it can report, and its model's label and provider (empty until a report declares them). Migration 30 adds `model_label` and `model_provider` to `agents`, the same two for an agent (empty for every agent stored before it). Migration 31 is Chat (#1034): `author` and `hidden_at` on `peer_messages` (every earlier row is an agent's) and the tables `group_messages`, `public_messages` and `chat_read_state`. Migration 32 adds `paused_by` to `peer_rights`, who paused a person's link. Migration 33 adds `paused_by_admin` to `peer_rights` and the table `chat_admin_reads`, one row per Admin reading session (thread, Admin, start, last read; never text). Migration 34 adds `kind` to `chat_admin_reads`, so an Admin's removal of all messages, pause or resume stays on the record next to the readings. Migration 35 adds `people` and `seen` to `chat_admin_reads` (who a record is owed to and who has seen it, each a JSON list of folded names), so the record is kept until each of them has. Migration 36 adds `resume_window_days` to `sessions` (#1113): the days the session's harness lets a person resume it, which decides how long a hidden Direct Message is kept (empty until a report says). Migration 37 adds the daily rollup tables `tools_daily`, `tool_sessions_daily` and `harness_versions_daily` (#720): tool names and calls per harness, sessions by call-count bucket, and reporters by harness version, never a tool's input. Migration 38 adds `tool_stats_json` to `agents` and the daily table `tool_stats_daily` (#721): per tool, failed calls, permission asks and how they ended, and call lengths in buckets of 10%, counts only. Migration 39 adds `session_waits` and the daily tables `session_time_daily`, `agents_daily`, `person_sessions_daily` and `hour_peaks_daily` (#722): how long sessions ran and waited on their person, the agents they launched by type and depth, sessions per person, and the busiest hour of each day, names, counts and times only. Migration 40 adds `cost_daily` and `tool_cost_daily` (#723): per day, harness, model and effort the sessions, calls, priced cost, token split and how full the context was at the end, and per tool the sessions that called it and what they cost, names, counts and tokens only. Migration 41 adds `signals_json` to `sessions` and the daily tables `feature_versions_daily`, `skills_daily` and `person_places_daily` (#724): what each harness version sent a reporter (hook and event-field names with counts, never a value), the skills a person's sessions used, and the project and git branch they ran in, names and counts only. Migration 42 adds the daily table `answers_daily` (#725): per day, harness, kind of answer and wait class, how many answers were sent from Podium. It is written as each answer is taken, not rebuilt from the stored sessions, because nothing else keeps an answer; kinds, days and wait classes only, never what was said. |
| Storage | PostgreSQL adapter | The second adapter, in `server/src/storage/postgres/`, chosen when `PODIUM_DB` is a `postgres://` (or `postgresql://`) address (PostgreSQL 17, the one version tested; other versions are untested). It implements the same `Storage` interfaces over the `pg` driver, which only this folder imports, and passes the same contract suite. It keeps two schemas in one database, each on its own pool: `podium` (10 connections) and `podium_activity` (4 connections). Transactions run one at a time through `PgDb.tx`. A session advisory lock taken at startup keeps a second server off the database. Version 1 of each schema is a baseline and a later change is a new step: `podium` has seventeen so far (steps 7 to 11 are Chat; 9, 10 and 11 are `chat_admin_reads`, `paused_by_admin` and `people` and `seen`, as SQLite migrations 33, 34 and 35; step 12 is `resume_window_days` on `sessions`, as migration 36; step 13 is the three tool rollup tables, as migration 37; step 14 is `tool_stats_json` on `agents` and `tool_stats_daily`, as migration 38; step 15 is `session_waits` and the four session-time tables, as migration 39; step 16 is `cost_daily` and `tool_cost_daily`, as migration 40; step 17 is `signals_json` and the three tables of migration 41, as migration 41; step 18 is `answers_daily`, as migration 42), `podium_activity` none. |
| Storage | MariaDB adapter | The third adapter, in `server/src/storage/mariadb/`, chosen when `PODIUM_DB` is a `mariadb://` address (MariaDB 11.x, tested on 11.4; other versions are untested). It implements the same `Storage` interfaces over the official `mariadb` driver, which only this folder imports, and passes the same contract suite. It keeps every table in one database, on two pools: the main tables (10 connections) and the Activity tables `entries`, `stored_sessions`, `loops`, `rec_sessions` and `rec_entries` (4 connections), each set with its own record of steps (`schema_migrations`, `activity_schema_migrations`). Transactions run one at a time through `MariaDbConn.tx`. A named lock (`GET_LOCK`) taken at startup on a connection of its own, outside the pools, keeps a second server off the database. Its steps are PostgreSQL's, with the same numbers; MariaDB commits DDL on its own, so each statement can run again and a step is recorded after its last statement. Text is `utf8mb4` under `utf8mb4_nopad_bin` on every column, the database and each connection; a key column has a length (ids 255, reporter keys 383) and a longer value is an error. `asciiLower` folds ASCII letters only, as SQLite's `lower()` does. |
| Storage | `podium.sqlite` | The SQLite adapter's main file, reached only through the adapter: WAL mode, with the live fleet, people and certificates, reporters, messaging and Chat, daily rollups, settings and the Admin log. |
| Storage | `activity.sqlite` | The SQLite adapter's second file, for opt-in activity history and session recordings, on its own connection and its own lock. Nothing is written to it unless an Admin turns one of them on. |
| Storage | PostgreSQL database | The PostgreSQL adapter's database, used instead of the two SQLite files: one database with two schemas, `podium` (fleet, people, reporters, messaging, settings; a pool of 10 connections) and `podium_activity` (Activity history and recordings; a pool of 4). A session advisory lock keeps a second server off it. |
| Storage | MariaDB database | The MariaDB adapter's database, used instead of the two SQLite files: one database holding the main tables (a pool of 10 connections) and the Activity history and recordings (a pool of 4), under names that do not overlap. A named lock keeps a second server off it. |

### Console

| Location | Item | Description |
|---|---|---|
| Console | The wall | One card per session: model, effort, plan, agents, context fill, cost and branch, grouped by person. |
| Console | Live store | Loads `/state`, then applies stream messages with a pure reducer so every tab shows the same state. |
| Console | Orchestrator page | One orchestrator in detail: plan, changed files (their diffs loaded in the background), each agent's task and answer, failures and the live activity feed. Its owner sees a red notice and a record line when an Admin reads the ask or the stored Activity of the session (`SessionReadNotes`; an Admin's open Activity pings every 15 seconds). |
| Console | Respond modal | Lets a session's owner answer a question, approve a plan or a tool call, send a message, or run `/clear` and `/compact`. When an Admin opens an ask that is not theirs, its owner sees a red notice naming the Admin while the read is live and a permanent record line; the Admin's open ask pings every 15 seconds. |
| Console | Admin | The Admin pages, in four groups: people and access, server, reporting (including Harness updates), and activity. An unlocked Admin also sees a top-bar pill counting features that stopped after a harness update. |
| Console | Reporters, Chat, Replay | Rights between your orchestrators, Chat (channels, Direct Messages, people and agents, at `#/chat`, where an Admin can pick another person's Chat to read and sees a red banner on a thread being read), and a recorded session played back. Traffic, the old map of messages, is deprecated and `#/traffic` opens Chat. |

## The reporter's hooks and timers

These are the handlers the Claude Code adapter registers in `plugin/claudecode/hooks/register.ts`, so every name below is a
Claude Code hook (`classic.*` is Claude Code's own hook set, the others come from its mod API). A reporter for another
harness registers its own hooks in its own adapter. Each runs after Claude Code has done its own work, and an error in one
is logged and never passed on, so a bug in Podium cannot fail a tool call.

### Reporter

| Location | Item | Description |
|---|---|---|
| Reporter | `session.start` | Runs after Claude Code starts a session. Builds the session state, starts the TLS helper if configured, registers `/podium` and the `plan` tool, and starts the flush and git timers. |
| Reporter | `tool.call` | The main hook. Records each tool call's start and result for the cards and the feed. For `AskUserQuestion` and `ExitPlanMode` it can let an answer from Podium beat the terminal's dialog. |
| Reporter | `session.end` | Marks the session ended and sends one final report within a 1 s deadline, then stops the timers. After `/clear` it keeps them, because the process goes on under a new id. |
| Reporter | Flush timer | A timer that ticks every second. Each tick refreshes usage and agents and posts a report if something changed or the 5 s heartbeat is due. It keeps the card alive. |
| Reporter | `turn.step` | Records each step's usage and stop reason. When the activity feed or a recording is on, it also reads the text as it streams past and passes every chunk on unchanged. |
| Reporter | `turn.complete` | Records how a turn ended and its answer. |
| Reporter | `turn.start` | Marks a new turn and records the prompt. |
| Reporter | `classic.PermissionRequest` | Records a tool permission prompt, and answers it from Podium when responding is on and an answer arrives. |
| Reporter | `session.measure` | Takes the context fill, cost and rate limits Claude Code reports. |
| Reporter | `agent.spawn` | Records a subagent or fork when it starts: its model, type, task and parent. |
| Reporter | `tool.check` | Runs where a permission prompt is about to show, and checks that a permission request follows. If none does, the permission hooks are not running here. |
| Reporter | `session.compact` | Records a compaction and its before and after token counts. |
| Reporter | `classic.SessionStart`, `classic.UserPromptSubmit` | Carry Claude Code's own session title, so a `/rename` shows from the next prompt. Also notice a move to a new folder. |
| Reporter | Git timer | Reads the branch, ahead and behind counts and changed files every 10 s, and on every third run the Claude desktop app's title for the session (`claude agents --json`). |
| Reporter | `command.run` (`/podium`) | The `/podium` command: shows the link, the connection state and how the reporter signs in, says why messaging is on or off, names the session, and answers a messaging request. |
| Reporter | `command.run` (`/podium config`), `ui.render` (`Pane`, `podium-config`) | The settings window (#1001, `plugin/claudecode/hooks/configPane.tsx`, registered from `register.ts`). A second `command.run` hook takes the `config` word and opens the pane (the `/podium` hook above hands `config` on to it), and `ui.render` draws the pane's rows. Each control saves through `$.config.set` from the person's own pick, so consent changes only by the person's own press, and takes effect at the next start. |
| Reporter | `session.attach`, `session.detach` | A client joining or leaving: reads the list of attached clients at once, so a background session is told from one with someone on it. |
| Reporter | `skill.prompt` | Records a skill loading, unless a `Skill` tool call or a running agent already accounts for it. |
| Reporter | `classic.Notification`, `classic.Stop` | A notification from Claude Code, and the list of background work and scheduled wake-ups still running when a turn stops. |

### Server

| Location | Item | Description |
|---|---|---|
| Server | Sweeper | Removes a card after a `done` report (an 8 s linger) or after reports stop (stale at 15 s, dropped 60 s later). |
| Server | Hourly retention | Prunes stored data, and runs Chat's upkeep: Direct Messages are hidden when every agent in them has left (and shown again if the same peers return), channel messages older than 30 days are purged, hidden Direct Messages are purged after 24 hours, and the rate-limit keys of authors idle for a minute are forgotten. The limits are the Admin settings API's `chat` block. Admin read records older than the channel retention days, and those of a conversation that no longer exists, are purged too, except a record a person it is owed to has not yet seen. |

## Key functions

The functions and classes the interactive page points at, by part, most important first. The page is the
source for this section: `scripts/atlas-functions.mjs` writes the tables from its source references, and
`node scripts/atlas-functions.mjs --check` fails if they are out of date or if a named file or function is gone from the
code. A function's line number is on the page, not here, because it moves.

<!-- atlas-functions:start (generated by scripts/atlas-functions.mjs from docs/atlas/podium-atlas.html; edit the page, not this table) -->

### Reporter

| Location | Item | Description |
|---|---|---|
| Reporter | `class Reporter` | The OpenCode runtime, one transport per root, the flush tick, diffs, recording, failure explanations, the idle sweep and the bounded final flush. In `plugin/opencode/reporter.ts`. |
| Reporter | `takeAdminNotices` | Offers each admin callout to the TUI part as a toast, again every 10 s until the part says it was shown, and holds it while no TUI part is attached. In `plugin/opencode/reporter.ts`. |
| Reporter | `apply` | Folds one OpenCode bus event into a Store. In `plugin/opencode/state.ts`. |
| Reporter | `endQuiet` | Finishes every root that is quiet now (not running, no ask open, not compacting) with no idle wait, when the last TUI part detached. In `plugin/opencode/state.ts`. |
| Reporter | `detached` | The last TUI part left, so every quiet root ends at once with the reason detached. In `plugin/opencode/reporter.ts`. |
| Reporter | `class Attachments` | Which TUI parts are attached, each by its id; detach says whether it was the last. In `plugin/opencode/attachment.ts`. |
| Reporter | `buildReport` | A root as a v2 report with the harness block. In `plugin/opencode/report.ts`. |
| Reporter | `optionsOf` | Plugin options, then environment, then defaults. In `plugin/opencode/options.ts`. |
| Reporter | `class Answering` | Waits for answers to open asks and acts on messages and /compact, from the flush tick, up to the respond level. In `plugin/opencode/answering.ts`. |
| Reporter | `class Peers` | The messaging tools' calls, the peer messages that arrive as prompts, and the person's answers to a request. In `plugin/opencode/peers.ts`. |
| Reporter | `podiumTools` | The plan tool, and the four messaging tools where PODIUM_PEERS allows. In `plugin/opencode/tools.ts`. |
| Reporter | `messageIdFor` | The msg_ id OpenCode takes, made from a delivery id. In `plugin/opencode/host.ts`. |
| Reporter | `windowFromList` | A model's context window from ctx.model.list. In `plugin/opencode/window.ts`. |
| Reporter | `class StatusWatcher` | Turns a change in the connection's status into a toast. In `plugin/opencode/notice.ts`. |
| Reporter | `class ToastKeeper` | Shows an admin callout again, for the time it has left, after another toast replaced it. In `plugin/opencode/notice.ts`. |
| Reporter | `class AdminBoard` | The admin callouts kept as lines above the prompt, up to 5, 10 min each. In `plugin/opencode/notice.ts`. |
| Reporter | `toolName` | The Claude Code name for an OpenCode tool. In `plugin/opencode/activity.ts`. |
| Reporter | `runPodium` | Runs what was typed after /podium: allow, decline or deliver an id, config, context, name, else the status. In `plugin/opencode/command.ts`. |
| Reporter | `openConfigWindow` | Sends the live settings to an attached TUI part as a config event, or answers where the settings are. In `plugin/opencode/configWindow.ts`. |
| Reporter | `showConfig` | The TUI part draws the settings window; its dialog press is the only write. In `plugin/opencode/configWindow.ts`. |
| Reporter | `saveSetting` | Writes one allow-listed key to ~/.podium/config.env. In `plugin/opencode/configWindow.ts`. |
| Reporter | `registerConfigPane` | The /podium config hook and the settings pane, saved through $.config.set. In `plugin/claudecode/hooks/configPane.tsx`. |
| Reporter | `writeSettingsLine` | Changes one allow-listed key in the settings file, to a checked value. In `plugin/core/settingsWindow.ts`. |
| Reporter | `mountStatus` | Claims the prompt.footer.status slot for the connection's status line, or null when the host cannot. In `plugin/opencode/statusSlot.ts`. |
| Reporter | `mountBanner` | Claims the session.composer.top slot for the admin board, or null when the host cannot. In `plugin/opencode/statusSlot.ts`. |
| Reporter | `buildOf` | The dev build stamped into the built folder, or null for a release. In `plugin/opencode/build.ts`. |
| Reporter | `setBackground` | The shell or subagent an idle root still runs, as a background wait. In `plugin/opencode/state.ts`. |
| Reporter | `class Responder` | Announces an ask, waits for its answer, and reports deliveries and closes. In `plugin/core/respond.ts`. |
| Reporter | `register` | The adapter's entry point, wires every hook. In `plugin/claudecode/hooks/register.ts`. |
| Reporter | `registerPeerTools` | Podium_peers, podium_send, podium_request_access and podium_chat_read. In `plugin/claudecode/hooks/register.ts`. |
| Reporter | `newSession` | Creates the in-memory model of a session. In `plugin/claudecode/hooks/state.ts`. |
| Reporter | `addEvent` | Adds an event to the model's queue for the next report. In `plugin/claudecode/hooks/state.ts`. |
| Reporter | `taskCreate` | Plan from TaskCreate. In `plugin/core/plan.ts`. |
| Reporter | `taskUpdate` | Plan from TaskUpdate. In `plugin/core/plan.ts`. |
| Reporter | `redact` | Replaces secret-shaped text with [redacted]. In `plugin/core/failures.ts`. |
| Reporter | `class Transport` | Posts a report, backs off, reads the reply. In `plugin/core/transport.ts`. |
| Reporter | `class AdminNoticeSeen` | Shows each admin callout once; has and add serve a harness that is told when one was shown. In `plugin/core/adminNotice.ts`. |
| Reporter | `handleAdminNotices` | A toast and a transcript line for each new callout. In `plugin/claudecode/hooks/register.ts`. |
| Reporter | `due()` | Whether a report goes now (changed, or heartbeat due, and no backoff). In `plugin/core/transport.ts`. |
| Reporter | `flush` | The timer's entry point; posts a report if one is due. In `plugin/claudecode/hooks/register.ts`. |
| Reporter | `flushOnce` | Builds and posts one report, then reads the reply. In `plugin/claudecode/hooks/register.ts`. |
| Reporter | `buildReport` | Builds the report: a full snapshot plus unsent events. In `plugin/claudecode/hooks/report.ts`. |
| Reporter | `questionRace` | A question's answer from Podium races the terminal's dialog. In `plugin/claudecode/hooks/register.ts`. |
| Reporter | `planRace` | The same race for a plan's approval or feedback. In `plugin/claudecode/hooks/register.ts`. |
| Reporter | `permissionAsk` | A tool's permission prompt, answered from Podium. In `plugin/claudecode/hooks/register.ts`. |
| Reporter | `handleDeliveries` | Acts on the answers and messages in a reply. In `plugin/claudecode/hooks/register.ts`. |
| Reporter | `toolDecision` | Turns an answer from Podium into a hook result. In `plugin/claudecode/hooks/respond.ts`. |
| Reporter | `planApproval` | The hook result that approves a plan. In `plugin/claudecode/hooks/respond.ts`. |
| Reporter | `chatReadTool` | Podium_chat_read, the last hour of a channel the agent was called into. In `plugin/claudecode/hooks/register.ts`. |
| Reporter | `sendPeerCalls` | Sends a messaging tool's queued calls, run by the timer. In `plugin/claudecode/hooks/register.ts`. |
| Reporter | `peerPrompt` | The frame around a peer message. In `plugin/core/peers.ts`. |
| Reporter | `withChatHint` | Adds where to answer, or where to read and answer around an @, to a message from Chat. In `plugin/core/peers.ts`. |
| Reporter | `channelSendTarget` | Turns podium_send to channel:group or channel:general into a post to that channel. In `plugin/core/peers.ts`. |
| Reporter | `chatReadAnswer` | The framed answer podium_chat_read gives, people's text quoted. In `plugin/core/peers.ts`. |
| Reporter | `createTlsClient` | The mutual-TLS client every reporter shares (guard, open, request, fetch, start, stop, status). In `plugin/core/tls/client.mjs`. |
| Reporter | `dueSoon` | Whether the certificate is close enough to expiry to renew. In `plugin/core/tls/client.mjs`. |
| Reporter | `withLock` | The cross-process lock a renewal runs under. In `plugin/core/tls/lock.mjs`. |
| Reporter | `parseConfig` | Reads the reporter config file. In `plugin/core/tls/config.mjs`. |
| Reporter | `serveMailbox` | On Windows, answers request files in a folder. In `plugin/core/tls/helper.mjs`. |
| Reporter | `openLink` | Finds the reporter config file and connects in the OpenCode process through core's client. In `plugin/opencode/tls.ts`. |
| Reporter | `startLink` | Starts the helper script for a Claude Code session. In `plugin/claudecode/hooks/tlsLink.ts`. |
| Reporter | `readGit` | Branch, ahead/behind. In `plugin/core/git.ts`. |
| Reporter | `readChanges` | Changed files with +/- counts. In `plugin/core/git.ts`. |
| Reporter | `machineIdPath` | Where the random machine id is kept. In `plugin/core/machine.ts`. |
| Reporter | `osFromSwVers` | Reads the macOS version. In `plugin/core/machine.ts`. |
| Reporter | `gitPlace` | The project root (a worktree reports its main checkout) and owner/name from the origin remote. In `plugin/core/place.ts`. |
| Reporter | `repoFromRemote` | Owner/name from an origin URL. In `plugin/core/place.ts`. |
| Reporter | `class Recorder` | Numbers, redacts and batches a session recording, for either harness. In `plugin/core/recording.ts`. |
| Reporter | `readFileDiff` | Reads one changed file's diff, for either harness. In `plugin/core/fileDiff.ts`. |
| Reporter | `feedOf` | The activity entries that go out, with a shell call's output only when allowed. In `plugin/core/feed.ts`. |
| Reporter | `handleDiffs` | Reads one file's diff when its owner asks or the console loads it ahead. In `plugin/claudecode/hooks/register.ts`. |
| Reporter | `redactDiff` | Replaces secret-shaped text in a diff. In `plugin/core/diffRedact.ts`. |
| Reporter | `setWatched` | Records which loops someone is watching. In `plugin/claudecode/hooks/state.ts`. |
| Reporter | `ingestHook` | Takes a settings-hook report, giving a reduced view. In `server/src/fleet/fleet.ts`. |

### Network

| Location | Item | Description |
|---|---|---|
| Network | `class TlsBoot` | Holds the listener from the turn it serves; the HTTP gate is active only once the seed is stored. In `server/src/tlsBoot.ts`. |
| Network | `startTls` | Starts the mutual-TLS listener. In `server/src/tlsServer.ts`. |
| Network | `reporterPortOnly` | Answers 404 to any path that is not a reporter route. In `server/src/tlsServer.ts`. |

### Server

| Location | Item | Description |
|---|---|---|
| Server | `validateReport` | Checks every field of a report by hand. In `server/src/fleet/protocol.ts`. |
| Server | `ingestReport` | Stores a validated report in one transaction, and adds up the time a session waits on its person. In `server/src/fleet/ingest.ts`. |
| Server | `waitKindOf` | Whether a session is blocked on its person, and for what (a permission, a question or a plan). In `server/src/fleet/waits.ts`. |
| Server | `advanceWait` | Adds the time of a finished wait to the session's totals as reports arrive. In `server/src/fleet/waits.ts`. |
| Server | `class Fleet` | The live set, the clock and the views, over one Storage. In `server/src/fleet/fleet.ts`. |
| Server | `init` | Loads the stored settings and the live candidates; the server listens only after it. In `server/src/fleet/fleet.ts`. |
| Server | `noteOrchestrator` | Puts the reporter in the peer directory, in the session's own serial turn. In `server/src/fleet/fleet.ts`. |
| Server | `state()` | The snapshot for a browser's first paint. In `server/src/fleet/fleet.ts`. |
| Server | `sessionReadsChanged` | Tells open consoles with a counter that an Admin began or kept reading a session. In `server/src/fleet/fleet.ts`. |
| Server | `enqueue` | Every broadcast goes through one ordered queue. In `server/src/fleet/fleet.ts`. |
| Server | `flush` | Waits until every queued message is sent; shutdown calls it before the databases close. In `server/src/fleet/fleet.ts`. |
| Server | `class Serializer` | One turn at a time per session id, and exclusive jobs for sweeps. In `server/src/fleet/serial.ts`. |
| Server | `class LiveFeatureFlags` | A write-through cache, read synchronously and written asynchronously. In `server/src/fleet/liveSettings.ts`. |
| Server | `sessionView` | Turns database rows into the SessionView the browsers get. In `server/src/fleet/derive.ts`. |
| Server | `sessionStatus` | Done, stale (silent too long) or the status last reported. In `server/src/fleet/derive.ts`. |
| Server | `startSweeper` | The one-second housekeeping loop; a timer body is skipped while its previous run is still going. In `server/src/fleet/sweeper.ts`. |
| Server | `purgeActivityHistory` | Removes stored activity past its retention. In `server/src/fleet/sweeper.ts`. |
| Server | `purgeRecordings` | Removes recordings past their retention. In `server/src/fleet/sweeper.ts`. |
| Server | `class SseHub` | The open browser streams, and broadcasts to them. In `server/src/fleet/sse.ts`. |
| Server | `SseEventName` | The stream's event names, with chat, replay and reads. In `server/src/fleet/sse.ts`. |
| Server | `replayChanged` | Tells open consoles an Admin's replay opened, paged or ended, with a counter and nothing else. In `server/src/fleet/fleet.ts`. |
| Server | `requireToken` | Turns a token, the admin secret or open access into an owner. In `server/src/fleet/routes.ts`. |
| Server | `certAuth` | Checks the client certificate on every request. In `server/src/tlsClientAuth.ts`. |
| Server | `tokenMatches` | Compares a token in constant time. In `server/src/fleet/tokens.ts`. |
| Server | `reporterHttpGate` | Refuses plain-HTTP reporters once an Admin turns them off. In `server/src/tlsHttp.ts`. |
| Server | `securityHeaders` | Security headers and the Content-Security-Policy. In `server/src/securityHeaders.ts`. |
| Server | `createAdminRouter` | The Admin API with its own sign-in and log. In `server/src/admin/adminRouter.ts`. |
| Server | `buildAbout` | The read-only About page: runtime, versions, the database engine and the reporters in use. In `server/src/admin/about.ts`. |
| Server | `class Lockout` | Locks an address out after five wrong tries. In `server/src/fleet/lockout.ts`. |
| Server | `class PeerService` | Finds live orchestrators and carries messages. In `server/src/storage/sqlite/peerService.ts`. |
| Server | `class PeerRights` | Who may message whom, and the limits. In `server/src/storage/sqlite/peerRights.ts`. |
| Server | `pair` | The same-owner rule for messaging rights. In `server/src/storage/sqlite/peerRights.ts`. |
| Server | `class PeerMessages` | Stores, checks and hands over messages. In `server/src/storage/sqlite/peerMessages.ts`. |
| Server | `peerReplyFor` | The messaging items that ride a report's reply. In `server/src/fleet/peerRoutes.ts`. |
| Server | `class ChatService` | Chat's overview, read state and hourly upkeep. In `server/src/fleet/chat.ts`. |
| Server | `noteConversationRead` | Records an Admin's read of a conversation between agents outside Chat and tells its people. In `server/src/fleet/chat.ts`. |
| Server | `mountChatBrowserRoutes` | The Chat routes under /api/fleet/respond/chat. In `server/src/fleet/chatRoutes.ts`. |
| Server | `mountChatAgentRoutes` | An agent's routes to a channel. In `server/src/fleet/chatAgentRoutes.ts`. |
| Server | `class ChannelChat` | General and My group. In `server/src/fleet/chatChannels.ts`. |
| Server | `agentRead` | The last hour of a channel, only if the agent was called into it. In `server/src/fleet/chatChannels.ts`. |
| Server | `agentPost` | An agent's answer in a channel, only if it was called into it in the last hour. In `server/src/fleet/chatChannels.ts`. |
| Server | `class DirectChat` | Direct Messages, across-person writes, hide and purge. In `server/src/fleet/chatDirect.ts`. |
| Server | `class ChatCore` | The shared limits, signal and store. In `server/src/fleet/chatCore.ts`. |
| Server | `class AdminActs` | Tells a person when an Admin stops or deletes their recording, stored activity, session, access or reporter. In `server/src/fleet/adminActs.ts`. |
| Server | `class AdminReads` | Records an Admin's reading of a person's group, Direct Message or session replay and tells its people. In `server/src/fleet/chatAdminReads.ts`. |
| Server | `note` | Records a read and signals the chat stream when a reading starts or comes back and at every ping, not on a plain read. In `server/src/fleet/chatAdminReads.ts`. |
| Server | `noteReplay` | Records an Admin's replay of someone else's recorded session under the thread replay:<sessionId>, and says whether a person was told. In `server/src/fleet/chatAdminReads.ts`. |
| Server | `replayersOf` | The Admins replaying a person's own sessions now, by session id, never any text. In `server/src/fleet/chatAdminReads.ts`. |
| Server | `noteSession` | Records an Admin's read of a session that is someone else's (an ask, one loop's stored Activity, an agent's whole text, its live Activity) before it is answered, and tells the owner. In `server/src/fleet/chatAdminReads.ts`. |
| Server | `sessionReadersOf` | The Admins reading a person's own sessions now, by kind and session; never text. In `server/src/fleet/chatAdminReads.ts`. |
| Server | `sessionRecordsOf` | The records of one kind of read of a session, for its owner, marking them seen. In `server/src/fleet/chatAdminReads.ts`. |
| Server | `parseSessionThread` | The kind, session and loop of a session-read thread. In `server/src/fleet/sessionReads.ts`. |
| Server | `mountSessionReadRoutes` | The owner's three browser routes for who is reading a session of theirs. In `server/src/fleet/sessionReadRoutes.ts`. |
| Server | `runMyReport` | One report for one person, the person a required argument. In `server/src/fleet/reports.ts`. |
| Server | `class AdminNotices` | The content-free callouts a session's next reply carries. In `server/src/fleet/chatAdminNotices.ts`. |
| Server | `acrossTarget` | Whether a person's text may go to another person's agent. In `server/src/fleet/chatDirect.ts`. |
| Server | `adminNotices` | Whether the session's reporter declared the Admin callout. In `server/src/fleet/respond.ts`. |
| Server | `goneReadsOf` | The unseen records of deleted conversations, marked seen. In `server/src/fleet/chat.ts`. |
| Server | `withoutPerson` | What deleting a person does to an Admin record. In `server/src/storage/chatRows.ts`. |
| Server | `ensureTls` | Makes or reads the CA. In `server/src/tlsCa.ts`. |
| Server | `issueServing` | The serving certificate. In `server/src/tlsCa.ts`. |
| Server | `issuePersonCert` | A person's client certificate. In `server/src/tlsPeople.ts`. |
| Server | `signClientCert` | Signs a person's key with the CA. In `server/src/tlsPeople.ts`. |
| Server | `buildReporterConfig` | Builds the config file a person downloads. In `server/src/tlsPeople.ts`. |
| Server | `class ServingRenewer` | Renews the serving certificate without a restart. In `server/src/tlsRenew.ts`. |
| Server | `authorizeRenewal` | Who may renew, from the verified certificate (no grace once expired). In `server/src/tlsReporterRenew.ts`. |
| Server | `rotateCa` | Replaces the CA, with an overlap so old reporters keep working. In `server/src/tlsRotation.ts`. |
| Server | `class TrustStore` | The one list of CAs the server trusts. In `server/src/tlsRotation.ts`. |
| Server | `class RespondStore` | Open asks and their answers, in memory. In `server/src/fleet/respond.ts`. |
| Server | `class ActivityStore` | Leases and the last 20 entries per loop. In `server/src/fleet/activity.ts`. |
| Server | `class DiffBroker` | Holds a diff request for 15 s. In `server/src/fleet/fileDiffs.ts`. |
| Server | `scrub` | Removes secret shapes from every logged string. In `server/src/logging/redact.ts`. |
| Server | `startUpdateCheck` | The once-a-day check for a newer release. In `server/src/fleet/updateCheck.ts`. |

### Storage

| Location | Item | Description |
|---|---|---|
| Storage | `Storage` | The async store interfaces the app layer uses, and tx. In `server/src/storage/types.ts`. |
| Storage | `storageSpec` | Reads PODIUM_DB once into a kind, a target and a label; an unknown kind throws. In `server/src/storage/index.ts`. |
| Storage | `openStorage` | Async; loads the chosen kind's adapter on demand. In `server/src/storage/index.ts`. |
| Storage | `registerStorageKind` | Adds an implementation to the registry. In `server/src/storage/index.ts`. |
| Storage | `StorageKind` | What a registered kind declares: fileBased, defaultTarget(), load and label(). In `server/src/storage/index.ts`. |
| Storage | `defaultDbFile` | The default kind's default target, taken from the registry. In `server/src/storage/index.ts`. |
| Storage | `dataDir` | PODIUM_DATA_DIR, else a file target's folder; holds tls/. In `server/src/storage/index.ts`. |
| Storage | `runStorageContract` | The suite every implementation must pass. In `server/src/storage/contract.ts`. |
| Storage | `health` | The /health answer; dbPath is the database label and dbKind its kind. In `server/src/fleet/fleet.ts`. |
| Storage | `class AsyncLock` | One queue per connection; a call inside its own transaction runs directly. In `server/src/storage/lock.ts`. |
| Storage | `openSqliteStorage` | Builds every store on one connection, each call behind one lock. In `server/src/storage/sqlite/index.ts`. |
| Storage | `class ActivityConnection` | The activity file's own connection and lock. In `server/src/storage/sqlite/activity.ts`. |
| Storage | `SqliteActivityHistoryOpts` | The neutral history options plus what only this adapter honors (vacuumPages). In `server/src/storage/sqlite/activityHistory.ts`. |
| Storage | `class SessionRecordings` | Stores recordings within their caps. In `server/src/storage/sqlite/recordings.ts`. |
| Storage | `sqliteContractAdapter` | The SQLite adapter as the storage tests see it. In `server/src/storage/sqlite/contractAdapter.ts`. |
| Storage | `postgresContractAdapter` | The PostgreSQL adapter as the storage tests see it. In `server/src/storage/postgres/contractAdapter.ts`. |
| Storage | `openPostgresStorage` | Takes the single-process lock, migrates both schemas and builds every store. In `server/src/storage/postgres/index.ts`. |
| Storage | `class PgDb` | One pool; tx takes transactions one at a time and a call inside one joins it. In `server/src/storage/postgres/conn.ts`. |
| Storage | `numbered` | Turns the SQLite stores' ? and :name placeholders into $n. In `server/src/storage/postgres/conn.ts`. |
| Storage | `toSafeNumber` | Bigint and numeric as numbers; an unsafe integer is an error. In `server/src/storage/postgres/conn.ts`. |
| Storage | `acquireSingleProcessLock` | A session advisory lock; a second server refuses to start. In `server/src/storage/postgres/singleProcess.ts`. |
| Storage | `migrate` | Applies the steps not yet in schema_migrations. In `server/src/storage/postgres/schema.ts`. |
| Storage | `class PgActivityConnection` | The Activity history and recordings on their own pool. In `server/src/storage/postgres/activity.ts`. |
| Storage | `mariadbContractAdapter` | The MariaDB adapter as the storage tests see it. In `server/src/storage/mariadb/contractAdapter.ts`. |
| Storage | `openMariaDbStorage` | Takes the single-process lock, migrates both sets of tables and builds every store. In `server/src/storage/mariadb/index.ts`. |
| Storage | `class MariaDbConn` | One pool; tx takes transactions one at a time and a call inside one joins it. In `server/src/storage/mariadb/conn.ts`. |
| Storage | `positional` | Turns the stores' :name placeholders into ? and quotes the column names MariaDB reserves. In `server/src/storage/mariadb/conn.ts`. |
| Storage | `bound` | NaN as NULL, a NUL removed, a lone surrogate as U+FFFD, an infinity refused. In `server/src/storage/mariadb/conn.ts`. |
| Storage | `toSafeNumber` | Bigint and DECIMAL as numbers; an unsafe integer is an error. In `server/src/storage/mariadb/conn.ts`. |
| Storage | `asciiLower` | Folds ASCII letters only, as SQLite's lower() does. In `server/src/storage/mariadb/conn.ts`. |
| Storage | `acquireSingleProcessLock` | A named lock on a connection of its own; a second server refuses to start. In `server/src/storage/mariadb/singleProcess.ts`. |
| Storage | `class MariaActivityConnection` | The Activity history and recordings on their own pool. In `server/src/storage/mariadb/activity.ts`. |
| Storage | `migrate` | Applies the steps not yet recorded, statement by statement, and records each step last. In `server/src/storage/mariadb/schema.ts`. |
| Storage | `parseTarget` | Reads a mariadb:// URL; only ssl=true or ssl=false may follow it. In `server/src/storage/mariadb/conn.ts`. |
| Storage | `singleProcessLockName` | The lock's name, podium: followed by a hash of the database name. In `server/src/storage/mariadb/conn.ts`. |
| Storage | `mariaChat` | The Chat tables over MariaDB. In `server/src/storage/mariadb/chat.ts`. |
| Storage | `openDb` | Opens the main file, sets WAL and applies the migrations. In `server/src/storage/sqlite/db.ts`. |
| Storage | `chatStoreOver` | The Chat tables over one connection. In `server/src/storage/sqlite/chat.ts`. |
| Storage | `openActivityDb` | Opens the activity file, sets incremental vacuum and WAL, applies its steps. In `server/src/storage/sqlite/activityDb.ts`. |
| Storage | `activityDbPath` | The activity file's path, beside the main one. In `server/src/storage/sqlite/activityDb.ts`. |
| Storage | `migrate` | Applies the steps not yet in schema_migrations. In `server/src/storage/postgres/schema.ts`. |
| Storage | `pgChat` | The Chat tables over PostgreSQL (steps 7 to 11). In `server/src/storage/postgres/chat.ts`. |

### Console

| Location | Item | Description |
|---|---|---|
| Console | `SessionCard` | One session as a card. In `frontend/src/fleet/components/SessionCard.tsx`. |
| Console | `sortSessions` | The wall's sort order. In `frontend/src/fleet/logic.ts`. |
| Console | `filterSessions` | The wall's filters. In `frontend/src/fleet/logic.ts`. |
| Console | `planProgress` | Steps done out of steps total. In `frontend/src/fleet/logic.ts`. |
| Console | `useFleet` | Loads /state, then follows /stream. In `frontend/src/fleet/useFleet.ts`. |
| Console | `fleetReducer` | Applies each stream message to the state. In `frontend/src/fleet/store.ts`. |
| Console | `visibleSessions` | What the current filter shows. In `frontend/src/fleet/store.ts`. |
| Console | `OrchestratorDetail` | Plan, files, agents and activity for one orchestrator. In `frontend/src/fleet/components/OrchestratorDetail.tsx`. |
| Console | `readEvery` | How often the activity feed polls. In `frontend/src/fleet/useActivityFeed.ts`. |
| Console | `class DiffPreloader` | Loads every changed file's diff in page memory, 2 at a time. In `frontend/src/fleet/diffPreload.ts`. |
| Console | `RespondModal` | Answer a question, plan or permission prompt. In `frontend/src/fleet/components/Respond.tsx`. |
| Console | `SessionsPage` | Admin > Reporting > Sessions, with the time, reason, agents, depth, answers and answer wait breakdowns. In `frontend/src/fleet/admin/TimePages.tsx`. |
| Console | `UsagePage` | Admin > Reporting > Usage, with the person and hour (busiest hours) breakdowns. In `frontend/src/fleet/admin/TimePages.tsx`. |
| Console | `ChatPage` | Channels, Direct Messages and a thread. In `frontend/src/fleet/Chat.tsx`. |
| Console | `useChatOverview` | Reads the overview again when the chat event moves, and keeps the records of deleted conversations (gone) even from a read a newer one replaced. In `frontend/src/fleet/useChat.ts`. |
| Console | `useReadingPing` | An Admin's open ask, Activity, whole text or live feed posts a reading every 15 seconds. In `frontend/src/fleet/sessionReads.tsx`. |
| Console | `SessionReadNotes` | The red notice and record lines the owner sees when an Admin reads their ask or Activity. In `frontend/src/fleet/components/SessionReadNotes.tsx`. |
| Console | `GoneRecordLines` | The quiet lines for records of a deleted conversation. In `frontend/src/fleet/components/ChatAdmin.tsx`. |
| Console | `ReadPicker` | An Admin picks whose Chat to read. In `frontend/src/fleet/components/ChatAdmin.tsx`. |
| Console | `useSlashCommands` | The slash-command list and its checks for a message box. In `frontend/src/fleet/components/SlashCommands.tsx`. |
| Console | `MyReportersPage` | Rights between your orchestrators. In `frontend/src/fleet/MyReporters.tsx`. |
| Console | `TrafficPage` | The map of messages between machines. In `frontend/src/fleet/Traffic.tsx`. |
| Console | `ReplayPage` | A recorded session played back. In `frontend/src/fleet/components/ReplayPage.tsx`. |

<!-- atlas-functions:end -->

## The flows

Six operations the atlas page walks step by step. Each row gives the steps in order.

| Flow | What it does | Steps |
|---|---|---|
| A session reports in | Moves one session's state from a hook to a card on the wall. The heartbeat of the product. | A hook updates the in-memory model; a timer takes a snapshot; it posts to the server; the guards run; the credential becomes an owner; the report is validated and stored in one transaction; the reply carries instructions back; Fleet derives the view; it is pushed to every open browser; the wall repaints. |
| Watching an agent live | Shows an agent's recent activity while someone looks. Capture is leased, not stored. | You open the agent's panel; the server takes out a lease; the next reply lists the loops to watch; the mod reads their tool calls and text; entries ride the next report; the panel fills, and closing it stops capture. |
| Answering a waiting session | The one place Podium acts. It answers a question, plan or permission prompt. | The session stops at a prompt and the mod holds the hook open; it is reported as an open ask; the server holds it in memory for its owner; the owner signs in and answers; the answer waits for the next reply; the mod turns it into the held hook's result. |
| One orchestrator messages another | Cross-machine messages between one person's orchestrators, with rights and an audit trail. | A session calls `podium_send`; the timer sends it; the server resolves the target and checks rights and limits; the message is stored as ready or awaiting approval; it is handed over when the target is idle; the mod frames it, submits it as a prompt and reports the result; in Chat the exchange is a Direct Message that the person who owns an agent can add to, and the agent can answer its own owner there with `podium_send` to `person:<owner>`. |
| Recording and replaying | Records a whole session and plays it back. The most sensitive feature has the most switches. | Three yeses start it (Admin switch, owner's choice, reporter option); the recorder redacts and numbers entries; batches go up every five seconds; the owner or an Admin replays it, and an Admin's replay of someone else's session is recorded and the owner is told; the sweeper purges it on schedule. |
| Securing the reporter link | Mutual TLS, from creating a person to a revoked certificate. | An Admin creates a person; the server issues a certificate; the config file is shown once; the Claude Code mod starts the TLS helper (the OpenCode reporter runs the same client in its own process); the handshake needs a certificate; it is checked again on every request; it renews itself. |

## Four ways to run it

| Mode | Who it is for | What protects it | What to know |
|---|---|---|---|
| Just you | One person on one machine. | Loopback only: `127.0.0.1:4317`, so only this machine can reach the port. | A token still guards reports, deletes and Admin. Not for sharing. |
| Team on a LAN | A team on a network you trust. | Per-person tokens give each session an owner, and the Host check blocks DNS rebinding. | Tokens and reports cross the network as plain HTTP, and anyone who can reach the port can read the console. |
| Built-in mutual TLS | A team that wants reporters encrypted and authenticated. | Port 4318 requires a client certificate from the Podium CA. Revoke one without touching the rest. | The console is still plain HTTP. If reporters already existed, plain HTTP stays allowed until an Admin turns it off. |
| Behind a TLS proxy | Anyone who wants browsers and reporters on ordinary HTTPS. | Your proxy terminates TLS with a real certificate. | Set `PODIUM_TRUST_PROXY` to a proxy that overwrites `X-Forwarded-For`, or clients can choose their own address. |

## Where data lives

| Location | Item | Description |
|---|---|---|
| Server | Memory only: open asks and answers, the live activity feed, diff requests, the messaging directory, Admin sessions, the update notice | The most sensitive live data. Gone on restart, on purpose. |
| Storage | `podium.sqlite` | The SQLite adapter's main file, in WAL mode. The app reaches it only through the `Storage` interface and the adapter, which owns it: the live fleet, people and certificates, reporters, messaging and Chat, daily rollups, plans and short text excerpts, settings and the Admin log. |
| Storage | `activity.sqlite` | The SQLite adapter's second file: opt-in activity history and session recordings. The file exists from startup, but no rows are written unless an Admin turns one of them on. |
| Storage | PostgreSQL database | Used instead of the two files above when `PODIUM_DB` is a `postgres://` address: one database with two schemas, `podium` and `podium_activity`, holding the same tables as `podium.sqlite` and `activity.sqlite`. Text is `COLLATE "C"` and times are bigint milliseconds. Nothing is written to `podium_activity` unless an Admin turns on history or recording. The log and the health check show `host:port/dbname`, never the user or the password. |
| Storage | MariaDB database | Used instead of the two files above when `PODIUM_DB` is a `mariadb://` address: one database holding the same tables as `podium.sqlite` and `activity.sqlite`, under the same names. Text is `utf8mb4` under `utf8mb4_nopad_bin` and times are BIGINT milliseconds. Nothing is written to the Activity tables unless an Admin turns on history or recording. The log and the health check show `host:port/dbname`, never the user or the password. |
| Storage | Certificates and config | The CA and serving keys in `/data/tls` (the `tls/` folder of the data directory: `PODIUM_DATA_DIR`, else the SQLite file's folder; a `postgres://` or `mariadb://` database has no folder, so `PODIUM_DATA_DIR` is required), podiumctl settings in `~/.podium/config.env`, a person's config file, the context names in `~/.podium/contexts.json` (set by `podiumctl context` or `/podium context`), and the reporter's machine id and pinned machine name. |
| Console | Preferences and cookies | Convenience only: theme, pins and collapsed panes. The respond and Admin cookies are `HttpOnly` and `SameSite=Strict`. Tokens are never written to storage. |
