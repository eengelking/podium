---
title: "Development patterns"
description: "The patterns Podium's code follows, each with where it applies, why, one example and the check that holds it, and the rule for changing one."
group: "Project internals"
---

# Development patterns

This page lists the patterns Podium's code follows: what each one is, where it applies, why it exists, one place in the code that
shows it, and the test or check that holds it. It is for a contributor or an agent about to change something, who wants to follow
what is already there and not invent a second way. A pattern that is already written down in full elsewhere gets one line and a
link here; the rule is not restated. What the product must do is in [docs/spec/](spec/README.md), and how it was built is in
[docs/architecture/](architecture/README.md).

Contents:

- [How to use this page](#how-to-use-this-page)
- [Changing a pattern](#changing-a-pattern)
- [Storage](#storage)
- [Server routes, auth and logging](#server-routes-auth-and-logging)
- [Consent and what Podium may do](#consent-and-what-podium-may-do)
- [Reporter and plugin](#reporter-and-plugin)
- [UI code](#ui-code)
- [Tests](#tests)
- [Docs](#docs)
- [Release](#release)
- [Findings, not patterns](#findings-not-patterns)

## How to use this page

1. Before you implement a change, find the sections that cover the files it touches and read those entries. Storage work reads
   [Storage](#storage); a page or component reads [UI code](#ui-code) and the standards in `docs/standards/`; a reporter change
   reads [Reporter and plugin](#reporter-and-plugin).
2. Follow each pattern that applies. Where a check is named, run it.
3. Name the patterns the change relies on in the PR body.

The `podium-patterns-check` skill does the same steps and reports each departure.

"Held by: none" means no automated check holds the pattern today. Adding one is its own issue.

## Changing a pattern

A pattern changes only on an exceptional argument. A feature or fix PR never changes one in passing. A change to a pattern needs all of:

- A [decision](decisions/README.md) entry that gives the argument.
- The maintainer's approval before any code is written.
- Every use of the old pattern updated across the codebase in the same effort, not left as a mix.
- A full pass showing nothing broke: `npm test`, `npm run test:mod`, `npm run typecheck:mod`, the e2e suite, and the adapter contract
  where storage is involved.

A change that finds code departing from a pattern files an issue for the departure and leaves the code as it is.

## Storage

| Pattern | Rule and why | Example | Held by |
|---|---|---|---|
| All database access goes through `Storage` | No `node:sqlite`, `sqliteHandle`, `activityHandle` or raw SQL outside `server/src/storage/sqlite/`. A new query is a method in `types.ts`. Other databases are adapters behind the same interfaces. See [decision 48](decisions/48-storage-sits-behind-async-interfaces-with-sqlite-as-the-only-adapter.md). | `server/src/storage/index.ts` | `server/src/storage/neutral.test.ts` |
| A schema change lands in every adapter | A column, table, index or key change carries its own schema step and migration in each adapter, with a `contract.ts` case, because an interface creates nothing in a database. | `server/src/storage/contract.ts` | `server/src/storage/adapters.test.ts` |
| One test, every adapter, no oracle | The contract, upgrade and differential cases run over every registered kind. A case is never skipped or loosened for one adapter. A difference that is not a defect goes in `contractSame.ts`. | `server/src/storage/contractSame.ts` | `server/src/storage/adapters.test.ts` |
| Every adapter runs before a PR | `scripts/test-pg.sh` runs the server tests on all adapters. A run that leaves one out is reported as limited, never as a pass. See [decision 53](decisions/53-postgresql-is-the-second-storage-adapter-on-the-pg-driver-with-one-process-per.md). | `scripts/test-pg.sh` | `npm test` fails when an adapter's server is not configured |
| Portable SQL | No `json_extract`-style functions in SQL; other databases spell them differently. | `server/src/storage/sqlite/` | `server/src/storage/sqlite/portableSql.test.ts` |
| Every list query has a defined `ORDER BY` | Ordering is decided by the database otherwise, and two adapters would answer in different orders. | `server/src/storage/` | `scripts/storage-order-parity.mjs` |
| Await every store call | A store call is async. A missing `await` compiles and answers wrongly. A deliberate exception takes `// promise-ok: <why>`. See [the gotcha](gotchas/a-store-call-without-await-compiles-and-answers-wrongly.md). | `server/src/fleet/asyncHandler.ts` | `scripts/promise-misuse.mjs`, `scripts/promise-misuse.repo.test.ts` |
| Do not hold a transaction across a wait outside storage | Network, OpenSSL and timers run before or after `Storage.tx`, which holds the connection lock. A read followed by a write over several awaits needs a `tx`. | `docs/architecture/02-components/19-storage.md` | none |
| Settings read synchronously come from the `Live*` cache | A card or report is built synchronously, so do not add an async read there. | `server/src/fleet/fleet.ts` | none |

## Server routes, auth and logging

| Pattern | Rule and why | Example | Held by |
|---|---|---|---|
| Middleware order | `hostCheck`, then security headers, the reporter gate, request log, the failure limiter on `/api`, then the routers, then the 404 and the single-page app. | `server/src/index.ts:108` | `server/src/hostCheck.test.ts`, `server/src/securityHeaders.test.ts`, `server/src/failureLimiter.test.ts`; no test pins the order itself |
| Async handlers go through `asyncHandler` | A rejected promise in an Express 4 handler is otherwise unhandled. | `server/src/fleet/asyncHandler.ts:11` | `server/src/fleet/asyncHandler.test.ts` |
| Token check before the body is parsed | A write route runs `requireToken` before the JSON parser, so an unauthenticated body is never read. | `server/src/fleet/routes.ts:204` | `server/src/fleet/routes.auth.test.ts` |
| Token comparison is a hash and `timingSafeEqual` | A person token is 192 random bits and is never throttled. A wrong admin secret feeds the guess throttle and answers `429` with `Retry-After`. See [decision 32](decisions/32-throttling-wrong-admin-secret-guesses-on-the-report.md). | `server/src/fleet/tokens.ts:34` | `server/src/fleet/tokens.test.ts` |
| Admin routes sit behind one gate | After the shared guards, one `router.use` requires the unlock, and a write needs a same-origin `Origin` plus the `X-Podium-Admin: 1` header. Each write is recorded in the Admin log with `audit()`. | `server/src/admin/adminRouter.ts` | `server/src/admin/admin.test.ts`, `server/src/admin/auditAwait.test.ts` |
| A reverse proxy is trusted only when told to | The client address is read from forwarded headers only when `trust proxy` is set. See [decision 35](decisions/35-trusting-a-reverse-proxys-client-address-only-when.md). | `server/src/index.ts` | `server/src/hostCheck.test.ts` |
| A client certificate is never a fallback to a token | A presented but refused certificate answers `401`. Reporter-route detection uses the socket, never a forwarded header. See [decision 42](decisions/42-podium-makes-its-own-ca-and-the-reporter.md). | `server/src/tlsServer.ts` | `server/src/tlsServer.test.ts` |
| Reported text is never interpreted | A reported string is never treated as HTML, SQL, a path or a shell command. Strings are clamped and stripped of control characters on intake. | `plugin/core/protocol.ts` | `server/src/fleet/protocol.test.ts` |
| Logging takes named fields, never a body | `logger.<level>(event, message, fields)`. Fields such as token, secret, prompt, text and body are dropped, and strings are scrubbed and capped. The log carries ids, counts and kinds, never typed text. See [decision 26](decisions/26-the-server-logs-events-and-can-push-them.md). | `server/src/logging/logger.ts` | `server/src/logging/events.test.ts`, `server/src/logging/redact.test.ts` |
| Log shipping never blocks a request | A request path never awaits the shipper. | `server/src/logging/` | none |
| Environment is read at start and passed in | `index.ts` reads `process.env` and hands parsers an `env` object. Test-only variables are destructured, so `podiumctl`'s settings test can list what the server reads. | `server/src/testTimings.ts` | `scripts/podiumctl.test.ts` |
| Test-only timings need a flag | `PODIUM_TEST_*` counts only with `PODIUM_TEST_TIMINGS=1`, and a bad value stops the server at start. See [decision 50](decisions/50-test-only-timing-variables-let-the-end-to-end-suite-reach-the-idle-and-lock-times.md). | `server/src/testTimings.ts:16` | `server/src/testTimings.test.ts` |
| Secrets reach a process by environment | `podman run -e NAME` with no value, and nothing on a command line others can read. See [decision 10](decisions/10-the-token-is-generated-on-first-start-and-secrets.md). | `bin/podiumctl` | none |
| A feature the Admin can switch is read through `featureOn` | Consumers receive the flag as a closure, so turning it off takes effect without a restart. | `server/src/fleet/fleet.ts:221` | `server/src/storage/contractSettings.ts` |

## Consent and what Podium may do

| Pattern | Rule and why | Example | Held by |
|---|---|---|---|
| Podium observes | It never types into a terminal, stops an agent or changes a session's permission rules. See [decision 1](decisions/01-podium-only-observes.md) and [decision 54](decisions/54-podium-is-harness-neutral-and-the-non-goals-are-restated-for-any.md). | `docs/spec/01-goals-and-non-goals.md` | none |
| Answering, diffs and recording are off until three parties agree | The Admin flag, the session owner's choice and the reporter option must all be on, and the browser cannot overrule the reporter option. See [decision 28](decisions/28-podium-can-answer-a-waiting-session-through.md), [36](decisions/36-a-files-diff-is-source-code-so-only-its-owner.md) and [40](decisions/40-a-session-can-be-recorded-whole-with-three-yes.md). | `server/src/fleet/respondRoutes.ts` | `server/src/fleet/respond.test.ts` |

## Reporter and plugin

| Pattern | Rule and why | Example | Held by |
|---|---|---|---|
| Import direction | A harness may import `plugin/core/`. Core never imports a harness, and harnesses never import each other. See [decision 56](decisions/56-the-reporters-live-in-plugin-with-a-core-and-a-folder-per.md). | `plugin/claudecode/hooks/report.ts` | `server/src/plugin.test.ts` |
| One copy of the report contract | The report types live in `plugin/core/protocol.ts`; the server re-exports it and the UI imports it. See [decision 57](decisions/57-the-report-types-and-shared-reporter-code-live-once-in-plugin-core.md). | `server/src/fleet/protocol.ts` | `server/src/plugin.test.ts`, `scripts/mod-report.test.ts` |
| `protocol.ts` imports no Node module | The UI imports it and the bundler does not tree-shake. | `plugin/core/protocol.ts` | `server/src/fleet/protocol.browser.test.ts` |
| A shared rule lives in `plugin/core/` | A behavior on the wall reads the same on every harness, so a reporter change considers each harness and has a test in each, or says why one needs nothing. | `plugin/core/feed.ts` | none (see [findings](#findings-not-patterns)) |
| Mod logic lives in a plain module | Logic goes in a module that imports nothing from the engine; `register.ts` stays a few lines of glue, so the coverage gate can see it. | `plugin/claudecode/hooks/place.ts` | `scripts/place.test.ts` |
| A plugin loads only from a built folder | A plugin cannot import outside its folder. Use `npm run plugin:dev:claudecode`. See [the gotcha](gotchas/plugin-source-folder-cannot-be-loaded-on-its-own.md). | `scripts/plugin-build.mjs` | the self-containment check in `scripts/plugin-build.mjs` |
| Every harness has a check pair and a live-test reference | `test:mod:<harness>`, `typecheck:mod:<harness>` and `.claude/skills/podium-live-test/references/<harness>.md`. | `package.json` | `scripts/harness-scripts.test.ts`, `scripts/live-test-parity.test.ts` |
| The supported reporter range moves with a release | A new minor release moves `max` in `REPORTER_SUPPORT`; `min` moves only when old reports stop reading correctly. | `server/src/fleet/compat.ts:16` | `scripts/versions.test.ts` |

## UI code

The look of the UI is in `docs/standards/`, which is generated from the app and has its own check (`podium-standards-check`). This section
holds only the code patterns.

| Pattern | Rule and why | Example | Held by |
|---|---|---|---|
| The wall is live over one stream | Wall state comes from a single `EventSource` on `/api/fleet/stream`, applied by a pure reducer. Live fields are never traded for fetch-on-open. | `frontend/src/fleet/useFleet.ts:38` | `frontend/src/fleet/store.test.ts`; no check stops a second stream |
| Text from a session is a text node | Never `dangerouslySetInnerHTML` or `innerHTML`. Markdown builds elements, and a link must match `SAFE_HREF`. | `frontend/src/fleet/components/Markdown.tsx:8` | `frontend/src/fleet/components/Markdown.test.tsx` |
| Colors are tokens | A color comes from `tokens.css`. A literal needs an entry with a reason in `docs/standards/deferred.json`. | `frontend/src/fleet/tokens.css` | `scripts/standards-guard.test.ts` |
| A new theme goes in three places | `themes.ts`, the token blocks in `tokens.css`, and the id in the inline script in `frontend/index.html`. See [the gotcha](gotchas/new-color-theme-has-no-effect.md). | `frontend/src/fleet/themes.ts` | `frontend/src/fleet/themes.test.ts` |
| Collapse and open controls are `EdgeTab` | One pill for the top bar, the KPI rows, the fold and both panes. | `frontend/src/fleet/components/EdgeTab.tsx` | `frontend/src/fleet/edgeTabSize.test.ts` |
| Standards change only through release-prep | A feature PR adds a `Standards:` line under `[Unreleased]` and never edits `docs/standards/`. | `CHANGELOG.md` | `npm run standards:parity` |
| A new page or large state gets an accessibility case | Axe runs in the test; contrast and target size are checked in a real browser. | `frontend/src/fleet/a11y.axe.test.tsx` | `frontend/src/fleet/a11y.axe.test.tsx` |
| A form resets its draft during render | A mount effect copying saved values would overwrite a user edit. See [the gotcha](gotchas/frontend-test-fails-now-and-then-an-edit-is-lost-or-an-element-is-missing.md). | `frontend/src/fleet/` | none |
| A poll pauses while the page is hidden | Timers are cleaned up in the effect. | `frontend/src/fleet/useMyPeers.ts` | none (see [findings](#findings-not-patterns)) |

## Tests

| Pattern | Rule and why | Example | Held by |
|---|---|---|---|
| A bug fix starts with a failing test | A test run only against the fix does not show it would have caught the regression. Does not apply to docs. | `.claude/CLAUDE.md` | none |
| A test sits beside its source | `<module>.test.ts`, with the issue number in a header comment. | `server/src/testTimings.test.ts` | `server/vitest.config.ts` includes |
| Server tests bind `127.0.0.1` | A wildcard bind collides on macOS. A new `setupFiles` list keeps `testSetup.ts`. | `server/src/testSetup.ts` | `server/src/testSetup.ts` |
| Guard tests scan the source | A rule about the whole tree is a test that reads it. | `server/src/storage/neutral.test.ts` | itself |
| End-to-end tests run in containers | Cypress runs only through `scripts/e2e-up.sh`; nothing is installed on the host. A feature change ships its specs and its row in `docs/e2e/COVERAGE.md`. See [decision 49](decisions/49-end-to-end-tests-run-cypress-from-an-e2e-folder-against-the-built.md). | `scripts/e2e-up.sh` | `scripts/e2e-map.test.ts` |
| E2E selectors | A role and name, a label or text first; `data-testid` only when none works. | `e2e/support/commands.js:72` | `scripts/e2e-map.mjs` checks each testid exists |
| New lines are tested | The SonarCloud gate needs 80% coverage on new lines. A `[SKIPPED]` analysis is reported as skipped. | `sonar analyze` | the SonarCloud gate |
| A throwaway server and database for checks | Never point a check at the maintainer's own server or a database that matters. | `scripts/throwaway-db.mjs` | `scripts/throwaway-leak.test.ts` |

## Docs

| Pattern | Rule and why | Example | Held by |
|---|---|---|---|
| Every page starts from a template | `title`, `description` under 160 characters and `group` in frontmatter; one term for one thing (the console, the wall). | `docs/templates/` | `scripts/check-doc-frontmatter.mjs` |
| Big docs are folders of small pages | Indexes are generated, citations such as "SPEC 6.8" never change, and moved text is not reworded. See [decision 45](decisions/45-large-docs-split-along-their-sections.md). | `docs/decisions/` | `scripts/check-doc-refs.mjs`, `scripts/check-doc-links.mjs`, `scripts/build-doc-indexes.mjs` |
| One owner for a fact | Link to it; do not restate it. Architecture goes in `docs/architecture/`, status in `CHANGELOG.md`. | `docs/architecture/` | none |
| A structural change updates the atlas | `podium-atlas.html` and `ATLAS.md` change together. | `docs/atlas/` | `scripts/atlas-functions.mjs --check` |
| A deprecation has a removal release | A row in `docs/DEPRECATIONS.md` and a line under `[Unreleased]`; removed within three minors. | `docs/DEPRECATIONS.md` | `scripts/check-deprecations.mjs` |
| Code and spec disagree: ask | Flag the contradiction; do not pick a reading. | `docs/spec/10-rules-for-the-implementing-agent.md` | none |

## Release

| Pattern | Rule and why | Example | Held by |
|---|---|---|---|
| One version for the whole product | Podium and `podium-reporter` share one `MAJOR.MINOR.PATCH`. | `package.json` | `scripts/versions.test.ts` |
| A feature PR never bumps a version or touches `dist/` | Only `release-prep/<version>` and a hotfix do. A feature PR adds an `[Unreleased]` entry. See [the gotcha](gotchas/mod-fix-did-not-reach-anyone.md). | `CHANGELOG.md` | `mod-version-check` on PRs into `main` |
| `dist/` equals a clean build | Tracked on `main` and rebuilt by `npm run plugin:build:release`. See [decision 60](decisions/60-the-built-plugins-are-tracked-in-dist-on-main-and-checked-on-every-pr.md). | `dist/` | `npm run plugin:dist:check` |
| An archive equals its tracked folder | Compared at the tag. | `scripts/plugin-dist-compare.mjs` | `scripts/plugin-dist-compare.test.ts` |
| PRs go branch, then `development`, then `main` | A PR into `development` is squash-merged; the release PR is a merge commit and carries no `Closes #N`. | `.github/workflows/pr-target-check.yml` | `pr-target-check.yml` |
| No session link leaves the machine | Not in a PR, issue, commit, code, doc or log. | `.claude/PROJECT.md` | the PR trace check |

## Findings, not patterns

The survey for this page found places where the code does not follow a candidate pattern consistently. They are not patterns. Each is its own issue.

| What | Issue |
|---|---|
| Four write routes on the fleet router have no token and no test lists them | [#1052](https://github.com/eengelking/podium/issues/1052) |
| 33 of 74 mockups carry their own `:root`, and 32 do not link `tokens.css` | [#1053](https://github.com/eengelking/podium/issues/1053) |
| `useRespond` polls while the page is hidden | [#1054](https://github.com/eengelking/podium/issues/1054) |
| Reporter helpers are copied between harnesses instead of living in `plugin/core/` | [#1055](https://github.com/eengelking/podium/issues/1055) |
| E2E specs use a real sleep and clock-derived data | [#1056](https://github.com/eengelking/podium/issues/1056) |
| `PROJECT.md` says CI runs only `test:core` | [#1057](https://github.com/eengelking/podium/issues/1057) |

## Related

- [Decisions](decisions/README.md) give the reasons behind many of these patterns.
- [Gotchas](gotchas/README.md) record what goes wrong when one is missed.
- `docs/standards/` is the design system.
