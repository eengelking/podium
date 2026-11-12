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
E2E_DB=postgres npm run e2e                    # the same suite with PostgreSQL behind the server (default: sqlite)
E2E_DB=mariadb npm run e2e                     # the same suite with MariaDB behind the server
```

`scripts/e2e-up.sh --help` lists the options. `bash scripts/e2e-all.sh --out <folder outside the repo>` runs the whole suite once on every database in `e2e.yml` together and ends with one `E2E RESULT:` line. `--shards N` splits each database's run into N runs at once, each with its own server, database and Cypress container and a disjoint group of the spec files, which `scripts/e2e-shards.mjs` computes from the files on disk (a new spec lands in a group by itself). It balances the groups by the seconds each spec took in a recorded run, kept in `e2e/spec-times.json`, and weighs a spec with no recorded time at the median; `node scripts/e2e-shards.mjs --record <logs>` refreshes the file from the logs of a whole run. The result line names each shard, and the specs counted over a database's shards must equal the files on disk. Each run logs how long each server restart, pause and resume took, and their totals at its end. `bash scripts/e2e-all.sh --help` says how to choose N for a machine: each run takes about 1.1 GB, so keep N times the databases at most the CPUs and at most the memory in GB divided by 2. On a 6-CPU, 16 GB podman machine it was 3 for two databases (about 7m20s against 16m40s for one shard), and the same rule gives 2 for the three databases of today; 4 was no faster, and one 4-shard run had a shard hang for 15 minutes, cause not known. To see what the machine does while a run goes, start `python3 -I scripts/e2e-sample.py 5 > <file>.csv` beside it: it records the host's load and busy percent, and each container's CPU and memory, every few seconds (`--help`). With `E2E_DB=postgres` a PostgreSQL container (`E2E_PG_IMAGE`, default `postgres:17-alpine`) runs beside the server on the same private network, the server gets `PODIUM_DB=postgres://...` for it, and the specs' "fresh database" restart drops and recreates that database instead of emptying `/data`. Its password is random per run and scrubbed from the server log copy. `E2E_DB=mariadb` does the same with a MariaDB container (`E2E_MARIADB_IMAGE`, default `mariadb:11.4.13`, the version tested, pinned). The databases, their images and their reset commands are one table, `scripts/db-adapters.mjs`, which `E2E_DB` is checked against. The specs are the same for every database. A run builds the image, makes a private network with a fresh admin secret that
nothing prints, starts the server on it, seeds it with `scripts/e2e-seed.mjs`, runs Cypress in a second container and then
removes every container, network and volume it made, whatever the result. No port is opened on your machine and your own
Podium is never touched. The first run pulls the Cypress image, about 2.5 GB.

## Read a CI failure

The `E2E` workflow (`.github/workflows/e2e.yml`) runs on the release PR (`development` to `main`) and on a manual "Run workflow", not on a PR
into `development`; a first try on a runner timed out on the first request after a server restart in several spec files (see decision 49, "How the runner reaches the server"). To try a slow machine locally, set `E2E_CPUS` and `E2E_MEMORY` (for example 2 and 4g). Its last job, `E2E summary`,
passes when the run was skipped, so it can be a required check for the release PR.

1. Open the failed job and find the spec file and test title in the Cypress output: the group is the feature, the title is the rule.
2. Download the `e2e-failure` artifact from the run. It holds `screenshots/<spec>/<test> (failed).png`, one for each failure, and
   `server.log`, the server's log with the admin secret scrubbed. It is kept 7 days. There is no video.
3. The workflow's `databases` input (default `sqlite postgres mariadb`) picks which database the server runs on; each is a full run of the suite, one after the other, so the job's limit is 240 minutes. Run it with one database alone to reproduce a failure on it. A run with `repeat` set (Actions, Run workflow) does the whole suite that many times in one job and stops at the first failure.
4. To reproduce it, run the same spec locally with `--spec`. A failure that shows only on some runs is a flaky spec: do not
   add a retry or a wait. Find the assertion that reads something before it settles and make it a retrying one.

## Add or change a spec

A change to what the console does comes with its specs in the same PR. Load the `/podium-e2e-update` skill (or start the
`podium-e2e-keeper` agent): it works out which specs the change touches, updates them and this map, and runs the whole suite
to green. By hand:

