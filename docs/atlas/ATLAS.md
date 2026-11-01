---
title: "Atlas tables"
description: "A table of every part of Podium and every reporter hook, the key functions, the flows between them and where data lives."
group: Reference
---

# Atlas

A short reference to every part of Podium, for someone who wants the map before the detail. It is the text
companion to the interactive page [`docs/atlas/podium-atlas.html`](podium-atlas.html) (open it in a browser):
the first section lists the thirty-two parts on that page's system map, the second lists the reporter's hooks and
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
| Reporter | Inside each Claude Code process, on the machine that runs the session |
| Network | Between the two: a listener or a proxy that carries reports and browsers |
| Server | The Podium server process |
| Storage | A file the server keeps on disk |
| Console | The React page in your browser |

Sessions call out to the server; the server never calls in to a session. Anything the server wants a session
to do travels back in the reply to a report.

## The parts

### Reporter

| Location | Item | Description |
|---|---|---|
| Reporter | Hooks and reducers | Callbacks on tool calls, turns and session start and end. They fold events into an in-memory model and wait on nothing but a person's answer, a peer tool call and the final report. |
| Reporter | Transport and timer | A timer that posts a full snapshot and any unsent events to the server, and reads the reply. Backs off while the server is offline. |
| Reporter | Claude Code session | The process being watched: an orchestrator plus the agents it launches. Podium never wraps or replaces it. |
| Reporter | In-session tools | How Podium reaches back into a session: answers to questions, plans and permission prompts, messages from your other orchestrators, and `/podium`. |
| Reporter | TLS helper | A script the mod starts once per session. It holds the client certificate, makes the mutual-TLS connection and forwards only reporter routes. The mod picks its config file by `PODIUM_REPORTER_CONFIG`, then `PODIUM_REPORTER_CONTEXT`, then the current context in `~/.podium/contexts.json`, then the newest `reporter-config-*.pem`. |
| Reporter | Collectors | Small readers for what hooks do not carry: git branch and changed files, machine id, build, models. |
| Reporter | Activity, diff, recorder | Three opt-in readers that capture more than the wall needs: recent tool calls, a file diff (on request, or loaded ahead while the owner has the console page open), and a whole-session recording. Each is redacted and size-capped. |
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
| Server | Ingest | Validates each report field by field, then stores it in one database transaction. |
| Server | Fleet | Owns the set of live sessions and the clock, and turns rows into the `SessionView` every browser sees (state, context fill, cost). It takes one `Storage`, loads its settings in `init()` before the server listens, and sends every broadcast through one ordered queue. |
| Server | Sweeper | A one-second loop that marks quiet sessions stale, drops lost ones, removes ended ones and fills quiet seconds in the charts. A timer body whose previous run is still going is skipped. |
| Server | State and stream | `GET /state` for the first paint and `GET /stream`, a server-sent-events feed of changes. |
| Server | Routers and identity | The routes for reports, hooks, state, stream and sessions, and the code that turns a certificate or token into an owner. |
| Server | Guard chain | Middleware that runs first on the HTTP port: Host check, security headers, the reporter HTTP gate, request log and the failed-request limiter. |
| Server | Admin API | A separate router for people, groups, reporters, settings, feature flags, certificates, usage reports and the Admin log. |
| Server | Messaging service | Lets one person's orchestrators on different machines find and message each other, with rights, limits and an audit trail. |
| Server | CA and certificates | Podium is its own certificate authority: it issues, renews and revokes the serving and per-person certificates, and rotates its CA. |
| Server | Live brokers | In-memory holders for the most sensitive live data: open asks, the live activity feed and pending diff requests. A restart forgets them. |
| Server | Logging and outside calls | Structured, redacted log events, optional shipping to VictoriaLogs, and a once-a-day check for a newer release. |

### Storage

