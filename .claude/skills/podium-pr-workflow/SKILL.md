---
name: podium-pr-workflow
description: What is specific to Podium around a pull request - the pre-PR checks (mod tests, sonar analyze, UI, atlas, docs) the Podium additions to the PR trace check, and the adapter parity check. Load this alongside /eengelking:github-pr-merge before opening any PR, after every push to an open PR, when a PR check or the SonarCloud gate fails, and when you change a PR's title or body. Use it for any change under plugin/ (the mod tests do not run in CI), for the `sonar analyze` run, and for the Haiku trace-check subagent's Podium patterns.
---

# Opening a PR in Podium

`/eengelking:github-pr-merge` owns the sequence: static analysis, the trace check, opening the PR, the conflict check and `gh pr checks --watch` after every push, closing the issues after the merge, and cleanup. `PROJECT.md` holds the rules (no session links, no version bumps in feature PRs, the maintainer merges). This skill holds only what that skill cannot know about Podium.

## Before the PR

1. **Reporter changes.** A change under `plugin/` runs the checks for where it sits. `plugin/core/` runs `npm run test:core` (no harness CLI needed) and every harness's pair; `plugin/<harness>/` runs that harness's pair, `npm run test:mod:<harness>` and `npm run typecheck:mod:<harness>` (today only `claudecode`). `test:mod:claudecode` builds the plugin with its tests into `.build-test/` first and then runs `claude plugin test` on that built folder. CI runs `test:core` and, through `npm test`, the same core tests; it also runs the OpenCode pair (`test:mod:opencode`, `typecheck:mod:opencode`) but not the Claude Code pair (it needs Claude Code's CLI installed), so nothing else catches a Claude Code regression until the release gate does. Report the result in the PR body.
   - When a `test:mod:<harness>` shows failures, compare against a clean `development` (or the last release tag) before calling them yours or not yours, and say which.
   - A failure that is not new still goes to the maintainer: file an issue rather than carry it silently into a release (the release gate allows no known failure).
   - If a `typecheck:mod:<harness>` cannot find `claude-code.d.ts`, say so in the PR; do not report it as passing.
2. **`sonar analyze`** on the files you changed (`/eengelking:development-commands`, `sonar-analysis.md`, has the command, the skipped-analysis wording, the 80% coverage gate and the rules to avoid). This repo's history: `typescript:S6324`, `replaceAll`, `Number.parseInt` (#366) and a first push that failed the gate at 44% for untested log call sites (#367).
3. **UI branch.** A branch that changes `frontend/` or `mockup/` runs `/podium-standards-check` once on the branch and fixes what it reports or says why not. Check the built narrow layout with `scripts/page-shot.mjs` (`/eengelking:development-commands`, `ui-screenshots.md`; `PROJECT.md`, "UI Standards").
4. **Atlas.** A structural or architectural change loads `/podium-atlas-update`, or has the `podium-atlas-keeper` agent run it (a fresh, non-fork agent; do not edit the atlas files while it runs). Read its report and the diff before committing. A change that touches nothing the atlas states needs no update, and the PR says so.
5. **Docs.** Run the skill `/eengelking:documentation-sync` before every commit, and once more on the whole branch before the PR is opened. Do not treat "I updated the docs" as having run it: it is the check for stale, invalid and missing docs, and it is the step that gets skipped. The PR body has a line `Docs sync:` that says what it changed, or that nothing applied and why. Add `/podium-docs-site` for a doc page.
6. **End-to-end specs.** A feature a browser can observe loads `/podium-e2e-update`, or has the `podium-e2e-keeper` agent run it (a fresh, non-fork agent). `npm run e2e` passes on the whole suite, and `docs/e2e/COVERAGE.md` changes with the feature.
7. **Server tests on every adapter.** A change under `server/` runs `scripts/test-db.sh` (the whole server suite with a throwaway container for every adapter that needs a database server, PostgreSQL and MariaDB, started together, SQLite included), not `npm test -w server` alone. The adapters, their images and their test server variables are the table in `scripts/db-adapters.mjs` (`node scripts/db-adapters.mjs kinds --server`), so the script needs no edit when an adapter is added. Each database runs on the one version Podium tests, in CI and in the script: PostgreSQL 17 and MariaDB 11.4. Never set `PODIUM_TEST_ONLY` to get past a "`PODIUM_TEST_PG` is not set" or "`PODIUM_TEST_MARIADB` is not set" error: that only hides the adapter, and a run that did it is reported as limited (for example `SQLite and PostgreSQL only, MariaDB NOT RUN`), not as passing. Only set it when the user asked in this session to leave an adapter out. The PR body has a line naming each adapter that ran and its counts (for example `SQLite, PostgreSQL and MariaDB: <n> files, <n> tests`), and the Haiku trace and parity check reads that line and runs the suites again itself.
8. **`/code-review` once** for a code change, per CLAUDE.md's Review row.
9. **Patterns.** Run `/podium-patterns-check` on the branch: the PR body names the patterns in `docs/PATTERNS.md` the change relies on, and the change departs from none and alters none.

## The PR trace check, Podium patterns

Run the check in `/eengelking:github-pr-merge`'s `resources/pr-trace-check.md` (a fresh, non-fork Haiku subagent, authority stated in its prompt). Give it these patterns as well:

- a link to a Claude Code session (`claude.ai/code/session_` followed by an id), or a `Claude-Session:` trailer, in the title, body, a commit message or the diff. This is a Do Not and is always a failure. The words that name the pattern in `PROJECT.md` or this skill are not a hit; an actual id is;
- a `pdm_` token, or the contents of a reporter config file;
- the scratchpad path, among the author-machine paths.

A pass is a claim, not the check. Also run this over the commit messages, the title and body file, and the diff, and expect no output (in a PR that edits the rule itself, the lines of the rule are the only hits allowed):

```bash
git log <base>..HEAD --format=%B | grep -nE 'claude\.ai/code|session_[A-Za-z0-9]{10,}'
grep -nE 'claude\.ai/code|session_[A-Za-z0-9]{10,}' <body-file>
git diff <base>...HEAD | grep -nE 'claude\.ai/code|session_[A-Za-z0-9]{10,}'
```

## Adapter parity check

`PROJECT.md` ("A database change is made in every adapter") is the rule. This is how the check runs. It is a second job for the Haiku agent that does the trace check, with the same authority: report only.

**When.** Whenever the diff against the base branch touches any file under `server/src/storage/`. Otherwise the agent answers `not applicable: no storage change` and runs nothing. Running the tests only for a storage change keeps an unrelated PR from needing a database server.

**What the agent does.**

1. **List the adapters.** Read the registry in `server/src/storage/index.ts` and list the folders `server/src/storage/*/`. Do not use a fixed list: today it is `sqlite`, `postgres` and `mariadb`, and an adapter added later must be picked up the same way. A folder with no registry entry, or an entry with no folder, is a finding.
2. **Read the interface diff.** Take `git diff <base>...HEAD` for `server/src/storage/types.ts`, `rows.ts`, `settings.ts`, `features.ts`, `reportQueries.ts` and `contract.ts`. For each added, changed or removed method, row type or constant, find the matching change in every adapter: the store code, the schema and migration, and the `contract.ts` case that exercises it.
3. **Sweep the whole codebase, not only the diff.** The diff shows what this PR changed; drift is usually in a query the PR did not touch. For every adapter folder, list every query that returns a list (`.all(`, `db.all`, a `SELECT` whose caller keeps more than one row), whether or not the diff touches it, and check each of these:
   - The query has an `ORDER BY` in every adapter (read the whole statement, including a constant or a `${...}` fragment that holds the `ORDER BY`, not only the quoted text), or the caller can show that order does not matter. A read whose rows only feed a sum, a set, a count or a delete loop needs no `ORDER BY`, but carries `// order-insensitive: <why>` next to the query, which the script below requires. A read whose order can reach a person, a response, a broadcast, a log or a test assertion needs one, or a comment next to it saying why not. An `ORDER BY` in one adapter and none in another is a finding. So is an `ORDER BY` whose last column is not unique (a random id, a timestamp, a name): ties must end on a key that is unique and stable, not on `id` when `id` is generated.
   - The `ORDER BY` columns match between adapters once the dialect is set aside (`lower`, `podium_lower` and MariaDB's `asciiLower(...)`, `NULLS FIRST` and `NULLS LAST` and MariaDB's `x IS NULL` term, `?` and `$1`).
   - Every store method in `types.ts` and `reportQueries.ts` has a case in `contract.ts` or one of the `contract*.ts` files (search the method's name). A method with no case is a finding, as is a new method whose case does not compare list order or ties.
   - No adapter has a store method, or a query inside one, that another lacks.
   - A comparison that the database decides rather than the code (text collation, `lower()` on non-ASCII text, `LIKE` case sensitivity, number and boolean types, `NULL` ordering) is stated the same way in every adapter: `COLLATE "C"` on PostgreSQL's text columns, `utf8mb4_nopad_bin` on MariaDB's columns and connection, ASCII-only folding, and so on (`docs/architecture/02-components/19-storage.md`).
   Report these findings in their own table, apart from the diff table, and say how many queries were swept. A sweep that found nothing says how many it looked at; an empty answer with no count is not a pass.
4. **Report a table**, one row per change and one column per adapter, each cell `done`, `missing` or `not applicable` with the reason. A column, table, index, key or constraint must be in every adapter's schema and migration. A migration that rewrites existing rows must have an upgrade test in each adapter.
5. **Run every adapter's tests.** One `npm test -w server` with every adapter's test server variable set runs them all, SQLite included (PostgreSQL: `PODIUM_TEST_PG`; MariaDB: `PODIUM_TEST_MARIADB`; each entry of `scripts/db-adapters.mjs` names its variable). The orchestrator starts the throwaway server as `/eengelking:development-commands` and `CONTRIBUTING.md` describe, a Podman container and never the maintainer's database, and gives the agent only the variable name in the prompt. The agent starts no long-lived process it cannot stop. Report per adapter the number of files and tests passed, failed and skipped.
6. **Report each adapter's result in the PR body** (contract, upgrade, differential: passed, failed, skipped, per adapter, with the differential seed). A failure on any adapter is fixed so the case passes on all of them; never skip or loosen it for one (`PROJECT.md`). A line in an adapter's `known` list needs its issue number. **Read the checks on the PR:** `gh pr checks <PR>` must show a job for each adapter (`Test with PostgreSQL` and `Test with MariaDB 11.4` today). A missing adapter job, or one that is skipped, is a FAIL; `adapters.test.ts` also fails when `ci.yml` lacks it. List the exact check names a new adapter adds so the maintainer can put them in the "Protect development and main" ruleset.
7. **Give a verdict.** FAIL if any adapter lacks a required update, if the sweep finds a drift in a query (touched by the diff or not), if any adapter's tests fail, or if an adapter's suite is skipped (no server counts as a failure, not a pass) or the contract did not run against it. Otherwise PASS.

**Passwords.** The agent never prints a connection string that has a password in it, in a command, a log line or the report. The maintainer's secrets hook blocks the message and the report never arrives. Write the variable's name (`$PODIUM_TEST_PG`, `$PODIUM_TEST_MARIADB`) or `host:port/dbname`.

**What the check is.** It reads the diff and sweeps the code for drift, then runs the suites. The suites alone cannot show drift nobody wrote a case for, and a prompt that names the queries to look at only confirms them (#890 found about ten list orders that way, none of which the old suites or a diff-only check would have). Give the agent the task, not the answer: do not list the queries you changed or say what the diff contains. The agent also runs `node scripts/storage-order-parity.mjs` (add `--list` to see every query it read) as an added step of the sweep and reports its output and exit code. It needs no database server. The script fails on a list that one adapter orders and another does not, on different `ORDER BY` columns once the dialect is set aside, on a list with no `ORDER BY` and no `order-insensitive` mark, and on a method that lists in one adapter and has no counterpart in another. It is also part of `npm test` (#910). It reads the order only, so the sweep above still covers ties, contract cases and database-decided comparisons by reading.

**A pass is a claim.** The main session runs the same tests itself, with the same server, before the PR is opened, and again after a push that changes anything under `server/src/storage/`.

**The prompt** (the orchestrator fills the angle brackets):

```text
Authority: report a verdict only. You do not edit files, commit, push, merge or
touch the PR, and you do not start other agents. You start no long-lived process.

Branch <branch>, base <base>, worktree <path>. In addition to the trace check,
run the adapter parity check from podium-pr-workflow.

1. If git diff <base>...HEAD touches nothing under server/src/storage/, answer
   "not applicable: no storage change" and stop this job.
2. List the adapters from server/src/storage/index.ts and the folders
   server/src/storage/*/. Do not assume a list.
3. Sweep the whole of server/src/storage/ for drift, not only the diff. The
   diff is only where to start; do not limit the sweep to the queries the
   orchestrator names. For every adapter folder, list every query that returns a
   list. For each, check that every adapter has an ORDER BY (or a comment saying
   order does not matter), that the columns match once the dialect is set aside,
   and that the last column is unique and stable (not a generated id or a bare
   timestamp). Check that every store method in types.ts and reportQueries.ts
   has a case in contract.ts or a contract*.ts file, that no adapter has a
   method or query another lacks, and that text collation, case folding, null
   ordering and number types are stated the same way everywhere. Report the
   findings in a table of their own and say how many queries you swept.
4. For each added, changed or removed method, row type or constant in
   types.ts, rows.ts, settings.ts, features.ts, reportQueries.ts and contract.ts,
   report change x adapter as done, missing or not applicable (with why),
   covering store code, schema, migration and the contract case.
5. Run npm test -w server with every adapter's test server variable set:
   <PODIUM_TEST_PG> and <PODIUM_TEST_MARIADB> already point at throwaway
   servers. Report files and tests passed, failed and skipped per adapter.
6. FAIL if any adapter lacks a required update, the sweep finds drift in a query
   (touched by the diff or not), any adapter's tests fail, or any adapter's suite
   is skipped or the contract did not run against it.

Never print a connection string with a password; write $PODIUM_TEST_PG,
$PODIUM_TEST_MARIADB or host:port/dbname. Return the sweep findings and how many queries you swept, the diff table, the counts and PASS or FAIL.
```

## After the PR is open

The SonarCloud quality gate is one of the checks. For a failing gate, read the PR's open issues. After the user merges, `/eengelking:github-pr-merge` closes the issues and cleans up; this repo's issue comment is `Fixed in #<PR>; ships with the next release.`