1. Put the spec in the folder of its area under `e2e/cypress/e2e/`, named for what it covers. The first lines say which SPEC section it checks.
2. Start with `before(() => cy.resetServer())`. It restarts the server on an empty database and seeds it, so a spec file never depends on another. `cy.resetServer({ seedArgs: '--bulk 30' })`, `{ env: ['STALE_AFTER_MS=2000'] }` and `{ noSeed: true }` change the data or the server's timings. The test-only timings (`PODIUM_TEST_TIMINGS=1` with `PODIUM_TEST_ADMIN_IDLE_MS`, `PODIUM_TEST_SIGN_IN_IDLE_MS` or `PODIUM_TEST_LOCK_MS`) go in `env` the same way (DECISIONS 50).
3. Open a page with `cy.openConsole('#/board')` (it waits until the stream is live). Sign in with `cy.signIn('Ed')` or `cy.signIn('Admin')`, unlock Admin with `cy.unlockAdmin()` or `cy.openAdmin('Settings')`. They set the cookie with a request: the admin secret is never typed into a field and never logged.
4. Make a change happen with `cy.reportAgain('api', { costUsd: 7.25 })` (a reporter's next report), `cy.setFlags({ respond: false })`, `cy.task('server:pause')` and `server:resume`.
5. Assert with Cypress's retrying queries. Never `cy.wait(ms)` (`npm run e2e:map` fails on one), never read a clock-derived value, never rely on a count that can still be changing. The config has `retries: 0` on purpose.
   A value is never read once with `.then()` or `.invoke(...).then(...)` and then parsed, compared or asserted on when it may not have rendered or settled yet (a count shows `–` until its list loads). Match it inside `should(($el) => ...)`, or with a query and a matcher such as `contains('button', /^Idle\s*4$/)`, so the read retries. A read once is allowed only where the value is settled by what the spec already waited for, and a one-line comment says why.
   A click, a type, a select or a blur that starts a write or a redirect is not followed by a reload, a visit or a read of another page until the page has finished it: assert what the page shows or the address it ends on, or wait for the write with `cy.intercept(...).as('x')` and `cy.wait('@x')` (never `cy.wait(ms)`). Otherwise a slow server lets the next step cut the write off or take the page somewhere else.
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
fails on a spec that uses a test id no frontend source defines. Two examples are `connection-pill` in
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
| Theme picker (in the Wall options drawer): dropdown, Light/Dark/System, arrow keys, `podium.theme`, applied before first paint, `prefers-color-scheme` | SPEC 8.1 Theme picker | `e2e/cypress/e2e/shell/theme.cy.js` |
| Refresh every and its storage; the Shortcuts switch and its word as a link to the list of keys (closed by the X, Esc or a click outside, which leave the Wall options drawer open, stacked at 400 px), `[`, `]` and `\`, ignored while typing; collapse of each pane and the top bar and `podium.collapsed`; resize handle by key, Shift and double-click and the width kept in `podium.panels`; the legend sits between the rail and the right pane; rail footer | SPEC 8.1 Refresh every, Legend, Columns, Collapsing | `e2e/cypress/e2e/shell/display-settings.cy.js` |
| Wall options drawer (#1129): shut on every page load as one "Wall options" pill with `aria-expanded` and `aria-controls`; open, the pill is the collapse button at its left end, then Refresh every, Shortcuts, Theme and the Mode radios in that order; closed by the pill, a press outside (the wall, the banner's text) and Escape, which puts focus back on the pill; clicks inside, a change of theme and mode included, keep it open; on Live fleet, Board, My reporters, Traffic's retired address, Chat, History and Admin; Refresh every and Shortcuts set on Admin show on Live fleet and History; fits at 400 px; axe on it open, light and dark, 1440 and 400 px | SPEC 8.1 Theme picker, Refresh every, Collapsing | `e2e/cypress/e2e/shell/wall-options.cy.js` |
| Wall mode: collapse all, Esc, Exit, the browser leaving fullscreen, idle hide, the `w` key; a refusal of real fullscreen changes nothing (the real call is stubbed in the other tests) | SPEC 8.1 Wall mode | `e2e/cypress/e2e/shell/wall-mode.cy.js` |
| Layout: no sideways scroll at 400 px on every page including Admin, no edge-tab overlap (#787), stacked panes, card columns, tile and facts columns, wall mode fills the window | SPEC 8.1 Columns, Wall columns | `e2e/cypress/e2e/shell/responsive.cy.js` |
| The tab's title follows the route; the edge tab's own transition applies unless the reader prefers reduced motion (read from the stylesheet under each emulated setting); the effort meter at each level and at one it does not know (hollow bars, "Effort: minimal"), and with none; People view ordered by Spend | SPEC 8.1 Effort meter, SPEC 8.4 | `e2e/cypress/e2e/shell/misc.cy.js` |
| axe (color-contrast and target-size) on the six pages, light and dark, 1440 and 400 px | SPEC 8.4 | `e2e/cypress/e2e/a11y/axe.cy.js` |
| axe on the orchestrator page, the sign-in, report, respond, record and file-diff dialogs and the activity dialog, and on every Admin page, and on Reporters with a silent reporter in both themes at 1440 and 400 px | SPEC 8.4 | `e2e/cypress/e2e/a11y/axe-more.cy.js` |
| A card changes with no reload; the pill and alert when the server stops, and recovery; the alert with everything collapsed | SPEC 8.1 Data flow, Collapsing | `e2e/cypress/e2e/wall/live.cy.js` |

### Wall

| Feature | Spec | Covered by |
|---|---|---|
| KPI tiles; cards: bands, git line, plan, cost, context, long names, copy id | SPEC 8.1 Fleet wall | `e2e/cypress/e2e/wall/cards.cy.js` |
| Harness badge (`.chip.hx`, shape plus name) only on a wall of more than one harness; an OpenCode card has a Context cell (#985) and shows "from OpenCode" under its cost; the orchestrator page labels the cost "Cost" and reads Fork as Not available; what a report declares (#940) wins over the console's table of harnesses: `context: false` hides the Context cell and shows the note, `context: true` shows the cell for a harness the table says has none, the model chip reads the harness's `modelLabel` with the model id as its title, and all of it holds after a server restart on the same data and from History once the session has ended; an agent's own `modelLabel` (#945) reads on its tree row and in its panel with the model id as the chip's title, and an agent without one shows its family name; a long agent model label (#975) is clipped with an ellipsis inside its Model cell, the full id as the chip's title, and stops before the next column; a long model label on a wall card (#1028) keeps the session's name on the card and ends the chip in an ellipsis inside the card; the agent tree and the orchestrator panel follow what the harness declares (#944): `context: false` and `effort: false` leave the Context and Effort headers, the `.ctxc` and `.eff` cells of the orchestrator row and every agent row, and the panel's Context and Effort rows out, with no sideways scroll, on the wall's page and in History after the session ends, while a Claude Code session keeps both | SPEC 8.1 Session cards | `e2e/cypress/e2e/wall/harness.cy.js` |
| The Comp pill: after the Context label on the card and in the orchestrator's panel, its title and hidden text count the automatic compactions, beside the blowout badge, inside the card at 400 px, axe in both themes | SPEC 8.1 Session cards | `e2e/cypress/e2e/wall/comp-pill.cy.js` |
| Toolbar: status segments, the sorts (Cost, Context used, Context blowouts, Model, Status, Newest, each checked against the seed's order), the filter, "N shown, M cleared today" | SPEC 8.1 Toolbar | `e2e/cypress/e2e/wall/toolbar.cy.js` |
| Heartbeat lost: the card's line and countdown, the full sentence, the KPI count and Remove | SPEC 8.1 Session cards | `e2e/cypress/e2e/wall/stale.cy.js` |
| Rail items, selection, paging, the selection on another page, no paging when stacked | SPEC 8.1 Left rail | `e2e/cypress/e2e/wall/rail.cy.js` |
| People view: bands, collapse, group by, order by Name, Me | SPEC 8.1 People view | `e2e/cypress/e2e/wall/people-view.cy.js` |
| Wall notices: background sessions, the X, the confirmation toast, errors are never notices | SPEC 8.1 Wall notices | `e2e/cypress/e2e/wall/notices.cy.js` |
| Empty states of the wall, the board, History and Chat | SPEC 8.1 Fleet wall | `e2e/cypress/e2e/wall/empty.cy.js` |
| Pinned cards (#496): the button's names and `aria-pressed`, `podium.pins` as {id, slot}, a pin holds its slot under another sort and when the card changes, a filter hides it with no gap and it returns, kept over a reload | SPEC 8.1 Pinned cards | `e2e/cypress/e2e/wall/pins.cy.js` |

### Orchestrator page and right panel

| Feature | Spec | Covered by |
|---|---|---|
| Address, header, charts, the twelve facts, copy and popups, status band, Plan and Files tabs, fold, agent tree sort | SPEC 8.1 Orchestrator page | `e2e/cypress/e2e/orchestrator/page.cy.js` |
| Agent panel, failure and blowout boxes, Report dialogs, activity feed, expand, a Bash call shown running and ended in place (#899), the event list | SPEC 8.1 Right panel | `e2e/cypress/e2e/orchestrator/agents.cy.js` |
| Who may open an agent's whole text and live activity (#1082): 401 not signed in, 403 anyone but the owner, 200 for the owner and an Admin, on both routes; the Report dialog's note under the 400-character excerpt and the feed's wording, footer "Not shown", for a signed-out visitor and for another person; no refusal for the owner | SPEC 8.1 Right panel; DECISIONS 62 | `e2e/cypress/e2e/orchestrator/agent-read-gate.cy.js` |
| Plan order (#454) and paging, plan complete, Files paging, nested agents, Tools used and Show all, the event list's 12 more | SPEC 8.1 Plan section, Tools used | `e2e/cypress/e2e/orchestrator/plan-and-files.cy.js` |
| File diff dialog: sides, stepping and its last file, binary, withheld, too large, cut, renamed (R mark and old name) and deleted files, wrap, preload (every file asked for before a click, none when off), one column when narrow, 504 and 429 (asked again on reopening), who may open it | SPEC 8.1 Files | `e2e/cypress/e2e/orchestrator/file-diff.cy.js` |

### Board, History, Chat and My reporters

| Feature | Spec | Covered by |
|---|---|---|
| Board: columns, cards, the strip, Plans/All, Mixed/By orchestrator, Group, My orchestrators, tiles, KPI fold, narrow tabs, live movement, and a finished plan's open work leaving the board | SPEC 8.1 Kanban board | `e2e/cypress/e2e/board/board.cy.js` |
| Board: a column pages at 25 (the Blocked column lists a blocked step) | SPEC 8.1 Order, paging and layout | `e2e/cypress/e2e/board/board-paging.cy.js` |
| History: day picker, table, paging, address, a stored session's page, empty and error (the browser's date is held at the moment of the reset, so the day does not change during the file; a reset that itself straddles midnight is not covered) | SPEC 8.5 | `e2e/cypress/e2e/history/history.cy.js` |
| Chat (#1034, it replaced Traffic): `#/traffic` opens `#/chat` (pill, tab title, no Chat button on its own page); signed out asks to sign in; opens with both side panes collapsed and the top bar open, kept under `podium.collapsed.chat`; Channels, Direct Messages and People and agents; a People and agents row's state class and words; a Direct Message of two agents with the person as the third reader (its four messages, where each is, round trips); Enter sends and Shift+Enter adds a line; the `@` list with its match-count status line, narrowing, arrow keys, Enter and Escape; an addressed agent's chip and waiting line; the refusal of `@group` and `@everyone` while the Admin flag is off, the draft kept, and the send once it is on; My group; the Chat link in the top bar; the (i) beside the title (#1099) and the "Chat privacy and controls" modal it opens (four groups, eight rules, closed by Escape, its X and a press on the dimmed area, focus back on the (i)), with no "Who can read what" panel under the thread | SPEC 8.1 Chat page | `e2e/cypress/e2e/chat/chat.cy.js` |
| Chat's channels: the menu on "..." and on a right-click (focus, Escape), Pause, Disconnect and their reasons under the box, a failed stop button, an Admin's Pause General for everyone and Remove all messages (confirmed), a person's Remove all in My group; a long thread's paging (50 of 60, Earlier messages); unread and mention badges and their clearing; the list and the thread as two screens at 400 px with Back to the list | SPEC 8.1 Chat page | `e2e/cypress/e2e/chat/chat.cy.js` |
| Chat's Direct Messages: adding to a conversation of two agents, Pause link and Resume link (kept after a reload), Remove link… and Delete conversation… each confirmed (Keep it), a failed Pause and a failed Remove with their messages, another person has no such conversation and is refused its text; People and agents (an agent's menu, Message, Open orchestration page, a Direct Message started from a row, a thread's participants); an agent's answer to its own owner in the same thread (the agent as author, the new badge on the row, cleared on reading); a conversation whose agents have ended (partly: named, wholly: off the list, back with its content when an agent resumes, and none of it shown for a new session of the same agent, #1113), an ended agent's row gone from People and agents (#1110), and an agent launched and not yet used (nothing reported but its launch) joining People and agents on an open page without a reload, having no card on the wall, and leaving the same way when it ends (#1112) | SPEC 8.1 Chat page | `e2e/cypress/e2e/chat/chat-direct.cy.js` |
| Chat with Agent (#1067): the button beside an orchestrator's name opens `#/chat?with=<id>` (its href and title), with the person's own conversation with that agent open: one ready to start ("Message <name>", no row yet, no Admin notice) and, once a message is sent, the existing Direct Message; an id Chat does not list falls back to General; the button is absent while orchestrator messaging is off and returns when it is on | SPEC 8.1 Chat page | `e2e/cypress/e2e/chat/chat-button.cy.js` |
| Chat for an Admin: the "Read a person's conversations" picker (an Admin only) with its (i) note and its Stop reading button, in the picker and in the read-only thread (the Admin's view goes at once, no reload), a person's My group and Direct Message read only (red banner, no message box and why, no unread cleared, and a POST into the group refused with 403 and the reason, the group unchanged), `GET /api/fleet/respond/chat?owner=` answered to an Admin only and without a message; what the person sees while an Admin reads (red banner naming the Admin, the "Who is reading" tip opened on focus and closed on Escape, the "Admin reading" tag on the row, cleared 30 seconds after the Admin stops, shown with the page's clock moved), the record line that stays; an Admin's Pause link and Resume link on a Direct Message (the person's red "Paused by an Admin" tag and banner, no resume for the person), an Admin's pause (the Admin's own banner reads "You paused ..."), disconnect and Remove all messages in a group with the record lines left | SPEC 8.1 Chat page | `e2e/cypress/e2e/chat/chat-admin.cy.js` |
| Chat across owners: Alex's `@` of Ed's agent in General waits for Ed (sidebar notice, My reporters Allow and Decline, the Allow hint saying the link covers the whole reporter and naming its machine (#1051), Decline delivers nothing, Allow opens a link), who may pause, resume and remove the link (only the one who paused it resumes, only Ed opens a removed one), and the agent's answer to a person with its unread count | SPEC 8.1 Chat page | `e2e/cypress/e2e/chat/chat-across.cy.js` |
| Chat's security audit (#1051): the message box of a Direct Message to your own agent lists /clear and /compact on `/` (the reporter's declared commands only: /compact alone when it cannot clear), narrows, picks by Enter, says "Other commands run only in the terminal.", names an unknown command in an alert and will not send it, sends /compact at once and asks "Clear the conversation?" before /clear (Cancel sends nothing), and treats `/` as text in General; who wrote a General message (the "orchestrator on <machine>" chip, the "Same name as a person" and "Name says Admin" chips); an agent that was not called into General refused 403 with "You were not called into this channel in the last hour." and nothing shown, then answering with the orchestrator chip once a person has mentioned it (#1065); an Admin looking at a person's list (the person's full-width red banner while it is live, then the quiet record line, neither shown to the Admin); a conversation of someone else answered 404 like one that does not exist, a message to an agent whose reporter has respond off, or does not declare adminNotices (422 each), the Admin's unseen read of a conversation since deleted shown to the person once as a quiet line (`chat-gone-record`) and to no one else, an own-agent message over Chat's limit (422), Chat out of Traffic's open read, an Admin refused Chat through Traffic's two conversation routes (403) and reading it through Chat; Ed's own conversation with an agent and another person's with it as two rows | SPEC 8.1 Chat page | `e2e/cypress/e2e/chat/chat-security.cy.js` |
| My reporters: requests, reporters, defaults, limits, rights grid and board, empty variants, flag off | SPEC 8.1 My reporters page | `e2e/cypress/e2e/messaging/my-reporters.cy.js` |
| My usage (#726): the top bar button (not on its own page), the five sections, the Period, By, Break down by and Harness controls and no Person, Group or Model filter, the Spend heading following By, a heading sorting the Tool calls table (#1133, and moving no column, #1144), and that with two people's sessions each sees only their own project and tools (the other's appear nowhere on the page, in the JSON or the CSV, and a person, group or session in the request changes nothing; the admin secret gets its own figures, not the fleet's) | SPEC 7.1 Reports | `e2e/cypress/e2e/my-usage/my-usage.cy.js` |
| Admin > Reporters > a reporter, Messaging: the owner's rights grid and board, proposals, Pause all links and Resume all links; an Admin's Pause all links names the Admin under Paused to the Admin and to the owner and writes one Admin log line (#1077) | SPEC 8.1 Reporters page | `e2e/cypress/e2e/admin/reporter-messaging.cy.js` |
| My reporters: Decline, a limit above the Admin's, a failed save puts the control back, the Board's Move to list (the card lands in the chosen level's column and its count rises by one) | SPEC 8.1 My reporters page | `e2e/cypress/e2e/messaging/messaging-more.cy.js` |

### Sign-in, Respond and Recording

| Feature | Spec | Covered by |
|---|---|---|
| Sign-in dialog: empty, wrong, success, sign out, no token kept | SPEC 8.1 Signing in | `e2e/cypress/e2e/respond/sign-in.cy.js` |
| Respond button gating and the modal for each kind of ask, and a reporter's limits removing an ask kind | SPEC 8.1 Responding | `e2e/cypress/e2e/respond/respond.cy.js` |
| Answering: each answer's request body (plan, Allow once, Deny with its reason, a question's answers, a message, /clear, /compact), what the session's hook is handed for an ask (read from the server as the mod would) and the reporter's next check-in carrying a message and a command, with its sender (Ed, or the Admin), the "You, from Podium:" entry, "<Name>, from Podium:" for another person's message, the notes the reporter's result adds (queued, cleared), and what the console says for HTTP 500, 422, 429 and 403 | SPEC 8.1 The modal, The feed | `e2e/cypress/e2e/respond/answer.cy.js` |
| Recording: the notice, the picker's states, start, stop, delete, replay with its loop filter, slider and Jump, History line, and a subset of loops ("Recording 3 of 4 loops") | SPEC 8.1 Session recording | `e2e/cypress/e2e/recording/recording.cy.js` |
| An Admin's replay told to the owner (#1075): the red notice under the recording layer naming the Admin while the replay is live, the card's second line "... is replaying it now." on the wall, the quiet record line that stays and its X (hides it in that browser only, the record kept), nothing for the Admin or a stranger, nothing recorded for the owner's own replay, the Admin-only ping refused to others | SPEC 8.1 Session recording | `e2e/cypress/e2e/recording/recording-admin-replay.cy.js` |

### Admin

| Feature | Spec | Covered by |
|---|---|---|
| Lock screen, who may open Admin, the menu, count badges, Lock Admin, the narrow menu, no token | SPEC 8.1 Admin layout | `e2e/cypress/e2e/admin/access.cy.js` |
| What a person is told when an Admin reads their content (#1072, #1073, #1074): an Admin reading a conversation between their agents through the Admin route and through the owner-or-Admin route (Ed's red Chat banner, then the record line), the owner's own read telling no one, a waiting ask open (the red notice under the orchestrator page's status band and above the ask in the Respond window, then the quiet record line, the Admin log's `ask_read`), the stored Activity paged (the red notice, the record line, the Admin log's `activity_admin_read`), the notice's X hiding it on that browser only (still hidden after a reload, the record kept), an agent's whole prompt and answer and its live activity read by an Admin (#1082: a red notice per kind under the band, then the record line, the Admin log's `text_admin_read` and `live_admin_read`) and read by the owner (no one told). Not reached: an Administrator who owns the agents is not noticed (no seeded Administrator owns a session; the server's tests cover it), and the 15-second ping is made by request | SPEC 8.1 Chat page; PROJECT.md "An Admin Never Reads in Silence" | `e2e/cypress/e2e/chat/admin-read-notices.cy.js` |
| Timer-driven sign-in states (#791, DECISIONS 50), each on a server restarted with `PODIUM_TEST_TIMINGS=1` and a short time: the Admin idle lock (the lock screen returns with no action); the sign-in to respond ending when idle (the page checks once a minute, so about 70 s); the lockout (five wrong tries, the message in Admin's unlock and in the console's sign-in, the lift after the lock time) | SPEC 7.7 Test-only timings | `e2e/cypress/e2e/admin/idle-lock.cy.js`, `e2e/cypress/e2e/admin/lockout.cy.js`, `e2e/cypress/e2e/respond/sign-in-idle.cy.js` |
| People: create, token shown once, search, group, the actions menu by mouse and by key, rotate, revoke, delete, bulk select; Groups | SPEC 8.1 People, Groups | `e2e/cypress/e2e/admin/people-groups.cy.js` |
| Reporters: filters, search, sort (a sort click moves no column, #1144), details, ignore rules, removal | SPEC 8.1 Reporters page | `e2e/cypress/e2e/admin/reporters.cy.js` |
| Reporters: outdated and newer versions and the top bar's counts, the admin-secret band and Show only these, the details of both, with the Compatibility text naming the reporter (#852), the Claude Code / OpenCode picker on the admin-secret steps (#857), ignoring a version, Select all, "Not since restart" | SPEC 8.1 Reporters page | `e2e/cypress/e2e/admin/reporters-states.cy.js` |
| Settings: the flags (each off, kept, on; Chat's `chat-everyone` starts off), warning bars, messaging limits, recording limits and their refusals, wall notices, the wall, forget old reporters; the recordings table with Stop | SPEC 8.1 Feature flags | `e2e/cypress/e2e/admin/settings.cy.js` |
| An Admin's stop of a person's recording (#1078), from Admin > Settings > Recordings: the person's Chat overview shows the quiet line "<Admin> (an Admin) stopped a recording of one of your sessions on <date>." (`chat-gone-record`) once and no one else's does | SPEC 7.7 Hardening | `e2e/cypress/e2e/recording/recording.cy.js` |
| Model prices: edit, cancel, Reset to built-in, add and Remove a model, a duplicate, an invalid price with `aria-invalid` and its message; a price change reprices a session's card ($0.42 to $16.20) and Spend today | SPEC 8.1 Model prices | `e2e/cypress/e2e/admin/model-prices.cy.js` |
| Reporters: Idle, after two minutes without a report, with no reload. This is the one real-time wait in the suite, about 2.5 minutes of every run, a retrying assertion on the server's own threshold, not a fixed sleep | SPEC 8.1 Reporters page | `e2e/cypress/e2e/admin/reporters-idle.cy.js` |
| Activity history (#432): the feed's newest 20, Show older to the start, the stored count, "Kept until" under each policy, the refusal to a viewer who may not read; Stored activity's totals, filters (one that narrows to a row, two that empty the list, and the empty-state text), selection bar, and the delete flows (selected, matching a filter, everything); the policy form's period and size-cap rows, saved and refused | SPEC 8.1 Data and Stored activity, Activity section | `e2e/cypress/e2e/admin/stored-activity.cy.js` |
| Admin > About (#862): last in the Server group; the server's version, "Running as" Container, Started with uptime and no Build row on a release; Built with; the database adapter, engine, schema and size; the reporters by version, newest first, with the outdated and newer flagged, the range this server reads and the machine count; Copy details and its "Copied"; the empty state "No reporter is connected". Versions, uptime and sizes by shape, since they move with the release and the clock | SPEC 8.1 About | `e2e/cypress/e2e/admin/about.cy.js` |
| Security, Certificates (TLS off), Data and the activity-history policy, Stored activity's empty state and source, Admin log (a later entry listed before an earlier one) | SPEC 8.1 Data and Stored activity | `e2e/cypress/e2e/admin/server-pages.cy.js` |
| Reporting: Usage, a heading sorting a report table (Sessions: A to Z, Z to A, a number largest first, `aria-sort`, back to the first page, #1133; no column moves on a sort click in Sessions and Usage, #1144), Spend (today, projection, breakdown), People and groups, Sessions (length and waiting, what sessions waited for, agents launched, chain depth, each with its own CSV and JSON, the Harness choice, the held-back line under a Model filter, a period before the history), Usage (sessions per person per day, busiest hours with the Chart and Table switch, their exports), Tools (sections, Harness filter, CSV with a harness column, an empty period, failures, permission prompts and call duration with their empty lines, #721; cost per tool call and what sessions that used a tool cost, #723), Spend tokens and cache hit rate with its own Harness filter (#723), Sessions model and effort mix and context fullness at the end (#723, the Mix of choice, their exports and the held-back line), Sessions answers sent through Podium and how long sessions waited for an answer (#725: empty before any answer, the console answering a permission and a message, the counts, the dash before counting began, the Harness filter and the held-back line), Harness updates (#724: the page after Tools, its sections, Harness filter, exports, the empty line and the `#/admin/harness` address), Projects and branches per person, Skills and Platform and reporter version sections, Failures, Admin activity; period, CSV and JSON content, Print, the remembered choice | SPEC 8.1 Reporting, Spend | `e2e/cypress/e2e/admin/reporting.cy.js` |

### Feature flags

| Flag | Covered by |
|---|---|
| All nine: the defaults of a fresh server (seven off, `activity-feed` and `update-check` on), with nothing enabled | `e2e/cypress/e2e/flags/defaults.cy.js` |
| All nine: each off, kept over a reload, and on again, in Admin > Settings and in `/api/fleet/state` | `e2e/cypress/e2e/admin/settings.cy.js` |
| `activity-feed` on, off, and on with the reporter's `activityFeed` off | `e2e/cypress/e2e/flags/activity-flags.cy.js` |
| `activity-output` on, off, and on with `activityOutput` off | `e2e/cypress/e2e/flags/activity-flags.cy.js` |
| `respond` on and off, and a reporter that cannot answer | `e2e/cypress/e2e/respond/respond.cy.js` |
| `file-diff` on, off, and on with `fileDiff` off | `e2e/cypress/e2e/orchestrator/file-diff.cy.js` |
| `peer-messaging` on (Chat in the bar), off (Chat says so and its read is refused), and on with a machine's `peers` off, with both Claude Code routes to turn it on named in the hover note on "Off on the machine" (#857) | `e2e/cypress/e2e/flags/messaging-flag.cy.js` |
| `session-recording` on, off, and on with the reporter's option off | `e2e/cypress/e2e/recording/recording.cy.js` |
| `my-usage` (#726): off by default (no button, `#/me/usage` says "Page not found", the route answers 404), on and signed out (asks to sign in, route 403), on and signed in (button beside My reporters), and off again | `e2e/cypress/e2e/my-usage/my-usage.cy.js` |
| `update-check`: the switch only; the notice it produces is a stated gap below | `e2e/cypress/e2e/admin/settings.cy.js` |

### Server routes the suite drives

They are listed so a route that is renamed or removed shows up in the check.

| Route | Reached by |
|---|---|
| `GET /api/fleet/health` | `e2e/cypress/e2e/shell/smoke.cy.js` |
| `GET /api/fleet/history` | `e2e/cypress/e2e/history/history.cy.js` |
| `GET /api/fleet/respond/me` | `e2e/cypress/e2e/respond/sign-in.cy.js` |
| `GET /api/fleet/respond/usage/:report` | `e2e/cypress/e2e/my-usage/my-usage.cy.js` |
| `POST /api/admin/unlock` | `e2e/support/commands.js`, `e2e/cypress/e2e/admin/access.cy.js` |
| `PUT /api/admin/settings` | `e2e/cypress/e2e/admin/settings.cy.js` |
| `GET /api/admin/groups` | `e2e/cypress/e2e/admin/access.cy.js` |
| `PUT /api/admin/people/:id/group` | `e2e/cypress/e2e/admin/access.cy.js` |

## What no end-to-end spec can reach

Each of these is a stated gap, not a covered feature.

| Feature | Why |
|---|---|
| Real Fullscreen API | Headless Chrome refuses the request, because Cypress's clicks are not a user gesture. The spec checks that a refusal changes nothing and, with `requestFullscreen` stubbed, the app's own wall-mode state. The real call is checked by hand. |
| Real TLS: the Certificates page with a CA, the reporter certificate and its renewal | The throwaway server is plain HTTP. Covered by `server/src/tls*.test.ts` and `frontend/src/fleet/admin/certificates.test.tsx`. |
| The reporter mod inside Claude Code | Out of scope (`npm run test:mod:claudecode`). The suite plays the mod's reports and its diff answers. |
| The release-check notice at the bottom of the wall | It needs a newer release from GitHub. Only the switch is covered; the notice is covered by `frontend/src/fleet/wall.test.tsx`. |
| Admin > Reporting with 45 days of history | The history needs `scripts/podium-seed-history.ts`, which needs `tsx`, which no container here carries, and no route writes rollups. The pages are checked for shape and for today's live figures. Covered by `frontend/src/fleet/admin/reporting.test.tsx` and `server/src/fleet/rollups.test.ts`. |
| The retired Traffic page's own note ("Traffic is retired. Chat replaces it") | `#/traffic` is replaced with `#/chat` as soon as the address is read, so a browser never rests on the note. The spec asserts the redirect, and the note is covered by `frontend/src/fleet/traffic.test.tsx`. The old `/api/fleet/peers/traffic` read still answers and `e2e/cypress/e2e/flags/messaging-flag.cy.js` still asserts its off answer. |
| The color a People and agents row takes when pointed at | `:hover` cannot be forced in Cypress without a real pointer. The spec asserts the row's state class (`hl-waiting`, `hl-running`, `hl-deleg`) and the state in words that the stylesheet colors by; the colors themselves are tokens checked by `npm test`. |
| A hidden Direct Message purged after its harness's resume window (`resumeWindowDays`, 30 days from the seed, #1113) or, with no window, its grace period, and a channel message past its retention | Both run in the hourly sweep and the shortest setting is one hour or one day (`graceHours` 1 to 720, `retainDays` 1 to 365), and a window is days, so reaching them takes a test-only clock that none of the timings in `PODIUM_TEST_TIMINGS` offers. The spec asserts the hide (a conversation leaves the list at once when every agent has ended), its return with its content on a resume and the empty start of a new session, and covers the kept-past-the-grace-period and purge-after-the-window cases in `server/src/fleet/chatRoutes.test.ts`. Chat's limits (`chat` in Admin > Settings) have no boxes yet and are covered there too. |
| The callout an Admin's read or stop raises in the person's terminal | It is shown by `podium-reporter` inside the session, not in the console, and the suite plays the mod's reports and nothing more. The console side (banner, tag, record line; and the line for an Admin's stop of a recording, #1078, in `e2e/cypress/e2e/recording/recording.cy.js`; and, for a replay, `e2e/cypress/e2e/recording/recording-admin-replay.cy.js`) is covered by `e2e/cypress/e2e/chat/chat-admin.cy.js` and, for an agent conversation, an ask, stored Activity and an agent's whole text and live activity (#1072, #1073, #1074, #1082), `e2e/cypress/e2e/chat/admin-read-notices.cy.js`; the callout is covered by the plugin tests (`npm run test:core`, `npm run test:mod:claudecode`) and by `/podium-live-test`. |
| Reporters in the Silent state (over an hour without a report) | The one-hour threshold is a constant in `server/src/storage/rows.ts` and the server stamps a report with its own clock, so reaching it takes an hour or a test-only clock. Idle (two minutes) and "Not since restart" are covered. Only its look is covered: `a11y/axe-more.cy.js` answers the Reporters list with one reporter silent and runs axe (#1098). |
| An untracked file's diff as its own case | A file the reporter lists as untracked arrives as status `added` (`server/src/fleet/protocol.ts` has no fifth status), so it is the added file in `e2e/cypress/e2e/orchestrator/file-diff.cy.js`. |
| History's Resume and Fork cells | SPEC 8.5 now says an opened session shows them; no spec asserts it yet. |

## What is left to unit tests

The suite does not repeat what a unit test already settles and a browser adds nothing to: card text, sort and filter arithmetic, board grouping
(`frontend/src/fleet/board.test.ts`), rail page math (`frontend/src/fleet/railPages.test.ts`), the derive rules and ingest validation
(`server/src/fleet/derive.test.ts`), markdown rendering (`frontend/src/fleet/components/Markdown.test.tsx`), the CSV neutralizing, validation
messages, and the standards pages (`npm run standards:parity`). A feature with only unit coverage and a layout, focus or live-update behavior gets a spec for that part.

## What runs on PostgreSQL and MariaDB

The supported databases are SQLite (built in), PostgreSQL 17 and MariaDB 11.x (tested on 11.4). Each non-default one is tested on that one
version in three places; another version is untested. The maintainer has run the suite on both PostgreSQL and MariaDB.

- **The storage contract and each adapter's own tests** (`server/src/storage/`) run on every database in every CI run: the
  `Test with PostgreSQL` job of `ci.yml` on `postgres:17` and the `Test with MariaDB 11.4` job on `mariadb:11.4`, and locally with
  `scripts/test-db.sh`. Each job runs the whole server suite with its test server variable set (`PODIUM_TEST_PG`, `PODIUM_TEST_MARIADB`),
  but only the storage tests use it, plus one Chat route sequence per database (`server/src/fleet/chatGoneReadsPg.test.ts`,
  `chatGoneReadsMaria.test.ts`).
- **The test files outside `server/src/storage/`** (routes, ingest, the fleet, peers, Admin) open a SQLite storage and nothing else. They
  are not converted: the contract is where the databases are compared, and the Cypress run below covers the routes on each.
- **The Cypress suite on each database** (`E2E_DB=postgres` or `mariadb`, the `databases` input of `e2e.yml`, default
  `sqlite postgres mariadb`) runs on a pull request into `main` and on a manual dispatch, never on a PR into `development`. It uses
  `postgres:17-alpine` and `mariadb:11.4.13`, pinned. A release PR runs every database in that list in one job, and `E2E summary` fails
  when that job fails or is skipped. The run on the 1.5.0 release PR (2026-11-05) ran SQLite and PostgreSQL and passed, as did a manual
  dispatch on 2026-11-10; a run with MariaDB in the list starts with the next release PR. `npm run e2e` alone runs SQLite only, so a branch
  that changes `server/src/storage/`, a route or database behavior runs the suite once on each database before its PR (`E2E_DB=<kind>`, or
  `scripts/e2e-all.sh`).

A version other than PostgreSQL 17 or MariaDB 11.4 is reached by no test. `E2E_PG_IMAGE` and `E2E_MARIADB_IMAGE` run the suite on another
image by hand, which does not make that version supported.

## What is still open

- **Known axe findings.** None. #794 to #800 were the last, and their `known` entries are gone from `e2e/cypress/e2e/a11y/axe.cy.js` and `axe-more.cy.js`.
