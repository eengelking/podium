---
title: "End-to-end test coverage"
description: "What the Cypress suite covers, feature by feature, what it leaves out and why, and how to run it, read a failure and add a spec."
group: Project internals
---

# End-to-end test coverage

This page maps every feature of the console to the end-to-end spec that covers it, says what the suite leaves out and
why, and shows how to run it, read a CI failure and add a spec. It is for a contributor changing a feature. The platform
choice (Cypress in a container, against Podium's own image) is [decision 49](../decisions/49-end-to-end-tests-run-cypress-from-an-e2e-folder-against-the-built.md); what each
feature must do is in [docs/spec/](../spec/README.md). `node scripts/e2e-map.mjs` checks this page against the repository on
every `npm test`: a spec, a source file, a route or a test id named here that no longer exists fails it, and so does a spec
that is not named here. That check proves the names exist, not that a spec proves the row: what a row claims is what the named spec asserts, and a reader should open the spec to see it.

Contents:

- [Run it locally](#run-it-locally)
- [Read a CI failure](#read-a-ci-failure)
- [Add or change a spec](#add-or-change-a-spec)
- [Test ids](#test-ids)
- [The seed](#the-seed)
- [The map](#the-map)
- [What no end-to-end spec can reach](#what-no-end-to-end-spec-can-reach)
- [What is left to unit tests](#what-is-left-to-unit-tests)
- [What is still open](#what-is-still-open)

## Run it locally

You need Podman or Docker, and `npm ci --ignore-scripts` run once at the repo root (the suite mounts `node_modules/axe-core`
from it). Nothing else is installed: Cypress runs from the official `cypress/included` image, pinned by version and
digest in `scripts/e2e-up.sh`, and the server is Podium's own image built from the `Containerfile`.

```sh
npm run e2e                                    # the whole suite
npm run e2e -- -- --spec "cypress/e2e/wall/**" # one folder (everything after the second -- goes to Cypress)
npm run e2e -- --no-build                      # reuse the image built by the last run
npm run e2e:down                               # remove anything an interrupted run left behind
```

`scripts/e2e-up.sh --help` lists the options. A run builds the image, makes a private network with a fresh admin secret that
nothing prints, starts the server on it, seeds it with `scripts/e2e-seed.mjs`, runs Cypress in a second container and then
removes every container, network and volume it made, whatever the result. No port is opened on your machine and your own
Podium is never touched. The first run pulls the Cypress image, about 2.5 GB.

## Read a CI failure

The suite does not run in CI yet. The `E2E` workflow (`.github/workflows/e2e.yml`) is manual only ("Run workflow") until the suite is
solid on a GitHub runner; a first try on a runner timed out on the first request after a server restart in several spec files (see decision 49, "How the runner reaches the server"). To try a slow machine locally, set `E2E_CPUS` and `E2E_MEMORY` (for example 2 and 4g). Its last job, `E2E summary`,
passes when the run was skipped, so it can be a required check once the workflow runs on pull requests again.

1. Open the failed job and find the spec file and test title in the Cypress output: the group is the feature, the title is the rule.
2. Download the `e2e-failure` artifact from the run. It holds `screenshots/<spec>/<test> (failed).png`, one for each failure, and
   `server.log`, the server's log with the admin secret scrubbed. It is kept 7 days. There is no video.
3. A run with `repeat` set (Actions, Run workflow) does the whole suite that many times in one job and stops at the first failure.
4. To reproduce it, run the same spec locally with `--spec`. A failure that shows only on some runs is a flaky spec: do not
   add a retry or a wait. Find the assertion that reads something before it settles and make it a retrying one.

## Add or change a spec

A change to what the console does comes with its specs in the same PR. Load the `podium-e2e-update` skill (or start the
`podium-e2e-keeper` agent): it works out which specs the change touches, updates them and this map, and runs the whole suite
to green. By hand:

1. Put the spec in the folder of its area under `e2e/cypress/e2e/`, named for what it covers. The first lines say which SPEC section it checks.
2. Start with `before(() => cy.resetServer())`. It restarts the server on an empty database and seeds it, so a spec file never depends on another. `cy.resetServer({ seedArgs: '--bulk 30' })`, `{ env: ['STALE_AFTER_MS=2000'] }` and `{ noSeed: true }` change the data or the server's timings.
3. Open a page with `cy.openConsole('#/board')` (it waits until the stream is live). Sign in with `cy.signIn('Ed')` or `cy.signIn('Admin')`, unlock Admin with `cy.unlockAdmin()` or `cy.openAdmin('Settings')`. They set the cookie with a request: the admin secret is never typed into a field and never logged.
4. Make a change happen with `cy.reportAgain('api', { costUsd: 7.25 })` (a reporter's next report), `cy.setFlags({ respond: false })`, `cy.task('server:pause')` and `server:resume`.
5. Assert with Cypress's retrying queries. Never `cy.wait(ms)`, never read a clock-derived value, never rely on a count that can still be changing. The config has `retries: 0` on purpose.
6. Add the feature to the map below, with the spec file in a code span. Then `node scripts/e2e-map.mjs` and the whole suite.

A violation axe finds is passed to `cy.checkA11y({ known })` only when it is real, tracked and not yet fixed; the call
fails if a violation in it is no longer reported.

## Test ids

Select by what a person or a screen reader sees first: an ARIA role and name, a label, an `id` that is part of the page's contract
(`#podium-top`, `#podium-sort`, `#admin-new-name`, `set-feature-<flag>-n` on a settings switch), or the text. Add a `data-testid` only
where none of those singles the element out. The convention is a kebab-case name for the thing (`page-pill`, `connection-pill`), a
`data-state` for a state the spec waits for (`connection-pill` is `loading`, `live` or `disconnected`), and no id that carries data or a
random suffix: the seed gives sessions fixed ids instead, so `cy.card('api')` finds the card by `data-session`. A `data-testid` changes nothing a
person sees, is added in the same PR as the spec that needs it, and is only added when the spec needs it. The check in `npm test`
fails on a spec that uses a test id no frontend source defines. The ids today are `connection-pill` in
`frontend/src/fleet/components/ConnectionPill.tsx` and `page-pill` in `frontend/src/fleet/components/TopBar.tsx`.

## The seed

`scripts/e2e-seed.mjs` (`--help` lists its options) puts the same twelve sessions, two people (Ed, and Alex in the group Platform),
four machines, plans, agents, a failure, blowouts, changed files and waiting questions, plans and tool permissions into the server
through its own routes, so the server derives everything the console shows. Ids, names and costs are fixed; the person tokens are fake and new for each database. Options add
filler sessions for paging (`--bulk`), ended sessions for History (`--ended`), messages between orchestrators (`--talk`), recorded sessions
(`--recording`), a rich plan and Board paging (`--rich`), reporters of other versions, one with the admin secret and one with no mod (`--reporters`), stored activity history (`--stored`), and sessions Claude Code compacted on its own (`--compaction`); `--flags` chooses the feature flags (`defaults` leaves them as the server starts). The suite plays the reporter mod too: `e2e/support/diffs.cjs` answers
the console's file-diff requests, and `cy.reportAgain` sends a reporter's next report.

## The map

Each row is a feature, the part of the spec that states it, and the spec files that cover it. "Covered by" names the file whose tests assert the row; `node scripts/e2e-map.mjs` only checks that the name exists, so what a spec really asserts is read in the spec. A feature, or a part of one, that cannot be
checked this way is under "What no end-to-end spec can reach" and says why.

### Shell

| Feature | Spec | Covered by |
|---|---|---|
| Top bar: buttons per page, page pill, connection pill, the Admin button only for an Administrator | SPEC 8.1 Shell | `e2e/cypress/e2e/shell/top-bar.cy.js` |
| The built bundle loads with no console error; the server's version equals `package.json` | SPEC 8.1 Shell | `e2e/cypress/e2e/shell/smoke.cy.js` |
| Theme picker: dropdown, Light/Dark/System, arrow keys, `podium.theme`, applied before first paint, `prefers-color-scheme` | SPEC 8.1 Theme picker | `e2e/cypress/e2e/shell/theme.cy.js` |
| Refresh every and its storage; the Shortcuts switch, `[`, `]` and `\`, ignored while typing; collapse of each pane and the top bar and `podium.collapsed`; resize handle by key, Shift and double-click and the width kept in `podium.panels`; the legend sits between the rail and the right pane; rail footer | SPEC 8.1 Refresh every, Legend, Columns, Collapsing | `e2e/cypress/e2e/shell/display-settings.cy.js` |
| Wall mode: collapse all, Esc, Exit, the browser leaving fullscreen, idle hide, the `w` key; a refusal of real fullscreen changes nothing (the real call is stubbed in the other tests) | SPEC 8.1 Wall mode | `e2e/cypress/e2e/shell/wall-mode.cy.js` |
| Layout: no sideways scroll at 400 px on every page including Admin, no edge-tab overlap (#787), stacked panes, card columns, tile and facts columns, wall mode fills the window | SPEC 8.1 Columns, Wall columns | `e2e/cypress/e2e/shell/responsive.cy.js` |
| The tab's title follows the route; the edge tab's own transition applies unless the reader prefers reduced motion (read from the stylesheet under each emulated setting); the effort meter at each level; People view ordered by Spend | SPEC 8.1 Effort meter, SPEC 8.4 | `e2e/cypress/e2e/shell/misc.cy.js` |
| axe (color-contrast and target-size) on the six pages, light and dark, 1440 and 400 px | SPEC 8.4 | `e2e/cypress/e2e/a11y/axe.cy.js` |
| axe on the orchestrator page, the sign-in, report, respond, record and file-diff dialogs and the activity dialog, and on every Admin page | SPEC 8.4 | `e2e/cypress/e2e/a11y/axe-more.cy.js` |
| A card changes with no reload; the pill and alert when the server stops, and recovery; the alert with everything collapsed | SPEC 8.1 Data flow, Collapsing | `e2e/cypress/e2e/wall/live.cy.js` |

### Wall

| Feature | Spec | Covered by |
|---|---|---|
| KPI tiles; cards: bands, git line, plan, cost, context, long names, copy id | SPEC 8.1 Fleet wall | `e2e/cypress/e2e/wall/cards.cy.js` |
| The Comp pill: after the Context label on the card and in the orchestrator's panel, its title and hidden text count the automatic compactions, beside the blowout badge, inside the card at 400 px, axe in both themes | SPEC 8.1 Session cards | `e2e/cypress/e2e/wall/comp-pill.cy.js` |
| Toolbar: status segments, the sorts (Cost, Context used, Context blowouts, Model, Status, Newest, each checked against the seed's order), the filter, "N shown, M cleared today" | SPEC 8.1 Toolbar | `e2e/cypress/e2e/wall/toolbar.cy.js` |
| Heartbeat lost: the card's line and countdown, the full sentence, the KPI count and Remove | SPEC 8.1 Session cards | `e2e/cypress/e2e/wall/stale.cy.js` |
| Rail items, selection, paging, the selection on another page, no paging when stacked | SPEC 8.1 Left rail | `e2e/cypress/e2e/wall/rail.cy.js` |
| People view: bands, collapse, group by, order by Name, Me | SPEC 8.1 People view | `e2e/cypress/e2e/wall/people-view.cy.js` |
| Wall notices: background sessions, the X, the confirmation toast, errors are never notices | SPEC 8.1 Wall notices | `e2e/cypress/e2e/wall/notices.cy.js` |
| Empty states of the wall, the board, History and Traffic | SPEC 8.1 Fleet wall | `e2e/cypress/e2e/wall/empty.cy.js` |
| Pinned cards (#496): the button's names and `aria-pressed`, `podium.pins` as {id, slot}, a pin holds its slot under another sort and when the card changes, a filter hides it with no gap and it returns, kept over a reload | SPEC 8.1 Pinned cards | `e2e/cypress/e2e/wall/pins.cy.js` |

### Orchestrator page and right panel

| Feature | Spec | Covered by |
|---|---|---|
| Address, header, charts, the twelve facts, copy and popups, status band, Plan and Files tabs, fold, agent tree sort | SPEC 8.1 Orchestrator page | `e2e/cypress/e2e/orchestrator/page.cy.js` |
| Agent panel, failure and blowout boxes, Report dialogs, activity feed, expand, the event list | SPEC 8.1 Right panel | `e2e/cypress/e2e/orchestrator/agents.cy.js` |
| Plan order (#454) and paging, plan complete, Files paging, nested agents, Tools used and Show all, the event list's 12 more | SPEC 8.1 Plan section, Tools used | `e2e/cypress/e2e/orchestrator/plan-and-files.cy.js` |
| File diff dialog: sides, stepping and its last file, binary, withheld, too large, cut, renamed (R mark and old name) and deleted files, wrap, preload (every file asked for before a click, none when off), one column when narrow, 504 and 429 (asked again on reopening), who may open it | SPEC 8.1 Files | `e2e/cypress/e2e/orchestrator/file-diff.cy.js` |

### Board, History, Traffic and My reporters

| Feature | Spec | Covered by |
|---|---|---|
| Board: columns, cards, the strip, Plans/All, Mixed/By orchestrator, Group, My orchestrators, tiles, KPI fold, narrow tabs, live movement, and a finished plan's open work leaving the board | SPEC 8.1 Kanban board | `e2e/cypress/e2e/board/board.cy.js` |
| Board: a column pages at 25 (the Blocked column lists a blocked step) | SPEC 8.1 Order, paging and layout | `e2e/cypress/e2e/board/board-paging.cy.js` |
| History: day picker, table, paging, address, a stored session's page, empty and error (the browser's date is held at the moment of the reset, so the day does not change during the file; a reset that itself straddles midnight is not covered) | none (#792); from `frontend/src/fleet/HistoryView.tsx` | `e2e/cypress/e2e/history/history.cy.js` |
| Traffic: map, table, the range buttons (whether they narrow the list is a stated gap below), conversation, pause and remove (kept after a reload), empty, flag off | SPEC 8.1 Traffic page | `e2e/cypress/e2e/messaging/traffic.cy.js` |
| Traffic for a non-owner and the Admin; a failed Pause and a failed Remove, each with its message | SPEC 8.1 Traffic page | `e2e/cypress/e2e/messaging/messaging-more.cy.js` |
| My reporters: requests, reporters, defaults, limits, rights grid and board, empty variants, flag off | SPEC 8.1 My reporters page | `e2e/cypress/e2e/messaging/my-reporters.cy.js` |
| My reporters: Decline, a limit above the Admin's, a failed save puts the control back, the Board's Move to list (the card lands in the chosen level's column and its count rises by one) | SPEC 8.1 My reporters page | `e2e/cypress/e2e/messaging/messaging-more.cy.js` |

### Sign-in, Respond and Recording

| Feature | Spec | Covered by |
|---|---|---|
| Sign-in dialog: empty, wrong, success, sign out, no token kept | SPEC 8.1 Signing in | `e2e/cypress/e2e/respond/sign-in.cy.js` |
| Respond button gating and the modal for each kind of ask | SPEC 8.1 Responding | `e2e/cypress/e2e/respond/respond.cy.js` |
| Answering: each answer's request body (plan, Allow once, Deny with its reason, a question's answers, a message, /clear, /compact), what the session's hook is handed for an ask (read from the server as the mod would) and the reporter's next check-in carrying a message and a command, with its sender (Ed, or the Admin), the "You, from Podium:" entry, "<Name>, from Podium:" for another person's message, the notes the reporter's result adds (queued, cleared), a reporter's limits removing an ask kind, and what the console says for HTTP 500, 422, 429 and 403 | SPEC 8.1 The modal, The feed | `e2e/cypress/e2e/respond/answer.cy.js` |
| Recording: the notice, the picker's states, start, stop, delete, replay with its loop filter, slider and Jump, History line, and a subset of loops ("Recording 3 of 4 loops") | SPEC 8.1 Session recording | `e2e/cypress/e2e/recording/recording.cy.js` |

### Admin

| Feature | Spec | Covered by |
|---|---|---|
| Lock screen, who may open Admin, the menu, count badges, Lock Admin, the narrow menu, no token | SPEC 8.1 Admin layout | `e2e/cypress/e2e/admin/access.cy.js` |
| People: create, token shown once, search, group, the actions menu by mouse and by key, rotate, revoke, delete, bulk select; Groups | SPEC 8.1 People, Groups | `e2e/cypress/e2e/admin/people-groups.cy.js` |
| Reporters: filters, search, sort, details, ignore rules, removal | SPEC 8.1 Reporters page | `e2e/cypress/e2e/admin/reporters.cy.js` |
| Reporters: outdated and newer versions and the top bar's counts, the admin-secret band and Show only these, the details of both, ignoring a version, Select all, "Not since restart" | SPEC 8.1 Reporters page | `e2e/cypress/e2e/admin/reporters-states.cy.js` |
| Settings: the flags (each off, kept, on), warning bars, messaging limits, recording limits and their refusals, wall notices, the wall, forget old reporters; the recordings table with Stop | SPEC 8.1 Feature flags | `e2e/cypress/e2e/admin/settings.cy.js` |
| Model prices: edit, cancel, Reset to built-in, add and Remove a model, a duplicate, an invalid price with `aria-invalid` and its message; a price change reprices a session's card ($0.42 to $16.20) and Spend today | SPEC 8.1 Model prices | `e2e/cypress/e2e/admin/model-prices.cy.js` |
| Reporters: Idle, after two minutes without a report, with no reload. This is the one real-time wait in the suite, about 2.5 minutes of every run, a retrying assertion on the server's own threshold, not a fixed sleep | SPEC 8.1 Reporters page | `e2e/cypress/e2e/admin/reporters-idle.cy.js` |
| Activity history (#432): the feed's newest 20, Show older to the start, the stored count, "Kept until" under each policy, the refusal to a viewer who may not read; Stored activity's totals, filters (one that narrows to a row, two that empty the list, and the empty-state text), selection bar, and the delete flows (selected, matching a filter, everything); the policy form's period and size-cap rows, saved and refused | SPEC 8.1 Data and Stored activity, Activity section | `e2e/cypress/e2e/admin/stored-activity.cy.js` |
| Security, Certificates (TLS off), Data and the activity-history policy, Stored activity's empty state and source, Admin log (a later entry listed before an earlier one) | SPEC 8.1 Data and Stored activity | `e2e/cypress/e2e/admin/server-pages.cy.js` |
| Reporting: Usage, Spend (today, projection, breakdown), People and groups, Sessions, Failures, Admin activity; period, CSV and JSON content, Print, the remembered choice | SPEC 8.1 Reporting, Spend | `e2e/cypress/e2e/admin/reporting.cy.js` |

### Feature flags

| Flag | Covered by |
|---|---|
| All seven: the defaults of a fresh server (five off, `activity-feed` and `update-check` on), with nothing enabled | `e2e/cypress/e2e/flags/defaults.cy.js` |
| All seven: each off, kept over a reload, and on again, in Admin > Settings and in `/api/fleet/state` | `e2e/cypress/e2e/admin/settings.cy.js` |
| `activity-feed` on, off, and on with the reporter's `activityFeed` off | `e2e/cypress/e2e/flags/activity-flags.cy.js` |
| `activity-output` on, off, and on with `activityOutput` off | `e2e/cypress/e2e/flags/activity-flags.cy.js` |
| `respond` on and off, and a reporter that cannot answer | `e2e/cypress/e2e/respond/respond.cy.js` |
| `file-diff` on, off, and on with `fileDiff` off | `e2e/cypress/e2e/orchestrator/file-diff.cy.js` |
| `peer-messaging` on, off, and on with a machine's `peers` off | `e2e/cypress/e2e/flags/messaging-flag.cy.js` |
| `session-recording` on, off, and on with the reporter's option off | `e2e/cypress/e2e/recording/recording.cy.js` |
| `update-check`: the switch only; the notice it produces is a stated gap below | `e2e/cypress/e2e/admin/settings.cy.js` |

### Server routes the suite drives

They are listed so a route that is renamed or removed shows up in the check.

| Route | Reached by |
|---|---|
| `GET /api/fleet/health` | `e2e/cypress/e2e/shell/smoke.cy.js` |
| `GET /api/fleet/history` | `e2e/cypress/e2e/history/history.cy.js` |
| `GET /api/fleet/respond/me` | `e2e/cypress/e2e/respond/sign-in.cy.js` |
| `POST /api/admin/unlock` | `e2e/support/commands.js`, `e2e/cypress/e2e/admin/access.cy.js` |
| `PUT /api/admin/settings` | `e2e/cypress/e2e/admin/settings.cy.js` |
| `GET /api/admin/groups` | `e2e/cypress/e2e/admin/access.cy.js` |
| `PUT /api/admin/people/:id/group` | `e2e/cypress/e2e/admin/access.cy.js` |

## What no end-to-end spec can reach

Each of these is a stated gap, not a covered feature.

| Feature | Why |
|---|---|
| Admin idle lock (10 minutes), Respond sign-in ending after 12 hours of idleness, sign-in lockout | Their timings cannot be reached without a test-only timing knob, which was left out on purpose. Tracked in #791. |
| Real Fullscreen API | Headless Chrome refuses the request, because Cypress's clicks are not a user gesture. The spec checks that a refusal changes nothing and, with `requestFullscreen` stubbed, the app's own wall-mode state. The real call is checked by hand. |
| Real TLS: the Certificates page with a CA, the reporter certificate and its renewal | The throwaway server is plain HTTP. Covered by `server/src/tls*.test.ts` and `frontend/src/fleet/admin/certificates.test.tsx`. |
| The reporter mod inside Claude Code | Out of scope (`npm run test:mod`). The suite plays the mod's reports and its diff answers. |
| The release-check notice at the bottom of the wall | It needs a newer release from GitHub. Only the switch is covered; the notice is covered by `frontend/src/fleet/wall.test.tsx`. |
| Admin > Reporting with 45 days of history | The history needs `scripts/podium-seed-history.ts`, which needs `tsx`, which no container here carries, and no route writes rollups. The pages are checked for shape and for today's live figures. Covered by `frontend/src/fleet/admin/reporting.test.tsx` and `server/src/fleet/rollups.test.ts`. |
| Traffic's range filter (Last 24 hours and Last 30 days narrowing the list) | A message older than a day cannot be made: the server stamps every message with its own clock. The range buttons are clicked and the list is asserted unchanged for recent messages only. |
| Reporters in the Silent state (over an hour without a report) | The one-hour threshold is a constant in `server/src/storage/rows.ts` and the server stamps a report with its own clock, so reaching it takes an hour or a test-only clock. Idle (two minutes) and "Not since restart" are covered. |
| An untracked file's diff as its own case | A file the reporter lists as untracked arrives as status `added` (`server/src/fleet/protocol.ts` has no fifth status), so it is the added file in `e2e/cypress/e2e/orchestrator/file-diff.cy.js`. |
| History's Resume and Fork cells | The spec and the page disagree (see below), so neither reading is asserted. |

## What is left to unit tests

The suite does not repeat what a unit test already settles and a browser adds nothing to: card text, sort and filter arithmetic, board grouping
(`frontend/src/fleet/board.test.ts`), rail page math (`frontend/src/fleet/railPages.test.ts`), the derive rules and ingest validation
(`server/src/fleet/derive.test.ts`), markdown rendering (`frontend/src/fleet/components/Markdown.test.tsx`), the CSV neutralizing, validation
messages, and the standards pages (`npm run standards:parity`). A feature with only unit coverage and a layout, focus or live-update behavior gets a spec for that part.

## What is still open

- **History draws Resume and Fork cells that SPEC 8.1 says it does not.** The page reuses the orchestrator page (`frontend/src/fleet/HistoryView.tsx` renders `FocusView`), and the maintainer accepts that. The suite asserts neither.
- **Known axe findings.** None. #794 to #800 were the last, and their `known` entries are gone from `e2e/cypress/e2e/a11y/axe.cy.js` and `axe-more.cy.js`.
