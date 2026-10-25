---
title: "Phase log"
description: "What each build phase delivered, from the contract and scaffolding to the optional extensions and the code review pass."
group: "Project internals"
order: 9
---

# Phase log

This page records, phase by phase, what the build delivered and what each phase learned.

## Phase 0: contract and scaffolding

Built: `server/src/fleet/protocol.ts` (types and `validateReport`), the mod's copy of the Report types,
`docs/fixtures/report.sample.json`, `.gitignore` entries for `data/` and `*.sqlite*`, the Vite proxy to
`127.0.0.1:$PORT`, and the `podium:sim` and `podium:smoke` root scripts.

Verified: `npm test` (server 26, frontend 15 tests) and `npm run build` pass. The fixture validates. The two
Report blocks match.

Found: `import { DatabaseSync } from 'node:sqlite'` fails under vitest 2 (Vite strips the `node:` prefix
and then cannot resolve `sqlite`). `process.getBuiltinModule('node:sqlite')` works under vitest, `tsx` and
plain `node`, and is typed by `@types/node` 24, so `db.ts` uses it. No fallback to `better-sqlite3` was
needed.

## Phase 1: server

Built: `db.ts` (schema, migrations, `FleetDb` queries), `ingest.ts`, `derive.ts`, `fleet.ts`, `sse.ts`,
`sweeper.ts`, `routes.ts`, wiring in `server/src/index.ts` (binds `127.0.0.1` unless `HOST`, database at
`PODIUM_DB` or `data/podium.sqlite`, graceful shutdown on SIGINT/SIGTERM), and `scripts/podium-sim.ts`.

