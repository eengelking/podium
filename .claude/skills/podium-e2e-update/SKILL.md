---
name: podium-e2e-update
description: Keep the Podium end-to-end suite (e2e/, Cypress in a container, docs/e2e/COVERAGE.md) true to the console. Load this whenever a change adds, changes or removes a feature - anything in frontend/, server/ or mod/ that changes what a page shows or does, a route, a setting, an Admin flag or a reporter option, a label, a control, a state or a default - before the PR is opened, and when the e2e run fails or a spec is to be added, changed or removed. It explains how the suite is built and run, how to find the specs a change touches, the rules that keep it deterministic, and how to verify it. It never installs anything on the host.
---

# Updating the Podium end-to-end suite

The suite is Cypress, run in the pinned `cypress/included` container against Podium's own image on a private container network (decision 48). `docs/e2e/COVERAGE.md` is its map and its how-to; read it first. This skill is the procedure for keeping the two true as the console changes.

## Does this change need an e2e update?

Yes, when it changes something a browser can observe: a label, a button, a control, a state, a page, a route the console calls, a setting or Admin flag or reporter option, a default, a layout, a message. No, for a refactor that keeps every behavior, a test-only or docs-only change, a copy change nowhere a spec asserts it (search `e2e/` for the old text first), or a server-internal change with no visible effect. When no spec changes, the PR says so and why.

## Procedure

Work on a branch in a worktree, as for any change (`.claude/CLAUDE.md`, "Always Branch First").

1. **Find what changed.** `git diff origin/development...HEAD`. List each observable behavior added, changed or removed.
2. **Find the specs it touches.** The map in `docs/e2e/COVERAGE.md` points from a feature to its files. Then `grep -rn "<old label or id>" e2e/`. For a removed feature, find everything that names it, including helpers in `e2e/support/commands.js` and the seed in `scripts/e2e-seed.mjs`.
3. **Decide per behavior.** Update an assertion; add a test to the spec file of its area; add a new spec file (one area per file, named for what it covers) and its map row; remove the test, the map row and any seed data or `data-testid` a removed feature leaves behind. If the code and `docs/spec/` disagree on the behavior, do not choose: assert neither and report the contradiction.
4. **Write it the way the suite is written.**
   - `before(() => cy.resetServer())` first: the server restarts on an empty database and is seeded, so a spec file never depends on another. Options: `{ seedArgs: '--bulk 30' }`, `{ env: ['STALE_AFTER_MS=2000'] }`, `{ noSeed: true }`.
   - Select by ARIA role and name, label, an id that is part of the page's contract, or text. A `data-testid` (kebab-case, no data in it, `data-state` for a state a spec waits on) only where none of those singles it out; it is the only app change you may make and it changes nothing a person sees.
   - Sign in with `cy.signIn('Ed')`, `cy.signIn('Admin')`, `cy.unlockAdmin()` or `cy.openAdmin('Settings')`: they set the cookie by request, so the admin secret is never typed or logged. Change what a reporter reports with `cy.reportAgain(key, over, agents, steps)`, flags with `cy.setFlags`, the server with `cy.task('server:pause')` and `server:resume`.
   - Assert with retrying queries. Never `cy.wait(ms)`, a clock-derived value, a count that may still be changing, or a retry (`retries` is 0 on purpose). A value that is live is asserted with `should(...)`, so it retries.
   - New fixed data goes in `scripts/e2e-seed.mjs` with fixed ids, names and costs, through the server's own routes; it must stay restartable. **A new seed session or changed figure must not change what an existing spec reads** (counts of cards, tiles, rail pages, Admin rows): put it behind an option (`--bulk N`, `--ended N`, `--talk`, `--recording`, `--rich`, `--reporters`, `--flags defaults|none|<list>`) and pass it with `cy.resetServer({ seedArgs: '--rich' })`. The default seed's twelve sessions are the contract.
   - Play the reporter mod with `cy.task('diffs:start')` and `diffs:stop` (it answers the console's file-diff requests from `e2e/support/diffs.cjs`), and read exports with `cy.task('download:read', '.csv')`. axe-core is read with `cy.task('axe:source')` through `cy.checkA11y({ known })`; a known violation needs a rule and a target, an issue number in its comment, and is let through only while axe still reports it.
   - Colors are never hard-coded; this suite touches no CSS.
5. **Update the map.** Add or change the feature's row in `docs/e2e/COVERAGE.md`, with the spec file in a code span; a feature that cannot be checked this way goes under "What no end-to-end spec can reach" with the reason. Do not reword other rows.
6. **Run it.** `npm run e2e` builds the image from the working tree, so the app change is in it. A spec alone: `npm run e2e -- --no-build -- --spec "cypress/e2e/<area>/**"`. Then the whole suite, and once more: it must pass with no error and no retry. A failure in a spec you did not touch is a regression or a flaky spec; find out which and say so. Never weaken an assertion, skip a test or add a wait to get green; if an assertion must change, say what and why.
7. **Verify the rest.** `node scripts/e2e-map.mjs`, `npm test` (it runs the map check), `node scripts/check-doc-frontmatter.mjs`, `node scripts/check-doc-refs.mjs`, `node scripts/check-doc-links.mjs`. If a `data-testid` was added, `npm test -w frontend`.
8. **Clean up.** `npm run e2e:down`, then `podman ps -a`, `podman network ls` and `podman volume ls` (or docker's) must show nothing of the run. Nothing is installed on the host: no `npm install` for Cypress, no `~/Library/Caches/Cypress`, no `e2e/node_modules`.
9. **Report** the specs added, updated and removed, the map rows changed, each run's passing and failing counts, and anything not run, any contradiction between code and spec, and any decision for the maintainer.

## Traps

- **Tests that depend on each other inside a file** are allowed only where a file's story is one sequence (the recording spec stops a recording in one test and reads its replay in the next). Say so in a comment.
- **A flag turned off and on again can drop server state** (recordings). A spec that toggles a flag restores it in `afterEach`, or runs on a server of its own.
- **Live entries only show what arrived after a viewer began to watch**, by the entry's `at`: build the entry when you push it, with a fresh id.
- **A report carries the reporter's options.** `cy.reportAgain` starts from the seed's report, so an option a test turns off must be passed again with each later report.
- **Cypress cannot start a real fullscreen**, and the headless window must be at least as wide as the viewport (`--window-size` in `e2e/cypress.config.cjs`); an element past the window counts as covered.
- **A menu that closes on scroll** (Admin > People's Actions) is chosen with `click({ force: true })` after it is checked open, because Cypress scrolls to reach it.
- **Cypress 16 has no `Cypress.env()`.** Use `cy.env(['NAME'])`; the admin secret reaches the browser side only that way.
- **No secrets anywhere.** The admin secret is per run, in a mode-600 file and an env file, and never in a log, a screenshot or an artifact. Seed tokens are fake and new for each database.
