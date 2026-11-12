---
title: "Storage"
description: "How the server reaches its database: async interfaces, the SQLite, PostgreSQL and MariaDB adapters, the locks, the caches and the rules for calling it."
group: "Project internals"
order: 19
---

# Storage

This page covers how the server reads and writes its data, one part of [the components](README.md). It is for a contributor
who is about to call a store, add one or change what sits under it. Nothing here changes what the console shows. The
tables and their migrations are in [SPEC 7.2](../../spec/07-server/07-02-database.md), and the reason for the shape is in
[DECISIONS 48](../../decisions/48-storage-sits-behind-async-interfaces-with-sqlite-as-the-only-adapter.md). The PostgreSQL adapter
is [DECISIONS 53](../../decisions/53-postgresql-is-the-second-storage-adapter-on-the-pg-driver-with-one-process-per.md), and the MariaDB adapter is the addition to it (#823).

Contents:

- [The layers](#the-layers)
- [Choosing the implementation](#choosing-the-implementation)
- [The lock and the transaction](#the-lock-and-the-transaction)
- [Reads that cannot wait](#reads-that-cannot-wait)
- [Ordering above the storage](#ordering-above-the-storage)
- [Start and stop](#start-and-stop)
- [Rules for calling it](#rules-for-calling-it)
- [Chat's stores](#chats-stores-1034)
- [The PostgreSQL adapter](#the-postgresql-adapter)
- [The MariaDB adapter](#the-mariadb-adapter)
- [Adding an adapter](#adding-an-adapter)
- [What is not shared between processes](#what-is-not-shared-between-processes)
- [Small timing differences](#small-timing-differences)

## The layers

`server/src/storage/` holds the part the rest of the server depends on.

| File | What it holds |
|---|---|
| `types.ts` | `Storage`, the one object a server is built from, and the async interface of each store it hands out, each written out in full |
| `index.ts` | `openStorage`, the one place that picks the implementation, and the only file here that imports the adapter (on demand, with `import()`) |
| `rows.ts` | The row types, errors, constants and pure helpers the stores share, and the one place app code imports them from |
| `features.ts` | The notice and feature flag tables and their ids (re-exported by `rows.ts`) |
| `settings.ts` | The limits, defaults, ranges and value checks for the Admin's settings (re-exported by `rows.ts`) |
| `lock.ts` | `AsyncLock`, the queue each adapter puts in front of a connection |
| `peerText.ts` | The pure helpers both messaging stores share: control-character cleaning, round trips used, the notice cap |
| `chatRows.ts` | The pure part of Chat's stores (#1034), shared by every adapter: the channel id (`grp_` or `pub_`, the server's scope, 24 hex digits), the author kinds, the mention states, the row-to-message conversion, and `chatSettingsOver`, the Admin's Chat limits and each channel's flags over a key-value view of `settings` that each adapter lends. Nothing in it touches a database or knows `peer_messages` |
| `adapters.test.ts` | The one test every adapter passes (#1008): the contract, the upgrade cases, the differential test, and the guards (a method with no case, a table, column or index in one adapter and not another, a registered adapter with no CI job or e2e run). It loops over the kinds registered in `index.ts`, so a new adapter is added in one place |
| `contractAdapter.ts`, `sqlite/contractAdapter.ts`, `postgres/contractAdapter.ts`, `mariadb/contractAdapter.ts` | What the tests need from an adapter: open a fresh storage, open one at the oldest schema, read its table, column and index names, and the defects another issue owns (`known`). Each adapter folder has one; `index.ts` registers it as the kind's `testing` entry |
| `contract.ts` | The checks a store must pass on every adapter, with the expected values written out: the type of every field of the main rows, how names compare, and the order lists come back in |
| `contractSame.ts`, `contractSettings.ts`, `contractFleet.ts`, `contractPeers.ts`, `contractActivity.ts`, `contractReports.ts` | The rest of the contract (#890): one case for every other store, each running a scenario over every registered adapter and comparing every value it records between each pair of them (results, thrown messages, list order with ties); none is the reference for another. Generated ids and the size of the database file are compared by type only, the one list of differences that are not defects (`contractSame.ts`) |
| `contractDifferential.ts`, `contractMethods.ts`, `contractCalls.ts` | The differential test (#1008): seeded random and edge-case calls (fractions, huge numbers, NUL and control characters, lone surrogates, collation cases, ties, concurrent transactions) through every adapter, diffed for result, error class and list order. The seed is printed and replays with `PODIUM_DIFF_SEED`; a failing program is shrunk. `contractMethods.ts` lists every method of `types.ts` with the compiler and `contractCalls.ts` notes the calls the tests make, so a method with no case fails `adapters.test.ts` |
| `serverGate.ts` | Fails the run when an adapter that needs a test server has none configured (`PODIUM_TEST_ONLY` leaves kinds out on purpose and the run says they were NOT RUN) |
| `reportQueries.ts` | The fleet-wide reporting queries behind Admin > Reporting |

Nothing in those files imports an adapter's folder or its driver (`node:sqlite`, `pg`, `mariadb`), except `index.ts`; no adapter imports another (`neutral.test.ts` checks that too: what they share lives in these files); `neutral.test.ts` fails if one does, and if any file outside the adapter that is not a test reaches for `sqliteHandle` or
`activityHandle`; the shared test builders that need raw SQL (`rollupFixtures.ts`) live in `storage/sqlite/`.
The adapter imports from them, never the other way round, and its `openSqliteStorage` is typed against the interfaces in
`types.ts`, so a signature that drifts is a compile error there.

`server/src/storage/sqlite/` is the default adapter. `index.ts` there (`openSqliteStorage`) builds it, `peers.ts` and
`activity.ts` wrap the messaging and Activity history services. The rest of the folder is the
synchronous SQLite classes the adapter wraps: `db.ts` (schema, migrations, the fleet queries), `people.ts`, `reporters.ts`,
`peerService.ts`, `peerRights.ts`, `peerMessages.ts`, `peerSettings.ts`, `featureFlags.ts`, `wallSettings.ts`,
`modelPrices.ts`, `recordingSettings.ts`, `activityHistorySettings.ts`, `activityDb.ts`, `activityHistory.ts`,
`recordings.ts`, `personCerts.ts` and `tlsSettings.ts`. They still use `node:sqlite` directly. Nothing outside
`storage/` imports them, apart from tests.

`server/src/storage/postgres/` is the second adapter (#822), described [below](#the-postgresql-adapter). Only that folder imports
`pg`, and `neutral.test.ts` fails if a file outside it does. `server/src/storage/mariadb/` is the third (#823), described
[below](#the-mariadb-adapter); only it imports `mariadb`, under the same test.

Every method on a store returns a promise. `Fleet`, the routers and the sweeper take a `Storage` and call it. Tests open
`openSqliteStorage(':memory:')`.

## Choosing the implementation

`openStorage` reads `PODIUM_DB`. A plain path, or `:memory:`, means SQLite. A value written `kind://target` picks a
registered kind, and an unknown kind stops the server at start with a message that lists the known ones. `sqlite`, `postgres` and `mariadb` are
registered (`postgresql://` is an alias for `postgres`). A registration is a loader that `import()`s the adapter when its kind is chosen, so a server never loads the
driver of a kind it does not use, and `openStorage` returns a promise. Adding a database means adding its adapter and one
registration in `index.ts`, and nowhere else in the server changes. That is how `postgres` and `mariadb` were added; the test and CI steps a new kind also needs are under [Adding an adapter](#adding-an-adapter).

SQLite is only the default. `DEFAULT_STORAGE_KIND` names it, and each registration declares its own default target
(`<repo>/data/podium.sqlite` for SQLite; `postgres` and `mariadb` have none, so a `postgres://` or `mariadb://` value always names its database), so the registry and not the server knows what an install with no `PODIUM_DB`
uses. The app depends on the adapter's interface and never on a database: `neutral.test.ts` fails when a non-test file
outside `storage/sqlite/` and `storage/index.ts` names SQLite, `vacuum`, `pragma`, `rowid` or `wal`, and an option only one
database understands (`vacuumPages` is one) lives on that adapter's own options type, not on the shared ones.

Inside the adapter, `portableSql.test.ts` fails when a non-test file in `storage/sqlite/` uses `json_extract`, `json_each`,
`json_object`, `json_group_array` or the `->>` / `->` operators in a SQL string (#808), since other SQL databases spell those
differently. A compact event's trigger is read in code (`countAutoCompactions`), and the Activity history's bulk delete binds its ids in batches of 200.

Reads that run for every live session are batched (#906). `getSessions`, `getAgentsOf`, `getBlowoutsOf`, `countAutoCompactionsOf`,
`samplesSinceOf`, `groupsOfOwners` and the Activity store's `recordings.viewMany` answer for many ids in one statement each, with a key
for every id asked and each list in the order its one-session method gives; `upsertAgents` and `upsertAgentTextsMany` write a report's
agents in one statement each. PostgreSQL and MariaDB do it with an `IN (...)` list or a multi-row `INSERT` cut into pieces under the driver's limit
on bound values. SQLite runs the same `IN (...)` reads, and the order-parity check (`scripts/storage-order-parity.mjs`) holds every adapter to the same `ORDER BY`. A path that would otherwise grow
its statement count with the wall (a report, a snapshot) uses these, and `docs/PERFORMANCE.md` has the counts.

`storageSpec` splits the value into its kind and target, and the server starts through it. A bad kind fails before anything
else reads the path. The target only names the database: it labels it in the log and in the health check.

Where the server keeps its own files is a different question, answered by `dataDir`. That is `PODIUM_DATA_DIR` when it is
set, and otherwise the folder of the database file, which is what it has always been (`/data` in the container, `data/`
standalone). The TLS folder is `tls/` inside it. A kind whose target is not a file has no such folder, so for one the server
stops at start unless `PODIUM_DATA_DIR` is set (`podiumctl` sets it for `postgres` and `mariadb`). The Activity history file is the SQLite adapter's own business and sits beside
the SQLite file; on PostgreSQL the Activity history is a schema in the same database, and on MariaDB it is tables of its own in the same database.

## The lock and the transaction

This section is about SQLite; [PostgreSQL](#the-postgresql-adapter) and [MariaDB](#the-mariadb-adapter) do the same differently.

Each SQLite connection has one `AsyncLock` (`storage/lock.ts`): a queue that runs one adapter call at a time. The
main file and `activity.sqlite` are separate connections with separate locks, so a slow Activity history write does not
hold up a report, and nothing spans the two files.

`Storage.tx(fn)` runs a callback in one transaction on the main connection and holds that connection's lock for the whole
callback. It commits when the callback resolves and rolls back when it rejects. A call made inside the callback sees the lock
in its async context (`AsyncLocalStorage`) and runs straight away instead of queuing behind the transaction that is waiting
for it, so a nested `tx` joins the outer one. A nested `tx` has no savepoint of its own. `peerRights.ts` and `personCerts.ts`
use `SAVEPOINT` where they need a step they can undo alone.

## Reads that cannot wait

Some readers are synchronous: a feature flag is checked in the middle of a report, a price while a card is built, the wall's
settings while a snapshot is assembled. `fleet/liveSettings.ts` and `tlsLive.ts` hold write-through caches for those
settings. A `Live*` class loads its setting once, answers reads from memory, and writes through: the write goes to storage
first, memory changes when it has resolved, and then the change callback runs. Writes to one setting run one at a time in the
order they were asked for. This server is the only writer of those rows, which is what makes the cache safe.

`Fleet.init()` loads every cache and reads the sessions that were live. It runs before the server listens, and a test that
builds a second `Fleet` over the same storage to simulate a restart must `await fleet.init()` before it reads a setting.

## Ordering above the storage

Two things the old synchronous code got for free are now explicit.

- **`fleet/serial.ts`.** `Serializer.run(key, fn)` runs sequences for one key (a session id) one after another and lets other
  keys run alongside. `Serializer.exclusive(fn)` runs alone: after everything queued before it and before anything queued
  after. A sweep and a retention run use it, because they span sessions.
- **One broadcast queue.** `Fleet` sends every message to the consoles through one ordered queue, so messages leave in the
  order they were asked for however long each one's reads take. `await fleet.flush()` resolves when the queue, and the queued
  history writes described below, have drained. `fleet/asyncHandler.ts` hands a rejected promise from a handler to the error middleware, so it
  becomes a 500 instead of a request that never answers. Express 4 needed it; Express 5 does it on its own, and the wrapper stays
  for its types.

## Start and stop

`index.ts` opens the storage, awaits `fleet.init()` and only then listens. On a stop, the server closes its listeners,
waits for `fleet.flush()`, then calls `storage.close()`, which drains each lock and closes its file (on PostgreSQL: drains the gates, ends both pools and releases the advisory lock; on MariaDB the same, with the named lock). Messages and writes
already asked for finish before either file closes.

With built-in TLS on, `tlsBoot.ts` keeps the order of two things straight. The HTTPS listener is registered the moment it
starts serving, so a client certificate is trusted from the first connection. The plain-HTTP gate for reporters opens only
after the seed row for "allow reporters over HTTP" is stored, so a fresh install is never refused in between. The sweeper
skips a timer run while the previous one is still going, because a sweep now queues behind storage work.

## Rules for calling it

These are the rules the code now depends on. The type checker does not catch a broken one, so read them before you add a call.

1. **Await every store call.** `x ?? promise`, `!promise`, `if (promise)` and a call whose result is dropped all compile. The
   promise is truthy, so the condition is wrong, or the work runs unobserved. See
   [the gotcha](../../gotchas/a-store-call-without-await-compiles-and-answers-wrongly.md). `scripts/promise-misuse.mjs` finds these
   and `npm test` runs it over the repo; a deliberate case takes `// promise-ok: <why>` on its line or the line before.
2. **Never hold `Storage.tx` across a wait that is not storage.** A network call, OpenSSL, a timer or a stream held inside the
   callback keeps the lock, and every other request waits behind it. Do that work before or after the `tx`.
3. **A read followed by a write needs a `tx` or a `Serializer` turn.** Between two awaits another task can run, so
   "read the row, decide, write it back" over several awaits is no longer atomic by itself.
4. **A synchronous read of a setting comes from its `Live*` cache.** Do not add an async read where a card or a report is built.


## Chat's stores (#1034)

`Storage.chat({ now })` hands out `ChatStoreApi` (`types.ts`): `serverScope()`, `group` and `public` (a `ChannelStoreApi` each: `post`,
`page`, `setMention`, `clear`, `count`, `purge`), `readState` (`get`, `list`, `bump`, `markRead`, `forget`) and `settings`
(`ChatSettingsApi`: the Admin's limits and each channel's pause and disconnect flags). The group store's every call takes the group
(`owner`, `groupId`), so a member reads only their own. SQLite's is `sqlite/chat.ts`, PostgreSQL's `postgres/chat.ts`, MariaDB's `mariadb/chat.ts`, and the contract
case is `contractChat.ts`. **No method of `ChatStoreApi` reads or returns a `peer_messages` row, and none ever will**; a Direct
Message is the messaging store's (`PeerStoreApi.messages`), which gained `sendFromPerson`, `sendAcross`, `page` (a cursor read, newest
page first), `deleteConversation`, `ownerConversations`, `hideConversation`, `showConversation` and `purgeHidden`, and
`PeerStoreApi.rights` gained `personLink` and `setPersonLink` for a person's link to another person's agent. `ChatStoreApi.adminReads` (`ChatAdminReadsApi`: `touch`, `mark`, `list`, `live`, `threads`, `forget`, `purge`) keeps an Admin's readings and stops, in `sqlite/chat.ts`, `postgres/chat.ts` and `mariadb/chat.ts`. A page of a channel or a
conversation orders by `created_at, seq` (`sent_at, seq` for a conversation) in every adapter and starts strictly before its cursor.
The server's code that uses them is in `server/src/fleet/chat*.ts` ([Orchestrator messaging](13-orchestrator-messaging.md#chat-1034)),
and `server/src/fleet/chatSeparation.test.ts` fails if the channel side names the direct side's store or the reverse, or if a Chat route is not listed with the one audience it serves.

## The PostgreSQL adapter

`server/src/storage/postgres/` implements every interface in `types.ts` over the `pg` driver (#822). `openPostgresStorage` is
what the registry loads for a `postgres://` target. It is built the way the SQLite one is, store by store, and calls the same
contract.

| File | What it holds |
|---|---|
| `index.ts` | `openPostgresStorage`: takes the process lock, opens both pools, migrates both schemas, returns the `Storage` |
| `conn.ts` | `PgDb`: a pool, the transaction gate, `tx` and `savepoint`, the `?` and `:name` placeholders turned into `$n`, and `bigint` and `numeric` turned into numbers |
| `schema.ts` | `MAIN_STEPS` and `ACTIVITY_STEPS`, one baseline step each, and `migrate()` |
| `singleProcess.ts` | The advisory lock and `pgLabel`, the `host:port/dbname` label |
| `testing.ts` | `TEST_PG` and `createTestDatabase()`, a throwaway database for each test file |
| the other files | One for each SQLite store of the same name, with the SQL kept as close to the original as PostgreSQL allows |

- **Two schemas, two pools.** The fleet, people, reporters, settings and messaging tables are in the schema `podium`. The
  Activity history and the session recordings are in `podium_activity`, on a pool of their own (10 and 4 connections), so a
  slow history write does not hold up a report. Each pool sets its `search_path`, so the SQL names its tables bare. Nothing
  references across the two schemas, as nothing references across the two SQLite files.
- **Migrations.** Each schema has a `schema_migrations` table, and a step is applied in a transaction of its own. The baseline
  is one step equal to the end state of SQLite's 25 migrations. A later change adds a step with the next number.
  SQLite has 42 numbered migrations, and the `podium` PostgreSQL and MariaDB schemas have steps 1 to 18, migrations 35 to 42 being steps 11 to 18 (35 is step 11, 36 is step 12 for the resume window, 37 to 42 are steps 13 to 18 for the daily rollups). Chat (#1034) added four, each mirrored by a PostgreSQL main step in the same PR: migration 31 is
  step 7 (`author` and `hidden_at` on `peer_messages`, the tables `group_messages`, `public_messages` and `chat_read_state`) and
  migration 32 is step 8 (`peer_rights.paused_by`), migration 33 is step 9 (`peer_rights.paused_by_admin` and the table `chat_admin_reads`, an Admin's readings) and migration 34 is step 10 (`chat_admin_reads.kind`, which tells a reading from an Admin's pause, resume, disconnect, reconnect or remove all). The columns and indexes are the same in both ([SPEC 7.2](../../spec/07-server/07-02-database.md#what-chat-keeps-and-where-1034)),
  and `adapters.test.ts` fails if one has what the other lacks. An existing `peer_messages` row migrates as an agent's message
  (`author` defaults to `agent`), and `contractUpgrade.ts` has an upgrade case for it in each adapter.
  A migration that rewrites rows is covered by `contractUpgrade.ts` (#892): each adapter builds a database at the schema before it
  (`sqlite/upgradeTesting.ts`, `postgres/upgradeTesting.ts`), loads the same rows, and the case reads them back through `Storage`. The seeders can also link a seeded reporter to sessions, which is how a case builds a key the stores never write themselves, such as one with its prefix in another case (#943).
- **Text.** Every text column is `COLLATE "C"`, so bytes compare as they do in SQLite, whatever locale the database was made
  with. `podium_lower(x)` folds ASCII only, like SQLite's `lower()`, and the stores use it where the SQLite stores use `lower()`.
- **Values.** `PgDb` converts `bigint` and `numeric` to numbers, and throws if a whole number would lose digits. Flags stay
  0/1 columns, and the stores turn them into booleans where the SQLite stores do.
- **The transaction.** `tx` takes a client from the pool for the whole callback and takes transactions one at a time through a
  gate, and a statement made outside a transaction takes its turn at the same gate, so a call from another task waits while a
  transaction is open and a read then a write inside one is a single step, as the SQLite lock made it (#1007). Calls
  outside a transaction therefore run one at a time, as they do on SQLite. A call made inside the callback, or a nested `tx`,
  joins the open transaction through the async context, which also means a call started inside the callback and left
  running joins it and must finish before it ends. `savepoint` is used for the steps `peerRights` and `personCerts` can undo alone.
- **One process.** At start, a client of its own takes `pg_try_advisory_lock`. If another Podium holds it, the server stops with
  a message naming the database (host, port and name) and exits non-zero. It is released at `close`, or when the connection
  ends.
- **Maintenance.** There is no `VACUUM` or checkpoint. Autovacuum owns the space, so the Activity history's compaction does
  nothing and frees 0 bytes.
- **Order.** A query that could tie ends on `seq` or `id`. SQLite's migration 25 adds the `seq` columns the two `rowid`
  orderings need, so both adapters answer the same. A list that a caller can see states its order in both adapters, and neither leaves it to the table's storage order (#890):
  open peer requests end on `seq`, an insertion number (SQLite migration 26, PostgreSQL step 2) that a generated `id` cannot give, which a request made after the upgrade gets as `MAX(seq) + 1` in both adapters. A request that already existed at the upgrade has no recorded insertion order in PostgreSQL, so both adapters number those by `created_at` and then `id`, and two of them that tie list the same in each (#916; SQLite migration 26 was changed to match, which does not touch a database that already ran it), `clearedInto` on `id` after the start time,
  and the spend queries, the reporter keys, the reporter versions seen, the rollup days and each rollup table's rows end on a key.
- **NaN and NUL (#1007).** Both adapters store a NaN as NULL (SQLite does so itself; PostgreSQL's `bound()` in `conn.ts` converts it) and
  remove a NUL from text where they bind a value (`sqlite/bind.ts` and `bound()`), so the stored data is the same. The report
  validator and the Admin routes already refuse both, so this changes nothing a person can send. One divergence is accepted and
  stays in PostgreSQL's `known` list: a fraction, an infinity or a number of 1e21 or more sent to an integer column or compared
  with one makes PostgreSQL throw where SQLite accepts it. The HTTP edge refuses those numbers; the store has no typed validation.
- **No password in the open.** The label in the log and in `/health` is `host:port/dbname`.
- **Version.** PostgreSQL 17 is the version supported and the one tested: CI (`Test with PostgreSQL`, and Sonar's coverage run) uses
  `postgres:17`, `scripts/test-db.sh` the same, and the end-to-end suite `postgres:17-alpine`. Other versions are untested.

The PostgreSQL tests need `PODIUM_TEST_PG` to name a server, and the MariaDB tests `PODIUM_TEST_MARIADB` ([CONTRIBUTING](../../../CONTRIBUTING.md)). A run without one fails and names the adapter, because a run that leaves one out is not a pass; `PODIUM_TEST_ONLY=<kinds>` leaves the others out on purpose and the run prints which were NOT RUN, which is not a pass for a pull request (`scripts/test-db.sh` runs every adapter, with a throwaway container for each one that needs a server). A run with a variable and no server fails too (`server/src/storage/serverGate.ts`, `postgres/gate.ts`, `mariadb/gate.ts`). CI runs them in the `test-postgres` job (`Test with PostgreSQL`, on PostgreSQL 17) and in the `test-mariadb` job (`Test with MariaDB 11.4`, on MariaDB 11.4), one version each. The "Protect development and main" ruleset requires `Test with PostgreSQL` and `Test with MariaDB 11.4`; the "Release checks on main" ruleset requires `E2E summary`, which fails when the release PR's end-to-end job, a run on every database in `e2e.yml`'s list, fails or is skipped.

**One failure, all adapters (#1008).** A failure of the contract or the differential test on any adapter fails the whole run and names the adapter. The fix makes the case pass on every adapter. A case is never skipped or loosened for one adapter; a difference that is not a defect is a listed exception in `contractSame.ts`, and a defect another issue owns is in that adapter's `known` list with the issue that fixes it (reported as a warning, a failure with `PODIUM_DIFF_STRICT=1`, and a failure once the case passes, so the entry has to go). A new adapter needs more than its folder and its registration; [Adding an adapter](#adding-an-adapter) lists every step, and the guards that fail when one is missing.

## The MariaDB adapter

`server/src/storage/mariadb/` implements every interface in `types.ts` over the official `mariadb` driver (#823).
`openMariaDbStorage` is what the registry loads for a `mariadb://` target. It is built store by store from the PostgreSQL
adapter, with the SQL changed where MariaDB needs it, and passes the same contract. How to run it is in
[Using MariaDB](../../SERVER.md#using-mariadb).

| File | What it holds |
|---|---|
| `index.ts` | `openMariaDbStorage`: takes the process lock, opens both pools, migrates both sets of tables, returns the `Storage`. A start that fails at any step after the lock, and a close whose first step fails, still close every pool and release the lock |
| `conn.ts` | `MariaDbConn`: a pool, the transaction gate, `tx` and `savepoint`, the `:name` placeholders turned into `?`, the reserved column names (`key`, `loop`, `by`) quoted where they are names (not in `ORDER BY`, `PRIMARY KEY` and the like, and never inside quotes, read as the session's SQL mode reads them), the session settings, `bound()`, `bigint` and `DECIMAL` turned into numbers, `asciiLower`, and `parseTarget` for the URL |
| `schema.ts` | `MAIN_STEPS` and `ACTIVITY_STEPS`, numbered as PostgreSQL's steps, and `migrate()` |
| `singleProcess.ts` | The named lock on a connection of its own, taken again if that connection drops |
| `testing.ts`, `gate.ts`, `globalSetup.ts` | `TEST_MARIADB` and `createTestDatabase()`, a throwaway database for each test file, and the gate that fails the run when `PODIUM_TEST_MARIADB` is set and no server answers |
| `contractAdapter.ts`, `upgradeTesting.ts` | The adapter as the storage tests see it, and a database built at the oldest step for the upgrade cases |
| `upserts.test.ts` | Every `ON DUPLICATE KEY UPDATE` and every insert guarded by `NOT EXISTS` in the adapter, checked against its table's keys, and the guard that refuses an `INSERT IGNORE` |
| the other files | One for each store of the same name in the other adapters |

- **One database, two sets of tables, two pools.** The fleet, people, reporters, settings and messaging tables and the
  Activity history and recordings (`entries`, `stored_sessions`, `loops`, `rec_sessions`, `rec_entries`) share one database
  under their plain names, which do not overlap. The two sets are on pools of their own (10 and 4 connections) and each has its own
  record of steps, `schema_migrations` and `activity_schema_migrations`, so a slow history write does not hold up a report, as
  with the two SQLite files and the two PostgreSQL schemas. Nothing references across the two sets.
- **Migrations.** The steps are PostgreSQL's, one for one: main step 1 is the baseline, and each later step has the same number
  and makes the same change, so "PostgreSQL main step N" in [SPEC 7.2](../../spec/07-server/07-02-database.md) is MariaDB main step N too.
  MariaDB commits each DDL statement on its own, so a step is not a transaction. Every statement is written to be run twice
  (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, an insert that skips a row that is there), and `migrate()` records a step after its
  last statement, so a runner stopped part way through runs the whole step again and ends in the same state. A test stops the runner
  between statements (`schema.ts` takes a hook for it) and starts it again. `migrate()` also runs `ALTER DATABASE` to the
  character set and collation below at every start.
- **Text.** Every text column, the database's default and every connection are `utf8mb4` under `utf8mb4_nopad_bin`, so bytes
  compare as they are, a trailing space counts, and `Ed` and `ed` compare as SQLite compares them. A text column that is a key or in
  an index is a `VARCHAR` with a length (ids 255, reporter keys 383, the link 760, the rollup key parts 32 to 255, a model 191),
  because an index key holds at most 3072 bytes; the others are `LONGTEXT`. The connection runs in strict mode, so a longer value
  is an error, never cut. `asciiLower(x)` folds ASCII letters only, with one `REPLACE` per letter, where the SQLite stores use
  `lower()`: MariaDB's `LOWER()` would also fold `É`.
- **SQL mode.** Each connection sets `STRICT_ALL_TABLES`, `ANSI_QUOTES` (so `"x"` is a name, as in the other adapters' SQL),
  `PIPES_AS_CONCAT` and `NO_ENGINE_SUBSTITUTION`, and `READ COMMITTED`, which is what the PostgreSQL adapter runs at.
- **Upserts.** `ON CONFLICT (...) DO UPDATE` is `ON DUPLICATE KEY UPDATE`. `INSERT OR IGNORE` and `ON CONFLICT DO NOTHING` are
  `ON DUPLICATE KEY UPDATE <column> = <column>`, which changes nothing on a duplicate, or, for `insertEvent`, which answers whether
  the row was new, `INSERT ... SELECT ... WHERE NOT EXISTS` on the event's id. MariaDB's `INSERT IGNORE` is not used: it would also
  turn a value too long for its column, a NULL into a NOT NULL column and a missing parent row into warnings, and store a cut value
  or nothing with no error. `ON DUPLICATE KEY` does not name the key it conflicts on, so on a table with two unique keys it could change
  the wrong row. `upserts.test.ts` reads every such statement in the adapter and fails unless exactly one unique key of its table
  can conflict (for a `NOT EXISTS` guard, unless it compares exactly one unique key), fails on any `INSERT IGNORE`, and runs the
  statements beside a neighbor that shares part of the key, and with a value too long for its key column, which must be refused.
- **A write that reads its own table.** MariaDB takes neither a `LIMIT` inside `IN (...)` nor a subquery on the table a `DELETE`
  or `UPDATE` changes. Those statements read through a derived table (`person_machines`' trim, step 2's numbering of
  `peer_requests`) or limit the `DELETE` itself (`DELETE ... ORDER BY ... LIMIT ... RETURNING` for a chunk of recordings).
- **Values.** The driver hands a `BIGINT` back as a `bigint` and a `DECIMAL` (a `SUM`, an `AVG`) as text; `MariaDbConn` turns
  both into numbers and throws if a whole number would lose digits. Flags are 0/1 columns, as in the other adapters.
- **The transaction.** As on PostgreSQL: `tx` takes a connection from the pool for the whole callback, transactions and every
  statement made outside one take turns at one gate (#1007), a nested `tx` joins the open one through the async context, and
  `savepoint` is used where `peerRights` and `personCerts` undo a step alone. MariaDB keeps a savepoint after a rollback to it, so
  it is released too. A transaction that fails is rolled back and its connection goes back to the pool; only an error the driver
  marks fatal (a lost or killed connection) destroys it instead. Unlike PostgreSQL, and as on SQLite, a failed statement undoes only
  itself and the transaction goes on.
- **One process.** At start, a connection of its own, kept outside the pools, takes `GET_LOCK('podium:<hash>', 0)`, where the hash
  is of the database name (a lock name is per server and at most 64 characters). If another Podium holds it, the server stops with a
  message naming `host:port/dbname`. If the connection drops, the lock is taken again on a new one (5 tries, 500 ms apart); when that
  fails or another server has it, every store call rejects and the server stops. The lock is released at `close`.
- **Maintenance.** There is no `OPTIMIZE TABLE`: InnoDB reuses the space of removed rows, and rebuilding a table would lock it.
  The Activity history's compaction does nothing and frees 0 bytes.
- **NaN, NUL and surrogates.** `bound()` in `conn.ts` stores a NaN as NULL and removes a NUL from text, as the other adapters do,
  and turns a lone surrogate into U+FFFD, which is what the other two hand back for it. An infinity is refused there with a plain
  message, since MariaDB has no literal for it.
- **The one known divergence.** A fraction sent to an integer column is rounded by MariaDB half away from zero and stored with no
  error (1.5 as 2, -2.5 as -3), where SQLite stores it as it is and PostgreSQL throws; a number of 1e21 or more is refused. It is
  in MariaDB's `known` list under #823, as the same input is on PostgreSQL's. The report validator and the routes refuse these
  numbers before any store is called, so it is not reachable over HTTP.
- **No password in the open.** The label in the log, in `/health` and in the lock's messages is `host:port/dbname`, and the driver
  is told not to put bound values in an error.
- **Version.** Podium supports MariaDB 11.x and tests one version, 11.4, the long-term release: CI (`Test with MariaDB 11.4`, and
  Sonar's coverage run) uses `mariadb:11.4`, `scripts/test-db.sh` the same, and the end-to-end suite `mariadb:11.4.13`. Other
  versions are untested. The SQL needs `RETURNING` and `ADD COLUMN IF NOT EXISTS`, which MariaDB 10.5 also has, but nothing older
  than 11.4 is run. The adapter does not check the server's version at start. MySQL is not supported.

## Adding an adapter

A database is one folder and one registration in the server, as above. The tests and the tooling around them need more, and each
step has a guard that fails when it is missing.

| Step | Where | What fails without it |
|---|---|---|
| The adapter: every interface in `types.ts`, its schema and migrations, `contractAdapter.ts` with its `known` list, `testing.ts`, and a `gate.ts` and `globalSetup.ts` for its test server | `server/src/storage/<kind>/` | The compiler, and `adapters.test.ts` for a method with no case or a table, column or index the others do not have |
| The registration, with its `testing` entry and its `label` | `server/src/storage/index.ts` | `adapters.test.ts` and `scripts/db-adapters.test.ts` |
| Its folder in `ADAPTERS` and its driver's names | `server/src/storage/neutral.test.ts` | The same test: an unlisted folder is read as app code, which may not name a database |
| Its folder in the lists of adapter folders these tests skip or read: the Admin read registry's scan, and the Chat separation check | `server/src/fleet/adminReads.test.ts`, `server/src/storage/separation.test.ts` | `adminReads.test.ts` reads the adapter's store methods as unregistered Admin reads; `separation.test.ts` does not check the new adapter's `chat.ts` |
| Its `globalSetup.ts` | `globalSetup` in `server/vitest.config.ts` | Nothing directly: with the variable set and no server answering, the run then fails test by test instead of once (`postgres/globalSetup.ts` also runs the "not set" check for every registered adapter) |
| Its kind, scheme, test server variable, its test and end-to-end images (one tested version), port, readiness and reset commands | `DB_ADAPTERS` in `scripts/db-adapters.mjs`, which `scripts/test-db.sh` and `scripts/e2e-up.sh` read | `scripts/db-adapters.test.ts` |
| Where its NULLs sort, and whether it has `NULLS FIRST` and `NULLS LAST` | `DIALECTS` in `scripts/storage-order-parity.mjs` | The script, in `npm test` |
| How to make and drop a throwaway database on its server | `SERVERS` in `scripts/throwaway-db.mjs` | `scripts/throwaway-db.test.ts` |
| A job that sets its test server variable, on the version its entry names, with `PODIUM_TEST_ONLY: sqlite,<kind>` | `.github/workflows/ci.yml` | `adapters.test.ts` and `scripts/db-adapters.test.ts` |
| Its service in the `coverage` job | `.github/workflows/sonar.yml` | `scripts/db-adapters.test.ts` |
| Its kind in the `DATABASES` default and in the `case` that checks the list | `.github/workflows/e2e.yml` | `adapters.test.ts` and `scripts/db-adapters.test.ts` for the default; nothing for the `case`, which then refuses the kind at run time |
| Its folder in `sonar.cpd.exclusions`, since it mirrors the SQLite adapter by design | `sonar-project.properties` | Nothing; SonarCloud reports it as duplicated |
| The new CI check names, for the maintainer to add to the "Protect development and main" ruleset | The PR body | Nothing: only the maintainer edits the ruleset |
| A URL form, the version tested and the limits for whoever runs it, and the adapter's section on this page | `docs/SERVER.md`, this page, `docs/atlas/` | `node scripts/atlas-functions.mjs --check` for a file the atlas names |

## What is not shared between processes

Open asks, sign-ins and lockouts stay in one process's memory, as they were. The storage layer does not move them, and two
server processes on one database would not see each other's. Podium is still one process per database. On PostgreSQL the
advisory lock enforces it and on MariaDB the named lock: a second server on the same database refuses to start. There is no data
migration from a SQLite file, and no read replica or high availability.

## Small timing differences

Behavior is meant to be unchanged. A differential run of the old and new builds over the same data
(`scripts/podium-golden.mjs capture` and `diff`) found no difference. These small differences in timing are known.

- A history write for Podium's own entry is queued behind earlier ones. A test that checks the history right after the action
  awaits `fleet.flush()` first.
- The log lines for a respond or recording event are written a few ticks after the action, once the session's name has been
  read.
- A request answered 401 or 403 waits for its `reporters.rejected` write, and so waits behind a transaction that is open.
- After recording is switched off, the stop marks are written a moment later. The setting is already off in memory, so nothing
  more is accepted from that moment.

## Next

- [Other server parts](18-other-server-parts.md) lists the smaller parts that sit on top of these stores.

<!-- nav:start -->
---

Previous: [Other server parts](18-other-server-parts.md) · Up: [Components](README.md)
<!-- nav:end -->