Verified by tests (server suite 91 tests, incl. the simulator's 4): idempotent ingest, agent retention and
abort-on-done, revive, sample deltas, blowout level (12 table cases), stale/drop/linger with an injected
clock, restart behavior, SSE throttle, client removal on write error, every route incl. 400/401/404/413,
event paging, and simulator determinism and report validity.

Verified by running: `npm run dev -w server` creates `data/podium.sqlite`, logs its URL and listens on
`127.0.0.1:4317` only (checked with `lsof`). With the simulator (`--sessions 5 --chaos`), `/state` showed
five sessions with agents, plans and 60-point series; `curl -N /stream` printed `snapshot`, then
`session`, `activity` and `tick`; after Ctrl-C the simulator reported all five `done`, and 8 s later the
live set was empty with `clearedToday: 5`.

Found while running: the newest series point was always 0 (the current second's sample is partial).
Fixed test-first (see Spec question 10).

## Phase 2: frontend

Built: `frontend/src/fleet/` (`FleetApp`, `useFleet`, `store.ts` reducer, `logic.ts`, `chart.ts`,
`format.ts`, `useTheme`, `themes.ts`, `tokens.css`, `ThemePicker`, `useResizable`, `usePanes`, `useHotkeys`,
`useIdle`, `useNow`, `useWallColumns`, `wallLayout.ts`, `storage.ts`, `fleet.css` and the components in 8.2)
and hash routing in `main.tsx` (`#/` fleet, `#/history`; the old `#/usage` app was removed in #30).

Verified by tests (frontend suite 89 tests, plus the old app's 15 that existed then):

- reducer actions and the 150 cap
- formatters at 0, 999, 1000, 1.5M, 3,600 s and 86,400 s
- all six sorts and every filter
- tree guides, cycles and orphans
- polyline points
- git line in all four cases
- blowout levels 1 and 2 on cards
- agent strip classes
- focus page navigation, selection kept across updates and cleared with a message on removal
- facts bar order
- charts (markers, caption, crosshair readout)
- tree sort, reverse and "Show as tree"
- plan states and empty text
- context bar thresholds
- activity paging, navigation from fail and blow rows, inert rows of ended sessions
- failure box
- "inherited" on forks
- hostile `<img onerror>` strings render as text
- resize handles (keys, drag, double-click, limits, throwing storage)
- copy and its fallback
- roles and labels
- theme persistence
- `useFleet` silence detection and reconnect

Verified in a real browser (Chrome, through Claude in Chrome) against the server and `podium-sim --sessions 6 --chaos`, at 1440 px and in light and dark:

- wall
- rail
- KPI strip
- cards
- legend
- orchestrator page (header, three charts with hover crosshair and readout, a blowout marker and caption, facts bar, plan, agent tree, flash on select)
- side panel (activity paging, a click on an "Open agent" row opened the session and agent and flashed the row, failure box with "The step went back to the plan")
- Model sort order in rail and wall
- text filter and its empty message
- a real mouse drag on the activity handle (340 to 510 px, saved)
- double-click reset
- Tab focus ring
- Copy resume command and Copy fork command ("Copied", then back)
- theme kept across a reload
- `#/usage` unchanged (the old app has since been removed)

Stopping the server showed "disconnected, retrying" at once; restarting it brought the page back in 2.3 s with no reload.

400 px: Chrome would not size the window that narrow, so the check ran in a 400 px same-origin iframe
of the app (media queries follow the iframe's width). Wall, orchestrator page and agent detail had
`scrollWidth` 381 in a 396 px viewport (15 px scrollbar): no horizontal scroll, in dark and light.

Found and fixed while running in the browser:

- The page was 28 px taller than the viewport and 172 px too wide at 400 px, both from visually hidden labels
  whose containing block sat outside their scroll container. Columns and the agent tree scroller now set
  `position: relative`.
- The resize handles shared the `.rail` / `.side` class names with the columns and lost their positioning. They
  are renamed `rz-rail` / `rz-side`.
- Long output lines widened the failure box and clipped its text.
- A pointer event without a usable `clientX` produced a NaN width (fixed test-first).
- The "now" caption of the peak chart was red with no blowouts.

## Phase 3: the reporter mod

Built: `mod/podium-reporter/` with `plugin.json` (eleven options as of 0.14.2), `hooks/hooks.json`,
`register.ts` (wiring), `state.ts`, `plan.ts`, `failures.ts`, `models.ts`, `report.ts`, `transport.ts`,
`git.ts`, `protocol.ts`, their tests, a `tsconfig.json` from the types header, and
`scripts/podium-mod-typecheck.sh`.

Verified: `claude plugin test mod/podium-reporter` (76 tests), `claude plugin validate` (passes, output
above), `tsc` against the engine's declarations (`scripts/podium-mod-typecheck.sh`), and a vitest
cross-check that a scripted mod Report passes the server's validator unchanged. Two real runs:

1. `claude --plugin-dir mod/podium-reporter --model haiku --output-format json -p "Use TaskCreate to add
   one task named 'List files'. Then use the Agent tool once (subagent_type Explore) to list the files in
   this directory. Reply with the file count."` in this repo: the session appeared in `/api/fleet/state`
   (28 one-second polls saw it running, waiting, then done) with model `claude-haiku-5-5`, effort
   `medium`, branch `feat/podium-fleet-console`, repo `eengelking/podium`, plan "List files"
   (done), one Explore agent (done, its own tokens and estimate), cost $0.014450 equal to the CLI's
   total; it ended (`endReason: other`) and left the live set ("session ended").
2. The same mod in a scratch git worktree with "Use the Agent tool once, with subagent_type
   general-purpose and effort low, asking it to reply with the word hello. Then reply done.": worktree
   detected, effort `low` at spawn.

## Phase 4: integration and hardening

Built: `scripts/podium-smoke.sh` (T4.1), `scripts/podium-soak.sh`, robustness tests
(`server/src/fleet/robustness.test.ts`, a two-minute outage test in the mod), README, `.env.example`.

Verified:

- `npm run podium:smoke`: every check passed in 28 s (4 live sessions with 18 agents, 60-point series,
  snapshot first, session, activity, tick and removed events, sessions gone after the linger time, the
  Vite proxy delivering 6 ticks over 10 s), nothing left running, temp files removed. A copy with a 30 s
  linger exited 1 with the two expected failures.
- T4.3.1: malformed JSON, raw control characters, a 1 MB body, 5,000 agents, deep nesting and wrong
  content types all get a 4xx; invalid UTF-8 does not crash it; the server serves normally afterwards.
  Reading chosen: "strings with control characters" are rejected only when raw (invalid JSON); escaped
  ones are valid JSON, so they are stripped and the report accepted (7.7 says to clamp strings, and
  terminal output carries ANSI escapes).
- T4.3.2: `podium-soak.sh --restart` killed the server with SIGKILL 40 s in and restarted it on the same
  database: right after, all 5 sessions were `stale`; 8 s later all were `running`.
- T4.3.3: in the kit, two minutes of server outage with events every 5 s lost none, and the reporter's
  own time per hook stayed at about 0.01 ms (0.03 ms worst) with the server down.
- T4.3.4: 10 sessions x 20 extra agents for 300 s with 3 SSE clients: every client kept receiving (150
  ticks each, 467 messages in the last 30 s); RSS 121.6 MB at 30 s, 131.7 MB at 300 s (see Known issues).
- T4.2: the checklist above, including the burst, the never-ending session and a real session watched
  live in the browser (run 3: two parallel Explore agents and a two-step plan; cost equal to the CLI's).
- `npm run build` then `npm run start -w server` serves the built UI and API from one port.

## Phase 5: optional extensions

Done after Phases 0 to 4 passed.

- **T5.1 classic hook ingest.** `server/src/fleet/hookIngest.ts` and `POST /api/fleet/hook`. Payloads
  shaped from the engine's `ClassicHookInputs` (SessionStart, UserPromptSubmit, SubagentStart, PostToolUse,
  SubagentStop, Notification, Stop, SessionEnd) build a reduced session marked `reporter: 'hooks'`; the UI
  labels it "settings hooks" and says context, cost and the plan are unavailable. Tested through the
  route, and the README's curl command was run against the dev server (it exits 0 with the server down).
- **T5.2 failure explanations.** `explainFailures` (default off) asks `haiku` at `low` effort for at most
  two sentences per failed agent, from the redacted failure record only; one call per failure, never
  retried; its estimated cost is added to the agent's. Tested in the kit (off: no call; on: an erroring
  call is not retried, a later failure is explained once, secrets stay out of the prompt). Not run
  against the real model.
- **T5.3 history page.** `#/history` lists the sessions that ended or were dropped on a chosen day and
  opens a read-only orchestrator page with agent detail from stored rows. Tested with a mocked server and
  checked in Chrome by DOM (86 sessions listed for the day, one opened, no horizontal overflow); the
  window was hidden by then, so no screenshot.
- **History paging (#195).** The server pages. `GET /history` takes `page` and `pageSize` (25, 50 or 100,
  default 50) and answers `{ day, sessions, total, page, pageSize }`, so a busy day is not sent whole.
  - `Fleet.historyPage` filters out unused sessions and sorts the stored rows newest first (the session id
    breaks ties, so a row does not move between pages). It clamps a page past the end to the last one, and only
    then builds the rows of that page, so the agents query and the repricing run once per row shown, not once
    per session of the day (#273).
  - The page reuses Admin's `Pager`. Day, page, size and the opened session live in the hash
    (`#/history?day=&page=&size=&open=`).
  - `HistoryView` writes the hash with `pushState` when a session opens and `replaceState` for every other
    change, and re-reads it on `popstate`, so the browser's Back button returns to the same page. `main.tsx`
    listens only to `hashchange`, which neither call fires, so the view is not remounted.
- **The open orchestrator in the address.** The live console follows History's pattern. `route.ts` reads and
  writes `#/?open=<id>` (`openIn`, `fleetHash`); `routeFor` already sends that hash to the fleet console.
  - `FleetViewBody` starts its selection from the address. `open()` is the one place that opens an orchestrator or
    the wall: from the wall it calls `pushState({ open: true })`, between orchestrators `replaceState`, and closing
    calls `history.back()` when the entry's state says the console pushed it, else `replaceState` to `#/`. From
    the board, My reporters or Traffic it sets `location.hash`, since the route changes too.
  - A `popstate` and `hashchange` listener re-reads the address, which covers Back, Forward and plain links such
    as the logo. A ref holds the selection the console last wrote, so the listener does not clear the agent an
    activity event just opened.
  - A session that leaves the fleet, or an address naming one it never had, clears the selection and replaces
    the address with `#/`.
  - Tests start each one at the wall: `setupTests.ts` drops a fleet `open=` after every test, and `atWall()` in
    `testState.ts` resets it inside a test that renders the console twice.

## Code review pass (before the PR)

One `/code-review` pass over the branch found ten issues. Nine are fixed, each with a test written first
that failed for the reason described; the tenth (a `tz` parameter for `GET /history`) is deliberately left for later.

- **SubagentStop flipped a working session to waiting** (`hookIngest.ts`). Only `Stop` means the main loop
  is idle now.
- **Hooks overwrote a mod-reported session** (cost, tokens, plan, blowouts, reporter). A hook for a session
  whose stored reporter is not `hooks` is acknowledged and ignored.
- **Hook-only sessions went stale after 15 s and were dropped at 75 s** though alive, because hooks send
  no heartbeat. They now use `HOOK_STALE_AFTER_MS` (default 10 minutes); the drop window follows it.
- **A rejected (400/413) report was re-posted every flush tick.** The transport now backs off 1, 2, 5, 10 s
  after a rejection as it does after a failure, and a success clears it.
- **`explained` was keyed by agent only,** so a retried agent that failed again was never explained. It is
  keyed by the failure's time too. A failed model call is still not retried, as the spec says.
- **Every Notification counted as a wait.** Only permission, idle and elicitation notifications do.
- **Hook event ids** now carry a digest of the payload and the second, so two different hooks in one
  millisecond keep both events, and the same payload retried at once is still one event.
- **`SseHub.add` returning null was reported as "too many clients"** even when the client had gone. The
  route checks `isFull` first and says nothing to a client that is already gone.
- **`clockSkew`** is forgotten when a session leaves the live set or is deleted.
- **`GET /history`** rejects days that do not exist (2026-02-31) with a 400. The day is still the server's
  local calendar day, which is right for a tool that runs on one machine; a `tz` parameter is deferred.

<!-- nav:start -->
---

Previous: [Dependencies added](08-dependencies-added.md) · Up: [Architecture](README.md) · Next: [Running as a service](10-running-as-a-service.md)
<!-- nav:end -->
