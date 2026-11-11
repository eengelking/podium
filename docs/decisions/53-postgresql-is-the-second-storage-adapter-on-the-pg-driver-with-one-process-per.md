---
title: "53. PostgreSQL is the second storage adapter, on the pg driver, with one server per database (#822)"
description: "A postgres kind behind the storage interfaces, with Activity history in its own schema, byte-order text and one process per database; no data moves from SQLite."
group: "Project internals"
number: 53
date: "2026-10-31"
status: "accepted"
order: 53
---

# 53. PostgreSQL is the second storage adapter, on the pg driver, with one server per database (#822)

**Context.** [Decision 48](48-storage-sits-behind-async-interfaces-with-sqlite-as-the-only-adapter.md) put the server's storage behind async interfaces and left SQLite as the only adapter. #314 asked whether to add PostgreSQL and MariaDB. #822 builds the PostgreSQL adapter and the groundwork a MariaDB adapter (#823) would share. SQLite stays the default, and a database from the previous release opens as before.

**Decision.** `PODIUM_DB=postgres://user:pass@host:5432/dbname` selects a `postgres` kind in the registry in `storage/index.ts`. `postgresql://` is accepted as an alias. The adapter is in `server/src/storage/postgres/`, and nothing outside it imports `pg`. The choices below are the ones the issue listed, plus the ones the work forced.

- **Driver.** `pg` (node-postgres), with a pool for each schema. It loads only when the kind is chosen, as SQLite's adapter does.
- **No password in a log.** The label shown in the log and in `/health` is `host:port/dbname`. The user and the password are never in it, and `podiumctl config` hides them too.
- **Activity history.** It lives in the same database, in its own schema `podium_activity`, on its own pool. The main tables are in the schema `podium`. The isolation #313 built stays: a slow Activity history write does not hold up a report. A separate database would need a second URL for no benefit.
- **Maintenance.** There is no `VACUUM` and no `wal_checkpoint`. Autovacuum gives back the space of removed rows, so the Activity history's compaction does nothing and reports 0 bytes freed.
- **One server per database.** The adapter takes a session advisory lock (`pg_try_advisory_lock`) on a connection of its own at start. A second Podium finds it taken, stops with a message that names the database by host and name, and exits non-zero. The lock goes with the connection, including when the process dies.
- **Transactions.** `PgDb.tx` takes them one at a time through a gate, as the SQLite lock did, and a statement made outside a transaction waits at the same gate (#1007), so a call from another task cannot run between a transaction's read and its write. That is kept on purpose: a read followed by a write stays one step, which the stores' code relies on. A nested `tx` joins the open one. A step that can be undone alone uses `SAVEPOINT`, in `peerRights` and `personCerts` as before.
- **Text compares as bytes.** Every text column is `COLLATE "C"`, so ordering, unique keys and indexes do not depend on the locale the database was created with. `podium_lower(x)` folds ASCII letters only, as SQLite's `lower()` does.
- **Migrations.** One baseline step for each schema equals the end state of SQLite's 25 migrations (and the Activity file's steps). The issue said 23; the code had 24 and #822 adds a 25th, `seq` columns on `peer_messages` and `person_certificates`. Later changes are steps added to the list. The version is kept in `schema_migrations`, in each schema, so the Activity history needs no `user_version`.
- **Explicit tiebreaks.** PostgreSQL has no `rowid` and no stable order on a tie. The two tables ordered by `rowid` get a `seq` column (SQLite migration 25 adds it, so the SQLite adapter keeps passing the same contract), and queries that sorted only by time now end in `id`: sessions by `started_at, id`, blowouts by `t, id`. The contract asserts these orders.
- **Values.** `bigint` and `numeric` come back as numbers. A whole number beyond `Number.MAX_SAFE_INTEGER` is an error, not a silent loss of low digits.

**Why.**

- PostgreSQL is the database most people already run, and a team that shares one server wants it behind Podium instead of a file.
- The seam from decision 48 meant no caller changed. The work was the adapter and the SQL differences.
- A baseline step is simpler to prove equal to SQLite's end state than 25 steps replayed, and a later change still has a clear place to go.
- Byte order and one process keep the behavior the stores already depend on, instead of finding out in production that a sort or a read-then-write differs.

**Alternatives.**