| Location | Item | Description |
|---|---|---|
| Storage | Storage interface | The contract the app calls, and the only storage it knows: the async `Storage` interfaces written out in `server/src/storage/types.ts`, with the neutral row types, flag and notice tables and setting limits beside them (`rows.ts`, `features.ts`, `settings.ts`), and `openStorage` in `storage/index.ts`. The server reads `PODIUM_DB` once through `storageSpec` (an unknown kind throws at startup); `openStorage`, which is async, picks an adapter by kind from a registry (`DEFAULT_STORAGE_KIND` is `sqlite`; `postgres` is the other kind, and `postgresql://` is an alias for it; each kind declares its own default target, which `postgres` does not have, and a `label()` for the log and the health check: `host:port/dbname`, never a user or password) and loads it on demand. `/health` shows that label as `dbPath` and the kind as `dbKind`. It names no database, and no app code opens one. The interface is fixed; the adapter behind it can be replaced. |
| Storage | SQLite adapter (the default) | One of two adapters, in `server/src/storage/sqlite/`. It implements the `Storage` interfaces and owns the SQL, the 25 numbered migrations, one lock per connection, and both database files. Options only it honors stay inside it (`vacuumPages` on `SqliteActivityHistoryOpts`). Migration 25 adds a `seq` column to `peer_messages` and `person_certificates`, an explicit insertion order that replaces SQLite's `rowid` on a tie. |
| Storage | PostgreSQL adapter | The other adapter, in `server/src/storage/postgres/`, chosen when `PODIUM_DB` is a `postgres://` (or `postgresql://`) address. It implements the same `Storage` interfaces over the `pg` driver, which only this folder imports, and passes the same contract suite. It keeps two schemas in one database, each on its own pool: `podium` (10 connections) and `podium_activity` (4 connections). Transactions run one at a time through `PgDb.tx`. A session advisory lock taken at startup keeps a second server off the database. Each schema has one baseline step and later changes are new steps. |
| Storage | `podium.sqlite` | The SQLite adapter's main file, reached only through the adapter: WAL mode, with the live fleet, people and certificates, reporters, messaging, daily rollups, settings and the Admin log. |
| Storage | `activity.sqlite` | The SQLite adapter's second file, for opt-in activity history and session recordings, on its own connection and its own lock. Nothing is written to it unless an Admin turns one of them on. |

### Console

| Location | Item | Description |
|---|---|---|
| Console | The wall | One card per session: model, effort, plan, agents, context fill, cost and branch, grouped by person. |
| Console | Live store | Loads `/state`, then applies stream messages with a pure reducer so every tab shows the same state. |
| Console | Orchestrator page | One orchestrator in detail: plan, changed files (their diffs loaded in the background), each agent's task and answer, failures and the live activity feed. |
| Console | Respond modal | Lets a session's owner answer a question, approve a plan or a tool call, send a message, or run `/clear` and `/compact`. |
| Console | Admin | The Admin pages, in four groups: people and access, server, reporting, and activity. |
| Console | Reporters, Traffic, Replay | Rights between your orchestrators, a map of messages between machines, and a recorded session played back. |

## The reporter's hooks and timers

