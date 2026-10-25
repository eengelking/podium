---
title: "Atlas tables"
description: "A table of every part of Podium and every reporter hook, the key functions, the flows between them and where data lives."
group: Reference
---

# Atlas

A short reference to every part of Podium, for someone who wants the map before the detail. It is the text
companion to the interactive page [`docs/atlas/podium-atlas.html`](podium-atlas.html) (open it in a browser):
the first section lists the thirty parts on that page's system map, the second lists the reporter's hooks and
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
| Reporter | TLS helper | A script the mod starts once per session. It holds the client certificate, makes the mutual-TLS connection and forwards only reporter routes. |
| Reporter | Collectors | Small readers for what hooks do not carry: git branch and changed files, machine id, build, models. |
| Reporter | Activity, diff, recorder | Three opt-in readers that capture more than the wall needs: recent tool calls, a file diff on request, and a whole-session recording. Each is redacted and size-capped. |
| Reporter | Simulator, settings hooks | Other ways to report: a simulator that fakes a busy fleet, and Claude Code's settings hooks for sessions started without the mod. |

### Network

| Location | Item | Description |
|---|---|---|
| Network | HTTP :4317 | The main listener: the console, the API, Admin, and reporters that send a token. Plain HTTP, bound to `127.0.0.1` by default. |
| Network | mTLS :4318 | Only with built-in TLS on. HTTPS that requires a client certificate from the Podium CA, and answers 404 to anything but reporter routes. |
| Network | Reverse proxy | Optional. Your own TLS-terminating proxy in front of the console, for a network you do not trust. |

### Server

| Location | Item | Description |
|---|---|---|
| Server | Ingest | Validates each report field by field, then stores it in one database transaction. |
| Server | Fleet | Owns the set of live sessions and the clock, and turns rows into the `SessionView` every browser sees (state, context fill, cost). |
| Server | Sweeper | A one-second loop that marks quiet sessions stale, drops lost ones, removes ended ones and fills quiet seconds in the charts. |
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
| Storage | `podium.sqlite` | The main database: sessions, agents, events, samples, people, groups, reporters, messages, rollups, settings and the Admin log. |
| Storage | `activity.sqlite` | A second file for opt-in activity history and session recordings. Nothing is written to it unless an Admin turns one of them on. |

### Console

| Location | Item | Description |
|---|---|---|
| Console | The wall | One card per session: model, effort, plan, agents, context fill, cost and branch, grouped by person. |
| Console | Live store | Loads `/state`, then applies stream messages with a pure reducer so every tab shows the same state. |
| Console | Orchestrator page | One orchestrator in detail: plan, changed files, each agent's task and answer, failures and the live activity feed. |
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
| Reporter | Git timer | Reads the branch, ahead and behind counts and changed files every 10 s. |
| Reporter | `command.run` (`/podium`) | The `/podium` command: shows the link and connection state, names the session, and answers a messaging request. |
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
| Reporter | `readGit` | Branch, ahead/behind. In `mod/podium-reporter/hooks/git.ts`. |
| Reporter | `readChanges` | Changed files with +/- counts. In `mod/podium-reporter/hooks/git.ts`. |
| Reporter | `machineIdPath` | Where the random machine id is kept. In `mod/podium-reporter/hooks/machine.ts`. |
| Reporter | `osFromSwVers` | Reads the macOS version. In `mod/podium-reporter/hooks/machine.ts`. |
| Reporter | `class Recorder` | Numbers, redacts and batches a session recording. In `mod/podium-reporter/hooks/recording.ts`. |
| Reporter | `handleDiffs` | Reads one file's diff when its owner asks. In `mod/podium-reporter/hooks/register.ts`. |
| Reporter | `redactDiff` | Replaces secret-shaped text in a diff. In `mod/podium-reporter/hooks/diffRedact.ts`. |
| Reporter | `setWatched` | Records which loops someone is watching. In `mod/podium-reporter/hooks/state.ts`. |
| Reporter | `ingestHook` | Takes a settings-hook report, giving a reduced view. In `server/src/fleet/fleet.ts`. |

### Network

| Location | Item | Description |
|---|---|---|
| Network | `startTls` | Starts the mutual-TLS listener. In `server/src/tlsServer.ts`. |
| Network | `reporterPortOnly` | Answers 404 to any path that is not a reporter route. In `server/src/tlsServer.ts`. |

### Server

| Location | Item | Description |
|---|---|---|
| Server | `validateReport` | Checks every field of a report by hand. In `server/src/fleet/protocol.ts`. |
| Server | `ingestReport` | Stores a validated report in one transaction. In `server/src/fleet/ingest.ts`. |
| Server | `class Fleet` | The live set, the clock and the views. In `server/src/fleet/fleet.ts`. |
| Server | `state()` | The snapshot for a browser's first paint. In `server/src/fleet/fleet.ts`. |
| Server | `sessionView` | Turns database rows into the SessionView the browsers get. In `server/src/fleet/derive.ts`. |
| Server | `sessionStatus` | Done, stale (silent too long) or the status last reported. In `server/src/fleet/derive.ts`. |
| Server | `startSweeper` | The one-second housekeeping loop. In `server/src/fleet/sweeper.ts`. |
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
| Server | `class PeerService` | Finds live orchestrators and carries messages. In `server/src/fleet/peers.ts`. |
| Server | `class PeerRights` | Who may message whom, and the limits. In `server/src/fleet/peerRights.ts`. |
| Server | `pair` | The same-owner rule for messaging rights. In `server/src/fleet/peerRights.ts`. |
| Server | `class PeerMessages` | Stores, checks and hands over messages. In `server/src/fleet/peerMessages.ts`. |
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
| Storage | `class SessionRecordings` | Stores recordings within their caps. In `server/src/fleet/recordings.ts`. |

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
| Storage | `podium.sqlite` | The main database in WAL mode: the live fleet, people and certificates, reporters, messaging, daily rollups, plans and short text excerpts, settings and the Admin log. |
| Storage | `activity.sqlite` | Opt-in activity history and session recordings. The file exists from startup, but no rows are written unless an Admin turns one of them on. |
| Storage | Certificates and config | The CA and serving keys in `/data/tls`, podiumctl settings in `~/.podium/config.env`, a person's config file, and the reporter's machine id. |
| Console | Preferences and cookies | Convenience only: theme, pins and collapsed panes. The respond and Admin cookies are `HttpOnly` and `SameSite=Strict`. Tokens are never written to storage. |
