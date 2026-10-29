---
title: "9. Phased build plan"
description: "The build order in phases 0 to 5, with the tasks and acceptance tests of each."
group: "Reference"
section: "9"
order: 9
---

# 9. Phased build plan

Phases run in order. Each ends with committed, passing, runnable work. Inside a phase, do tasks in the order listed unless a task says it is independent. **Commit at the end of each task** (conventional-commit style, matching the repo's history), on the branch you are on. Run `npm test` at the root before each commit.

## Phase 0: Contract and scaffolding

**Goal:** the shared contract exists as code and fixtures, and the workspace builds.

### T0.1 Protocol types and fixture
- **Scope:** `server/src/fleet/protocol.ts`, `mod/podium-reporter/hooks/protocol.ts`, `docs/fixtures/report.sample.json`.
- **Depends on:** none.
- **Acceptance:**
  1. `protocol.ts` exports `Report`, `Plan`, `AgentReport`, `Failure`, `ActivityEvent`, `SessionView`, `AgentView`, `ActivityView`, `Kpis` exactly as in sections 6.2 and 7.4, plus a hand-written `validateReport(unknown)` that returns `{ ok: true, report } | { ok: false, error, path }` and enforces every limit in 7.7.
  2. The mod's `protocol.ts` has identical type declarations (types only). A test in each project reads the sibling's file and fails if the interface text differs after whitespace normalization.
  3. `docs/fixtures/report.sample.json` is a full valid report with a running orchestrator, a plan with four steps in different states, one done subagent, one running fork, one failed subagent with a failure and one with two blowouts, and three events. `validateReport` accepts it.
  4. `validateReport` rejects: a missing `v`, `v: 2`, a non-array `agents`, an agent with an unknown `status`, a 600-char event text (clamped, not rejected), 201 agents (rejected), a non-object body.

### T0.2 Repo plumbing
- **Scope:** root `package.json`, `.gitignore`, `server/package.json`, `frontend/vite.config.ts`, `scripts/`.
- **Depends on:** none (independent of T0.1).
- **Acceptance:**
  1. `.gitignore` ignores `data/` and `*.sqlite*`.
  2. `server/package.json` has `@types/node` at a version that declares `node:sqlite`; `npm install` at the root succeeds; `npm test` and `npm run build` still pass unchanged for the existing app.
  3. The Vite dev server proxies `/api` to the server port; the `/api/fleet/stream` proxy does not buffer (verify with the smoke script in T4.1).
  4. Root `package.json` gains scripts `podium:sim` (runs the simulator) and `podium:smoke`.

**Exit criterion:** `npm test` and `npm run build` pass; the fixture validates; both type files match.

## Phase 1: Server

**Goal:** a server that ingests reports, persists them, derives views, and streams them, proven by tests and the simulator.

### T1.1 Database and migrations
- **Scope:** `server/src/storage/sqlite/db.ts` and its test.
- **Depends on:** T0.1, T0.2.
- **Acceptance:**
  1. `openDb(path)` creates the schema in section 7.2 on an empty file and is idempotent on an existing one; `schema_migrations` records versions.
  2. `:memory:` works for tests. WAL is on for file databases.
  3. Parameterized queries only. A test inserts a session name containing `'); DROP TABLE sessions;--` and the table survives.

### T1.2 Ingest
- **Scope:** `server/src/fleet/ingest.ts` and its test.
- **Depends on:** T1.1.
- **Acceptance:**
  1. Ingesting the fixture creates one session, all its agents, its events and its blowout rows.
  2. Ingesting the same report twice changes nothing but `last_seen_at` (idempotent), including event count and blowout count.
  3. A later report that omits a previously reported agent keeps it. If the session ends `done`, a still-`running` agent becomes `aborted`.
  4. A report with `status: "done"` sets `ended_at`. A later report for the same id with `status: "running"` revives it.
  5. Samples: two reports 1 s apart with cumulative tokens 1,000 then 4,000 give `tokens_delta` 3,000; a decreasing total gives delta 0; at most one sample per second per session.
  6. Server time, not reporter time, sets `last_seen_at`.

### T1.3 Derivation
- **Scope:** `server/src/fleet/derive.ts` and its test.
- **Depends on:** T1.2.
- **Acceptance:**
  1. `blowoutLevel` returns 0 for none; 1 for one blowout anywhere; 2 for an orchestrator with 2; 2 for any agent with 2; 2 for a total of 3 spread over three loops; with a table-driven test of at least 10 cases.
  2. `SessionView.status` is `stale` when `now − lastSeenAt > STALE_AFTER_MS` and the stored status is not `done`.
  3. `series` has exactly 60 points per array, zero-filled for seconds with no sample, `peakContext` in 0..1, and `blowoutSecondsAgo` containing the age in seconds of each blowout in the last 60 s.
  4. KPIs match hand-computed values for a three-session fixture, including est. cost today and tokens in the last 60 s.
  5. `resumeCommand` uses `resumeId` when present, else the session id, and quotes a `cwd` containing spaces. `forkCommand` is the same string with ` --fork-session` added, with the same quoting (#352).
  6. `project` replaces the home directory prefix with `~`.

### T1.4 Sweeper and SSE
- **Scope:** `server/src/fleet/sweeper.ts`, `server/src/fleet/sse.ts` and tests.
- **Depends on:** T1.3.
- **Acceptance:**
  1. With an injectable clock, a session unheard for 15 s becomes `stale`; 75 s total drops it and emits `removed` with reason `dropped`; a `done` session lingers 8 s then emits `removed` with reason `done`.
  2. A dropped session that reports again returns to the live set.
  3. SSE sends `snapshot` on connect, `session` after ingest (throttled: ten ingests in 200 ms produce at most one `session` message), `activity` per new event, `removed` and `tick` every 2 s. A client that disconnects is removed; a write error does not crash the process.
  4. Hourly retention deletes samples > 24 h, events > 30 d, old ended sessions, verified with injected old rows.

### T1.5 Routes and server wiring
- **Scope:** `server/src/fleet/routes.ts`, `server/src/index.ts`, tests with supertest.
- **Depends on:** T1.4.
- **Acceptance:**
  1. All endpoints in 7.1 except `history` and `hook` exist and behave as specified, including 400 with `{ ok:false, error, path }`, 413 over 512 KB, 401 without the token when `PODIUM_TOKEN` is set, 404 for an unknown session.
  2. `GET /api/fleet/events` pages correctly with `before` and `limit`, newest first.
  3. `GET /api/health` still answers. (The old `/api/claude-code` and `/api/api-usage` routes were removed in issue #30.)
  4. The server starts with `npm run dev -w server`, creates `data/podium.sqlite`, and logs the URL. It binds `127.0.0.1`.

### T1.6 Simulator
- **Scope:** `scripts/podium-sim.ts`.
- **Depends on:** T1.5 (can start once T0.1 is done, finish after T1.5).
- **Acceptance:**
  1. `--help` documents flags: `--url`, `--sessions N`, `--speed X`, `--seed N`, `--duration S`, `--chaos` (random stale sessions, failures, blowouts), `--token`, and for the people view (#34) `--person NAME[=TOKEN]` (repeatable: sessions go to the people in turn, each sends that person's `userName`, a `machine` (a laptop, and a build box for every third session) and its own token, else `--token`) and `--unnamed` (also keep a share of sessions with no name), and `--nested` (keep one session running agents that launch agents: a subagent under a subagent, a fork under a subagent and a subagent under a fork, four levels deep, #101).
  2. It POSTs full reports once a second per simulated session using the exact `Report` type, with sessions that start, spawn subagents and forks, load skills, fail, blow out context (haiku-sized windows blow out often), finish, and get replaced, as in the mockup's simulation.
  3. A seeded run is deterministic (same seed, same sequence of reports apart from timestamps).
  4. It exits 0 on `--duration` expiry and leaves no sessions running; sessions it created are ended with `status: "done"` on exit and on SIGINT.

**Exit criterion:** start the server and `npm run podium:sim -- --sessions 5 --chaos`; `curl -s localhost:4317/api/fleet/state` shows five sessions with agents, plans and series; `curl -N localhost:4317/api/fleet/stream` prints `snapshot`, then `session`, `activity` and `tick` messages; stopping the simulator ends its sessions and they leave the live set within the linger time.

## Phase 2: Frontend

**Goal:** the UI from the mockup, running on live server data.

### T2.1 Foundations
- **Scope:** `frontend/src/fleet/` shell: `FleetApp`, `useFleet`, reducer, `format.ts`, `fleet.css` tokens, theme hook, `main.tsx` routing (`#/` fleet, `#/history`).
- **Depends on:** T0.1, T1.5.
- **Acceptance:**
  1. `#/` renders the shell with the top bar. (The old `#/usage` app this once had to leave unchanged was removed in issue #30; that hash now shows the fleet.)
  2. The reducer is a pure function with tests for `snapshot`, `session` upsert, `activity` prepend with a 150 cap, `removed`, and `tick`.
  3. With the server and simulator running, the connection pill shows the live reporter count; stopping the server shows "disconnected, retrying" within 6 s and recovers by itself when the server returns.
  4. `fmtTok`, `fmtUsd`, `fmtDur` and `fmtClock` have tests including edge values (0, 999, 1000, 1.5M, 3,600 s, 86,400 s).
  5. Dark and light themes match the mockup's tokens; every theme and mode can be picked, the whole console follows, and the choice survives a reload with no flash of the default.

### T2.2 Rail, KPI strip, wall, cards
- **Scope:** `Rail`, `Wall`, `KpiStrip`, `Toolbar`, `SessionCard`, chips, `Sparkline`, `Legend`.
- **Depends on:** T2.1.
- **Acceptance:**
  1. With the simulator running, new sessions appear in the rail and wall without reload; ended ones leave with the leave animation; `prefers-reduced-motion` disables both.
  2. Sorting by each of the six keys reorders both the rail and the wall; sorting by Model orders Fable, Haiku, Opus, Sonnet and breaks ties by status then name. A unit test covers all six sorts.
  3. Filters: each status segment and the Blowouts segment filter correctly; the text filter matches name, project and branch case-insensitively. Unit-tested.
  4. A card renders the git line for all four cases (worktree with ahead/behind/dirty, main checkout clean, detached head, `git: null` shows nothing).
  5. Blowout level 1 shows the amber badge; level 2 shows the red badge, the red card edge and a red context figure, with the sentence as the Context readout's tooltip and no sentence on the card.
  6. Agent strip squares: fork is a circle, done is faded, failed has a red outline, queued is dashed.

### T2.3 Orchestrator page
- **Scope:** `FocusView`, `FocusHeader`, `MiniCharts`, `FactsBar`, `BlowoutCallout`, `PlanPanel`, `AgentTree`, `AgentRow`.
- **Depends on:** T2.2.
- **Acceptance:**
  1. Selecting a card or rail item shows the page; Back (the "All orchestrators" rail item) returns to the wall; the selection survives `session` updates and clears with a message if the session is removed.
     The open orchestrator is in the address (`#/?open=<id>`), so a reload, a shared link and the browser's Back button land on the same page (see "Address" under the orchestrator page).
  2. The header, charts, facts grid and status band match the mockup's layout at 1440 px (`mockup/podium-orchestrator.html`, #165; `mockup/podium-facts-reporter.html` for the Reporter cell, #124); the status band is the last row of the summary surface and **Fork** is the last cell of the facts grid, after Session and **Resume** (`mockup/podium-fork.html`, #352).
  3. Charts: three charts of 60 points from `series`; `peakContext` fixed 0..100%; red markers at `blowoutSecondsAgo`; caption counts markers; hover shows a crosshair and the value and time under the pointer and restores the live value on leave. A pure function converts a series to polyline points and is tested (empty, single point, all zeros, max scaling).
  4. The agent tree builds from `parentId`; guides draw correctly for last and non-last children; sorting by Model/Effort/Context/Tokens/Cost/Time/Status orders siblings and keeps the tree (#101) and clicking the same header again reverses it; "Launch order" clears the sort. Unit-tested.
  5. Plan panel shows state icons, the owner label, and "No plan reported. Agents were launched ad hoc." when `plan` is null.
  6. Context bars turn amber at ≥ 75% and red at ≥ 80% (#213, `mockup/podium-context-bar.html`; never both, the red bar carries an outline and a cap so it differs from amber in grayscale, and its accessible name ends "nearly full"), and show red stripes for loops with ≥ 2 blowouts.

### T2.4 Side panel
- **Scope:** `SidePanel`, `ActivityList`, `AgentDetail`, `FailureBox`, `BlowoutBox`.
- **Depends on:** T2.3.
- **Acceptance:**
  1. Activity shows 12 rows; "Show 12 more" appends 12 more until the cap; "Show fewer" returns to 12; the count text is correct at each step; the 150-event memory note is present.
  2. Clicking an activity row with an agent selects its orchestrator and agent, opens the agent detail, scrolls the row into view and flashes it. A failure row opens a detail that contains the failure box. A blowout row opens a detail containing the blowout timeline. A row of a removed session is inert and says "Session ended".
  3. `FailureBox` shows class, call, output lines (as `pre` text, never HTML), evidence lines, optional explanation, and the "step went back to the plan" / "no retry queued" line from `retriedAs`.
  4. Agent detail shows "inherited" next to model and effort for forks.
  5. All text from reports renders as text nodes. A test puts `<img src=x onerror=…>` in a description, a failure output line and an event and asserts no element is created.

### T2.5 Resizable panels, copy button, responsive, accessibility
- **Scope:** `ResizeHandle`, `useResizable`, copy handler, CSS breakpoints.
- **Depends on:** T2.3.
- **Acceptance:**
  1. Drag, keyboard and double-click behave as in 8.1, limits enforced, widths persisted with try/catch, covered by tests that simulate pointer events and keys.
  2. Copy writes `resumeCommand` or `forkCommand` to the clipboard (mocked) and shows "Copied" then reverts; a rejected promise leaves the cell unchanged.
  3. At 400 px width there is no horizontal page scroll (assert `document.documentElement.scrollWidth <= innerWidth` in a browser check, see T4.2).
  4. Every control is reachable by keyboard with a visible focus ring; `jest-dom` assertions for roles and labels on the handles and the charts.

**Exit criterion:** `npm run dev`, then the simulator; open `http://localhost:5173/#/` (check the Vite port) and exercise every requirement in 8.1 with real clicks in a real browser (use the Claude in Chrome tools or Playwright if installed). Record what was checked and what could not be in the commit message of the last Phase 2 commit.

## Phase 3: The reporter mod

**Goal:** a real Claude Code session appears in the dashboard with everything section 6 describes.

### T3.1 Pure modules
- **Scope:** `hooks/state.ts`, `hooks/plan.ts`, `hooks/failures.ts`, `hooks/models.ts`, `hooks/report.ts` and their tests.
- **Depends on:** T0.1.
- **Acceptance:**
  1. `plan.ts` handles TaskCreate, TaskUpdate (every status incl. `deleted`, `addBlockedBy`, `owner`), TodoWrite replace, title rules and owner matching, with tests for each and for a malformed input (ignored, never throws).
  2. `failures.ts` classifies per 6.4 in a table-driven test with at least 10 cases; redaction removes all the listed secret shapes; outputs obey every length limit.
  3. `models.ts` maps aliases and full ids to families (`opus`, `claude-opus-5-5`, `sonnet`, `haiku`, `fable`, unknown); `windowOf` and `priceOf` are documented with their source and `PRICES_AS_OF`.
  4. `state.ts` reducers (spawn, step, complete, tool result, compaction, skill, session id change) are pure functions; given a scripted sequence of events they produce the expected `Report` which validates against the fixture's shape. The effort rule holds: requested → observed wins → fork inherits parent's.
  5. Blowout counting: auto compaction counts, manual does not, `model_context_window_exceeded` counts, duplicate signals within 2 s for the same loop count once.

### T3.2 Transport and git
- **Scope:** `hooks/transport.ts`, `hooks/git.ts` and tests.
- **Depends on:** T3.1.
- **Acceptance:**
  1. With a mocked `$.http.fetch`: a flush posts one JSON report with the right headers (`X-Podium-Token` only when configured); a 400 drops the report; a network error keeps the snapshot and events and retries with backoff 1/2/5/10 s; the queue holds at most 500 events, dropping oldest; success clears acknowledged events.
  2. `git.ts` with a mocked `$.process.run` parses: normal branch with ahead/behind, detached head, worktree (differing git-dir and common-dir), non-repo (non-zero exit → `null`), and dirty counts from porcelain output (modified, untracked, renamed lines).
  3. No function awaits the network from a tool-path hook (checked by a test that the `tool.call` hook resolves while a `fetch` promise is still pending).

### T3.3 Wiring
- **Scope:** `hooks/register.ts`, `plugin.json`, `hooks/hooks.json`.
- **Depends on:** T3.2.
- **Acceptance:**
  1. `claude plugin validate mod/podium-reporter` passes with no errors and lists the hooked events from section 5.3 and the `$` calls from 5.4. Attach its output to `docs/architecture/`.
  2. `tsc -p mod/podium-reporter` passes once types are laid, or the type-check recipe from the reference is used if not.
  3. Every hook calls `next(e)` exactly once (or `yield*` for `turn.step`) and returns its result unchanged; a test with a hook that throws inside the reporter proves the session is unaffected.
  4. `session.start` registers `/podium` and starts the flusher, git poller and (if enabled) status line. A session-id change detected by the flusher sends a `done` report for the old id and starts the new one.
  5. `/podium` returns the dashboard URL, connection state, reports sent and failed, last error; `/podium name <text>` sets the name and persists it.
  6. `session.end` flushes with `status: "done"` and `endReason` before the hook returns.
  7. `claude plugin test mod/podium-reporter` passes, with an end-to-end hook test that raises `session.start`, `agent.spawn` (subagent and fork), `tool.call` (Agent, Skill, TaskCreate, TaskUpdate, a failing Bash), `turn.step` (with usage and a window-exceeded stop), `session.compact` (auto) and `session.end`, and asserts the final posted report's agents, plan, failure, blowouts and skills.

### T3.4 Real-session verification
- **Scope:** running the real mod; no new files except notes in `docs/architecture/`.
- **Depends on:** T3.3, T1.5.
- **Acceptance:**
  1. Start the server. Run `claude --plugin-dir mod/podium-reporter --model haiku -p "<a tiny task that uses the Agent tool once and TaskCreate once>"` (see rules in 10.4 on cost). The session appears in `GET /api/fleet/state` with the right model, a git branch, at least one agent with a model and a state, and a plan with the task, then ends and leaves the live set.
  2. Compare `session.costUsd` with what `/cost` or the final result reports. Record whether session cost includes subagents.
  3. Record in `docs/architecture/` under "Mod API findings": which Assumptions in section 5 were right and which were wrong, with the evidence, including whether `classic.PermissionRequest` and `classic.Notification` are hookable, whether `session.compact` fires for agents, whether effort is visible on spawn, and the exact import-extension rule.

**Exit criterion:** one real session visible end to end in `GET /api/fleet/state`, and the findings recorded.

## Phase 4: Integration and hardening

**Goal:** it works as a product, documented, and survives abuse.

### T4.1 Smoke script
- **Scope:** `scripts/podium-smoke.sh` (has `--help`).
- **Depends on:** Phases 1 and 2.
- **Acceptance:** one command starts the server on a free port with a temporary database, runs the simulator for 20 s, asserts via `curl` that `/state` has sessions, that `/stream` yields `snapshot` and `session` events, that a `done` session is removed after the linger time, then stops everything and deletes temporary files. Exit code is non-zero on any failed assertion. No process is left running (checked with `pgrep`).

### T4.2 Browser verification
- **Scope:** a written checklist in `docs/architecture/` plus the run itself.
- **Depends on:** T2.5, T4.1.
- **Acceptance:** with server and simulator running, in a real browser at 1440 px and 400 px, in dark and light: every item in 8.1 is exercised; screenshots are not required but findings are listed; any defect is fixed or recorded as a known issue with a reason. Includes: kill and restart the server (UI reconnects), 200 ms of 10 simultaneous reports (no UI jank, no duplicated rows), a session that never ends (goes stale, then leaves).

### T4.3 Robustness
- **Scope:** server and mod.
- **Depends on:** T3.3, T1.5.
- **Acceptance:**
  1. Server: sending malformed JSON, a 1 MB body, a report with 5,000 agents, strings with control characters and invalid UTF-8 never crash it and return 4xx.
  2. Server restart mid-session: sessions reload from SQLite as stale and recover when their reporters send again.
  3. Mod: server down for 2 minutes, then up; no events lost within the 500 queue; the Claude session was never slowed (hook latency with the server down is measured and recorded, target under 5 ms added per hook).
  4. 10 concurrent simulated sessions with 20 agents each for 5 minutes: server memory stays flat (record start and end RSS) and SSE clients keep receiving.

### T4.4 Documentation
- **Scope:** `README.md`, `docs/architecture/`, `.env.example`.
- **Depends on:** all above.
- **Acceptance:**
  1. `README.md` explains what Podium is, how to run the server and UI, how to install the mod (from `eengelking-marketplace`, or `claude --plugin-dir mod/podium-reporter` for a session), how to run the server with `podiumctl` (4.4), how to run the simulator, the env vars (`PORT`, `HOST`, `PODIUM_DB`, `PODIUM_TOKEN`, `STALE_AFTER_MS`, `DROP_AFTER_MS`, `LINGER_MS`) and what is sent off the session (section 6.4).
  2. `docs/architecture/` documents the final architecture, the mod API findings, deviations from this spec with reasons, known issues, and the verification evidence.
  3. `.env.example` lists the new env vars with defaults.
  4. No `TODO` is left in code without a matching entry under "Known issues".

**Exit criterion:** a new reader can follow the README from a clean clone to a running dashboard with simulated sessions, and then to a real session, in under 10 minutes.

## Phase 5: Optional extensions (do only after Phase 4 passes; each is independent)

### T5.1 Classic hook ingest
- **Scope:** `server/src/fleet/hookIngest.ts`, route `POST /api/fleet/hook`, `docs/` snippet for `.claude/settings.json`.
- **Acceptance:** a `SessionStart`/`SubagentStart`/`SubagentStop`/`SessionEnd`/`Notification` payload (fixtures from the types file) produces a reduced session (name, cwd, agents by type, no usage) marked `reporter: "hooks"` in the UI with a note that context and cost are unavailable.

### T5.2 Failure explanations
- **Scope:** mod `explainFailures` option; `$.model.complete` with `model: "haiku"`, `effort: "low"`.
- **Acceptance:** default off; when on, a failed agent gets a ≤ 400-char `explanation` generated from the redacted `Failure` fields only (never transcript), at most one call per failure, never retried on error, usage cost counted in the session estimate.

### T5.3 History page
- **Scope:** `GET /api/fleet/history`, a `#/history` view.
- **Acceptance:**
  1. Lists past sessions by day with summary columns and opens a read-only orchestrator page from stored rows.
  2. The list is paged (#195): 25, 50 or 100 rows per page (default 50) with Previous, Next and a "Showing N to
     M of T" line, the same pager as Admin > Reporters, and the day selector stays a single day.
  3. "N sessions ended" is the day's total, not the rows on the page.
  4. Changing the day or the rows per page returns to page 1.
  5. The day, page, rows per page and opened session are kept in the address
     (`#/history?day=&page=&size=[&open=]`). Opening a session adds a browser history entry, so Back returns
     to the same page.
  6. Empty, loading and error states are unchanged, except that moving to another page keeps the current table
     on screen until the next page arrives (a change of day shows "Loading…" as before) (#273).

---

<!-- nav:start -->
---

Previous: [8. The UI](08-ui/README.md) · Up: [Specification](README.md) · Next: [10. Rules for the implementing agent](10-rules-for-the-implementing-agent.md)
<!-- nav:end -->