These are the handlers in `mod/podium-reporter/hooks/register.ts` that make up the first four rows of
[The parts](#the-parts). Each runs after Claude Code has done its own work, and an error in one is logged and never
passed on, so a bug in Podium cannot fail a tool call.

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
| Reporter | `session.attach`, `session.detach` | A client joining or leaving: reads the list of attached clients at once, so a background session is told from one with someone on it. |
| Reporter | `skill.prompt` | Records a skill loading, unless a `Skill` tool call or a running agent already accounts for it. |
| Reporter | `classic.Notification`, `classic.Stop` | A notification from Claude Code, and the list of background work and scheduled wake-ups still running when a turn stops. |

### Server

| Location | Item | Description |
|---|---|---|
| Server | Sweeper | Removes a card after a `done` report (an 8 s linger) or after reports stop (stale at 15 s, dropped 60 s later). |

## Key functions

The functions and classes the interactive page points at, by part, most important first. The page is the
source for this section: `scripts/atlas-functions.mjs` writes the tables from its source references, and
`node scripts/atlas-functions.mjs --check` fails if they are out of date or if a named file or function is gone from the
code. A function's line number is on the page, not here, because it moves.

<!-- atlas-functions:start (generated by scripts/atlas-functions.mjs from docs/atlas/podium-atlas.html; edit the page, not this table) -->

### Reporter

| Location | Item | Description |
|---|---|---|
| Reporter | `newSession` | Creates the in-memory model of a session. In `mod/podium-reporter/hooks/state.ts`. |
| Reporter | `addEvent` | Adds an event to the model's queue for the next report. In `mod/podium-reporter/hooks/state.ts`. |
| Reporter | `taskCreate` | Plan from TaskCreate. In `mod/podium-reporter/hooks/plan.ts`. |
| Reporter | `taskUpdate` | Plan from TaskUpdate. In `mod/podium-reporter/hooks/plan.ts`. |
| Reporter | `redact` | Replaces secret-shaped text with [redacted]. In `mod/podium-reporter/hooks/failures.ts`. |
| Reporter | `class Transport` | Posts a report, backs off, reads the reply. In `mod/podium-reporter/hooks/transport.ts`. |
| Reporter | `due()` | Whether a report goes now (changed, or heartbeat due, and no backoff). In `mod/podium-reporter/hooks/transport.ts`. |
| Reporter | `flush` | The timer's entry point; posts a report if one is due. In `mod/podium-reporter/hooks/register.ts`. |
| Reporter | `flushOnce` | Builds and posts one report, then reads the reply. In `mod/podium-reporter/hooks/register.ts`. |
| Reporter | `buildReport` | Builds the report: a full snapshot plus unsent events. In `mod/podium-reporter/hooks/report.ts`. |
| Reporter | `questionRace` | A question's answer from Podium races the terminal's dialog. In `mod/podium-reporter/hooks/register.ts`. |
| Reporter | `planRace` | The same race for a plan's approval or feedback. In `mod/podium-reporter/hooks/register.ts`. |
| Reporter | `permissionAsk` | A tool's permission prompt, answered from Podium. In `mod/podium-reporter/hooks/register.ts`. |
| Reporter | `handleDeliveries` | Acts on the answers and messages in a reply. In `mod/podium-reporter/hooks/register.ts`. |
| Reporter | `toolDecision` | Turns an answer from Podium into a hook result. In `mod/podium-reporter/hooks/respond.ts`. |
| Reporter | `planApproval` | The hook result that approves a plan. In `mod/podium-reporter/hooks/respond.ts`. |
| Reporter | `sendPeerCalls` | Sends a messaging tool's queued calls, run by the timer. In `mod/podium-reporter/hooks/register.ts`. |
| Reporter | `peerPrompt` | The frame around a peer message. In `mod/podium-reporter/hooks/peers.ts`. |
| Reporter | `dueSoon` | Whether the certificate is close enough to expiry to renew. In `mod/podium-reporter/hooks/helper.mjs`. |
| Reporter | `serveMailbox` | On Windows, answers request files in a folder. In `mod/podium-reporter/hooks/helper.mjs`. |
| Reporter | `readGit` | Branch, ahead/behind. In `mod/podium-reporter/hooks/git.ts`. |
| Reporter | `readChanges` | Changed files with +/- counts. In `mod/podium-reporter/hooks/git.ts`. |
| Reporter | `machineIdPath` | Where the random machine id is kept. In `mod/podium-reporter/hooks/machine.ts`. |
| Reporter | `osFromSwVers` | Reads the macOS version. In `mod/podium-reporter/hooks/machine.ts`. |
| Reporter | `class Recorder` | Numbers, redacts and batches a session recording. In `mod/podium-reporter/hooks/recording.ts`. |
| Reporter | `handleDiffs` | Reads one file's diff when its owner asks or the console loads it ahead. In `mod/podium-reporter/hooks/register.ts`. |
| Reporter | `redactDiff` | Replaces secret-shaped text in a diff. In `mod/podium-reporter/hooks/diffRedact.ts`. |
| Reporter | `setWatched` | Records which loops someone is watching. In `mod/podium-reporter/hooks/state.ts`. |
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
| Server | `ingestReport` | Stores a validated report in one transaction. In `server/src/fleet/ingest.ts`. |
| Server | `class Fleet` | The live set, the clock and the views, over one Storage. In `server/src/fleet/fleet.ts`. |
| Server | `init` | Loads the stored settings and the live candidates; the server listens only after it. In `server/src/fleet/fleet.ts`. |
| Server | `noteOrchestrator` | Puts the reporter in the peer directory, in the session's own serial turn. In `server/src/fleet/fleet.ts`. |
| Server | `state()` | The snapshot for a browser's first paint. In `server/src/fleet/fleet.ts`. |
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
| Server | `requireToken` | Turns a token, the admin secret or open access into an owner. In `server/src/fleet/routes.ts`. |
| Server | `certAuth` | Checks the client certificate on every request. In `server/src/tlsClientAuth.ts`. |
| Server | `tokenMatches` | Compares a token in constant time. In `server/src/fleet/tokens.ts`. |
| Server | `reporterHttpGate` | Refuses plain-HTTP reporters once an Admin turns them off. In `server/src/tlsHttp.ts`. |
| Server | `securityHeaders` | Security headers and the Content-Security-Policy. In `server/src/securityHeaders.ts`. |
| Server | `createAdminRouter` | The Admin API with its own sign-in and log. In `server/src/admin/adminRouter.ts`. |
| Server | `class Lockout` | Locks an address out after five wrong tries. In `server/src/fleet/lockout.ts`. |
| Server | `class PeerService` | Finds live orchestrators and carries messages. In `server/src/storage/sqlite/peerService.ts`. |
| Server | `class PeerRights` | Who may message whom, and the limits. In `server/src/storage/sqlite/peerRights.ts`. |
| Server | `pair` | The same-owner rule for messaging rights. In `server/src/storage/sqlite/peerRights.ts`. |
| Server | `class PeerMessages` | Stores, checks and hands over messages. In `server/src/storage/sqlite/peerMessages.ts`. |
| Server | `peerReplyFor` | The messaging items that ride a report's reply. In `server/src/fleet/peerRoutes.ts`. |
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
| Storage | `openSqliteStorage` | Builds every store on one connection, each call behind one lock. In `server/src/storage/sqlite/index.ts`. |
| Storage | `class AsyncLock` | One queue per connection; a call inside its own transaction runs directly. In `server/src/storage/sqlite/lock.ts`. |
| Storage | `class ActivityConnection` | The activity file's own connection and lock. In `server/src/storage/sqlite/activity.ts`. |
| Storage | `SqliteActivityHistoryOpts` | The neutral history options plus what only this adapter honors (vacuumPages). In `server/src/storage/sqlite/activityHistory.ts`. |
| Storage | `class SessionRecordings` | Stores recordings within their caps. In `server/src/storage/sqlite/recordings.ts`. |
| Storage | `sqliteReference` | What the contract suite reads back from SQLite. In `server/src/storage/sqlite/contractReference.ts`. |
| Storage | `openPostgresStorage` | Takes the single-process lock, migrates both schemas and builds every store. In `server/src/storage/postgres/index.ts`. |
| Storage | `class PgDb` | One pool; tx takes transactions one at a time and a call inside one joins it. In `server/src/storage/postgres/conn.ts`. |
| Storage | `numbered` | Turns the SQLite stores' ? and :name placeholders into $n. In `server/src/storage/postgres/conn.ts`. |
| Storage | `toSafeNumber` | Bigint and numeric as numbers; an unsafe integer is an error. In `server/src/storage/postgres/conn.ts`. |
| Storage | `acquireSingleProcessLock` | A session advisory lock; a second server refuses to start. In `server/src/storage/postgres/singleProcess.ts`. |
| Storage | `migrate` | Applies the steps not yet in schema_migrations. In `server/src/storage/postgres/schema.ts`. |
| Storage | `class PgActivityConnection` | The Activity history and recordings on their own pool. In `server/src/storage/postgres/activity.ts`. |
| Storage | `notPorted` | A store not ported yet; every method rejects. In `server/src/storage/postgres/notPorted.ts`. |
| Storage | `openDb` | Opens the main file, sets WAL and applies the migrations. In `server/src/storage/sqlite/db.ts`. |
| Storage | `openActivityDb` | Opens the activity file, sets incremental vacuum and WAL, applies its steps. In `server/src/storage/sqlite/activityDb.ts`. |
| Storage | `activityDbPath` | The activity file's path, beside the main one. In `server/src/storage/sqlite/activityDb.ts`. |

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
| One orchestrator messages another | Cross-machine messages between one person's orchestrators, with rights and an audit trail. | A session calls `podium_send`; the timer sends it; the server resolves the target and checks rights and limits; the message is stored as ready or awaiting approval; it is handed over when the target is idle; the mod frames it, submits it as a prompt and reports the result. |
| Recording and replaying | Records a whole session and plays it back. The most sensitive feature has the most switches. | Three yeses start it (Admin switch, owner's choice, reporter option); the recorder redacts and numbers entries; batches go up every five seconds; the owner replays it; the sweeper purges it on schedule. |
| Securing the reporter link | Mutual TLS, from creating a person to a revoked certificate. | An Admin creates a person; the server issues a certificate; the config file is shown once; the mod starts the TLS helper; the handshake needs a certificate; it is checked again on every request; it renews itself. |

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
| Storage | `podium.sqlite` | The SQLite adapter's main file, in WAL mode. The app reaches it only through the `Storage` interface and the adapter, which owns it: the live fleet, people and certificates, reporters, messaging, daily rollups, plans and short text excerpts, settings and the Admin log. |
| Storage | `activity.sqlite` | The SQLite adapter's second file: opt-in activity history and session recordings. The file exists from startup, but no rows are written unless an Admin turns one of them on. |
| Storage | PostgreSQL database | Used instead of the two files above when `PODIUM_DB` is a `postgres://` address: one database with two schemas, `podium` and `podium_activity`, holding the same tables as `podium.sqlite` and `activity.sqlite`. Text is `COLLATE "C"` and times are bigint milliseconds. Nothing is written to `podium_activity` unless an Admin turns on history or recording. The log and the health check show `host:port/dbname`, never the user or the password. |
| Storage | Certificates and config | The CA and serving keys in `/data/tls` (the `tls/` folder of the data directory: `PODIUM_DATA_DIR`, else the SQLite file's folder; a `postgres://` database has no folder, so `PODIUM_DATA_DIR` is required), podiumctl settings in `~/.podium/config.env`, a person's config file, the context names in `~/.podium/contexts.json` (set by `podiumctl context` or `/podium context`), and the reporter's machine id and pinned machine name. |
| Console | Preferences and cookies | Convenience only: theme, pins and collapsed panes. The respond and Admin cookies are `HttpOnly` and `SameSite=Strict`. Tokens are never written to storage. |
