---
title: "76. The server tests on every adapter run from `npm run test:db`, with the options of `e2e:fast` (#1294)"
description: "One npm entry point replaces scripts/test-db.sh, with database, scope, shard and output options. A run that leaves a database out is never a pass."
group: "Project internals"
number: 76
date: "2026-11-21"
status: "accepted"
order: 76
---

# 76. The server tests on every adapter run from `npm run test:db`, with the options of `e2e:fast` (#1294)

*Amends 53 (#822, #891): the "every adapter runs before a PR" rule keeps its meaning. Only the command that holds it changes, from `scripts/test-db.sh` to `npm run test:db`.*

## Context

The browser suite has one entry point, `npm run e2e:fast`, with `--db`, `--shards`, `--out`, Cypress arguments after `--`, and one `E2E RESULT:` line. The server suite on every adapter was
`scripts/test-db.sh`, a bash script outside `npm run`. It took vitest arguments, `--image`, and the `PODIUM_TEST_ONLY` variable that agents are told never to set, and nothing else. It had
no output folder and no per-database result, so a PR body could only say that the run passed. The maintainer asked for the same shape on both sides, and for `npm run test:all` (#1295) to be
built over them.

Timing a full run on a developer laptop, on SQLite, PostgreSQL 17 and MariaDB 11.4 together, took 4 minutes 3 seconds (vitest: 320 files, 6379 tests, 226 s). Vitest already runs files in
parallel on every CPU, and each file makes and drops its own database on a shared server.

## Decision

- **`npm run test:db` runs `scripts/test-db.mjs`.** `scripts/test-db.sh` is removed with no wrapper. The container lifecycle and the machine's database lock (#1284) stay in bash, as
  `scripts/db-servers.sh`, because the lock is bash and `e2e-fast.mjs` leaves it to the bash it starts. Every behavior of the old script is kept: one throwaway container per server kind,
  started together, on 127.0.0.1 only, a wait of up to two minutes each with the log tail on failure, every container removed however the run ends, `CONTAINER_ENGINE`, `PODIUM_DB_LOCK` and
  `PODIUM_DB_LOCK_TIMEOUT_S`.
- **The options are `e2e:fast`'s where they mean the same thing:** `--db "KIND [KIND...]"`, `--shards N`, `--out DIR` and `-- <vitest arguments>`; and two of its own, `--scope adapters|all` and
  `--image KIND=REF`. An unknown or repeated kind is refused before anything starts.
- **A run that leaves a kind out says LIMITED and what was NOT RUN, and is not a pass for a pull request.** `--db` is held to the rule `PODIUM_TEST_ONLY` has: an agent does not use it to
  leave a database out unless the person asked for that in the session. `PODIUM_TEST_ONLY` keeps working for CI and `npm test`, and names the kinds when `--db` is not given.
- **The run ends with one `DB TEST RESULT:` line.** Vitest reports no result per database, so the script reads its JSON report. A test counts for a database when its file is in that
  database's folder, or a describe title names the kind or its label; every other test counts under SQLite, the default. The line is `sqlite=PASS postgres=FAIL(1) mariadb=NOT RUN`, and
  each database's files and tests follow. Exit code: vitest's; 2 for bad arguments or a setup error, never a pass.
- **`--shards` is a plain pass-through, default 1, with no sizing.** `--shards N` runs vitest's `--shard i/N` one after another on the same containers. The timing above says a full run is
  short, and more processes on a machine vitest already fills would only bring back the overlap the lock exists to stop, so no shard count is chosen from the machine. A split across
  machines is CI's.
- **`--scope adapters` runs only what depends on a database server:** each chosen kind's folder under `server/src/storage/`, `adapters.test.ts` and the `chatGoneReads` files. The default,
  `all`, runs the whole server config, as before.

## Why

- Two suites with two shapes means two sets of habits and two sets of PR-body lines. One command per suite, with the same words, is what an agent reads once.
- A per-database line puts the evidence in the PR body that the rule asks for, instead of a sentence saying the run passed.
- `PODIUM_TEST_ONLY` is an environment variable an agent can leave set. `--db` is visible in the command line and in the result line.

## Alternatives

- Keep `scripts/test-db.sh` and add an npm alias: the options still would not exist, and the result would still be one vitest summary.
- One vitest run per kind, as CI's two jobs do, for a per-database result: it runs the whole suite once per database, three times as long, for a line the report gives for free.
- Choose a shard count from the CPUs, as `e2e:fast` does: a full run takes four minutes, so there is nothing to win.
- Move the container lifecycle and the lock to Node: it would rewrite the lock that three scripts share, for no change in behavior.

## Cost

- The attribution of a test to a database is by folder and by name. A test of another database that never names it counts under SQLite. The PR body still lists every file and test.
- `scripts/db-servers.sh` is one more script, and a script that read `scripts/test-db.sh` by name had to change (every mention in the repo did).

<!-- nav:start -->
---

Previous: [75. A Direct Message ends when an agent in it finishes, and the agents that remain are told (#1283)](75-a-direct-message-ends-when-an-agent-in-it-finishes-and-the-agents-that-remain-are-told.md) · Up: [Decisions](README.md)
<!-- nav:end -->