- A separate database or a second URL for the Activity history. More to set up, and no gain over a schema with its own pool.
- Replay the 25 SQLite migrations in PostgreSQL. They were written for SQLite's types and `ALTER` limits, and the end state is what matters.
- Take the database's default collation. Ordering and unique keys would change with the locale of whoever created the database.
- Allow several servers on one database. Open asks, sign-ins, lockouts and the live caches live in one process's memory, so a second process would not see the first's.

**Cost.**

- Every database needs a PostgreSQL server of its own to be set up and backed up. Podium makes no copy of it.
- No data moves from a SQLite file into PostgreSQL. A migration tool is a follow-up if people ask for it.
- One server process per database. There are no read replicas and no high availability, and connection-string options go only as far as `pg` takes them from the URL.
- Reads that cost microseconds in-process cost milliseconds over a network, and the server makes many small reads per report.
- Two adapters to keep in step. `contract.ts` runs against both, and the PostgreSQL tests run only when `PODIUM_TEST_PG` names a server.

**Addition (#823, MariaDB).** MariaDB is the third adapter, built on the groundwork above. `PODIUM_DB=mariadb://user:pass@host:3306/dbname` selects a `mariadb` kind in the same registry, and nothing outside `server/src/storage/mariadb/` imports its driver. The choices that differ from PostgreSQL's:

- **Driver.** The official `mariadb` connector, with its pool. `mysql2` is not used, and MySQL is not claimed: the adapter's SQL (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `RETURNING`, the `utf8mb4_nopad_bin` collation) is MariaDB's own, and nothing has been tried on MySQL or another server that speaks its protocol.
- **Kind name.** `mariadb`, with no alias. The label in the log and in `/health` is `host:port/dbname`, and the driver is told to keep bound values out of its errors.
- **Activity history.** The same database, in tables of their own (`entries`, `stored_sessions`, `loops`, `rec_sessions`, `rec_entries`, with `activity_schema_migrations` beside the main `schema_migrations`) on their own pool. MariaDB has schemas only as databases, and a second database would need a second URL or a second grant, so the tables share one database, under names that do not overlap the main ones.
- **Collation.** Every text column, the database's default and each connection are `utf8mb4` under `utf8mb4_nopad_bin`: bytes compare as they are and a trailing space counts, as on SQLite, and emoji are kept. The default `utf8mb4_general_ci` would make `Ed` and `ed` one key. Case folding in SQL is ASCII only (`asciiLower`), since MariaDB's `LOWER()` folds `É` too.
- **Versions.** One version line, 11.x, tested on one version, 11.4, the long-term release: CI runs the tests on 11.4 (`Test with MariaDB 11.4`) and the end-to-end suite runs on the image `mariadb:11.4.13`, pinned. Other versions are untested; the SQL needs `RETURNING` and `ADD COLUMN IF NOT EXISTS`, which 10.5 also has, but no older version is run, and the adapter does not check the server's version. PostgreSQL is held to the same rule: 17 is the one version supported and tested. The supported databases are SQLite (built in), PostgreSQL 17 and MariaDB 11.x (tested on 11.4).
- **One server per database.** A named lock, `GET_LOCK`, on a connection of its own held outside the pools for the life of the server, as the advisory lock is on PostgreSQL. Its name is `podium:` and a hash of the database name, because a lock name is per server and at most 64 characters.
- **Migrations.** The same steps as PostgreSQL, with the same numbers. DDL commits on its own in MariaDB, so a step is not a transaction: each statement is written to be run again, and the step is recorded after its last one, so a runner stopped part way through resumes.
- **Maintenance.** No `OPTIMIZE TABLE`, which rebuilds and locks a table; InnoDB reuses the space of removed rows.

Why: MariaDB is the other database #314 asked about, and the PostgreSQL work had already made the adapter one folder and one registration. Alternatives: `mysql2`, which reaches MySQL as well, but the SQL would still be MariaDB's, so the wider driver would only suggest support that is not there; testing MariaDB 10.5 as well as 11.4, which would add a CI job for a version that is out of support; the database's default collation, which compares case-insensitively and would merge names the other adapters keep apart. Cost: a third adapter to keep in step, one more CI job and a third run of the end-to-end suite on a release; keys and indexed text have length limits SQLite and PostgreSQL do not have; a fraction sent straight to an integer column is rounded by MariaDB, where SQLite keeps it and PostgreSQL throws (in MariaDB's `known` list under #823, and refused by the routes before any store is called).
