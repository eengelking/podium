---
title: "Storage"
description: "How the server reaches its database: async interfaces, the SQLite and PostgreSQL adapters, the locks, the write-through caches and the rules for calling it."
group: "Project internals"
order: 19
---

# Storage

This page covers how the server reads and writes its data, one part of [the components](README.md). It is for a contributor
who is about to call a store, add one or change what sits under it. Nothing here changes what the console shows. The
tables and their migrations are in [SPEC 7.2](../../spec/07-server/07-02-database.md), and the reason for the shape is in
[DECISIONS 48](../../decisions/48-storage-sits-behind-async-interfaces-with-sqlite-as-the-only-adapter.md). The PostgreSQL adapter
is [DECISIONS 53](../../decisions/53-postgresql-is-the-second-storage-adapter-on-the-pg-driver-with-one-process-per.md).

Contents:

- [The layers](#the-layers)
- [Choosing the implementation](#choosing-the-implementation)
- [The lock and the transaction](#the-lock-and-the-transaction)
- [Reads that cannot wait](#reads-that-cannot-wait)
- [Ordering above the storage](#ordering-above-the-storage)
- [Start and stop](#start-and-stop)
- [Rules for calling it](#rules-for-calling-it)
- [The PostgreSQL adapter](#the-postgresql-adapter)
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
| `contract.ts` | The checks a store must pass, run against each adapter: the same results as the synchronous stores, the type of every field of the main rows, how names compare, and the order lists come back in |
| `contractSame.ts`, `contractSettings.ts`, `contractFleet.ts`, `contractPeers.ts`, `contractActivity.ts`, `contractReports.ts` | The rest of the contract (#890): one case for every other store, each running a scenario over the adapter and over a second SQLite storage and comparing every value it records (results, thrown messages, list order with ties). Generated ids and the size of the database file are compared by type only |
| `reportQueries.ts` | The fleet-wide reporting queries behind Admin > Reporting |

Nothing in those files imports `storage/sqlite/` or `node:sqlite`, except `index.ts`; neither adapter imports the other (`neutral.test.ts` checks that too: what they share lives in these files); `neutral.test.ts` fails if one does, and if any file outside the adapter that is not a test reaches for `sqliteHandle` or
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
`pg`, and `neutral.test.ts` fails if a file outside it does.

Every method on a store returns a promise. `Fleet`, the routers and the sweeper take a `Storage` and call it. Tests open
`openSqliteStorage(':memory:')`.

## Choosing the implementation

`openStorage` reads `PODIUM_DB`. A plain path, or `:memory:`, means SQLite. A value written `kind://target` picks a
registered kind, and an unknown kind stops the server at start with a message that lists the known ones. `sqlite` and `postgres` are
registered (`postgresql://` is an alias for `postgres`). A registration is a loader that `import()`s the adapter when its kind is chosen, so a server never loads the
driver of a kind it does not use, and `openStorage` returns a promise. Adding a database means adding its adapter and one
registration in `index.ts`, and nowhere else in the server changes. That is how `postgres` was added.

SQLite is only the default. `DEFAULT_STORAGE_KIND` names it, and each registration declares its own default target
(`<repo>/data/podium.sqlite` for SQLite; `postgres` has none, so a `postgres://` value always names its database), so the registry and not the server knows what an install with no `PODIUM_DB`
uses. The app depends on the adapter's interface and never on a database: `neutral.test.ts` fails when a non-test file
outside `storage/sqlite/` and `storage/index.ts` names SQLite, `vacuum`, `pragma`, `rowid` or `wal`, and an option only one
database understands (`vacuumPages` is one) lives on that adapter's own options type, not on the shared ones.

Inside the adapter, `portableSql.test.ts` fails when a non-test file in `storage/sqlite/` uses `json_extract`, `json_each`,
`json_object`, `json_group_array` or the `->>` / `->` operators in a SQL string (#808), since other SQL databases spell those
differently. A compact event's trigger is read in code (`countAutoCompactions`), and the Activity history's bulk delete binds its ids in batches of 200.

Reads that run for every live session are batched (#906). `getSessions`, `getAgentsOf`, `getBlowoutsOf`, `countAutoCompactionsOf`,
`samplesSinceOf`, `groupsOfOwners` and the Activity store's `recordings.viewMany` answer for many ids in one statement each, with a key
for every id asked and each list in the order its one-session method gives; `upsertAgents` and `upsertAgentTextsMany` write a report's
agents in one statement each. PostgreSQL does it with an `IN (...)` list or a multi-row `INSERT` cut into pieces under the driver's limit
on bound values. SQLite loops over the one-at-a-time method, since a statement costs it microseconds. A path that would otherwise grow
its statement count with the wall (a report, a snapshot) uses these, and `docs/PERFORMANCE.md` has the counts.

`storageSpec` splits the value into its kind and target, and the server starts through it. A bad kind fails before anything
else reads the path. The target only names the database: it labels it in the log and in the health check.

Where the server keeps its own files is a different question, answered by `dataDir`. That is `PODIUM_DATA_DIR` when it is
set, and otherwise the folder of the database file, which is what it has always been (`/data` in the container, `data/`
standalone). The TLS folder is `tls/` inside it. A kind whose target is not a file has no such folder, so for one the server
stops at start unless `PODIUM_DATA_DIR` is set (`podiumctl` sets it for `postgres`). The Activity history file is the SQLite adapter's own business and sits beside
the SQLite file; on PostgreSQL the Activity history is a schema in the same database.

## The lock and the transaction

This section is about SQLite; [PostgreSQL does the same differently](#the-postgresql-adapter).

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
waits for `fleet.flush()`, then calls `storage.close()`, which drains each lock and closes its file (on PostgreSQL: drains the gates, ends both pools and releases the advisory lock). Messages and writes
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
  A migration that rewrites rows is covered by `contractUpgrade.ts` (#892): each adapter builds a database at the schema before it
  (`sqlite/upgradeTesting.ts`, `postgres/upgradeTesting.ts`), loads the same rows, and the case reads them back through `Storage`.
- **Text.** Every text column is `COLLATE "C"`, so bytes compare as they do in SQLite, whatever locale the database was made
  with. `podium_lower(x)` folds ASCII only, like SQLite's `lower()`, and the stores use it where the SQLite stores use `lower()`.
- **Values.** `PgDb` converts `bigint` and `numeric` to numbers, and throws if a whole number would lose digits. Flags stay
  0/1 columns, and the stores turn them into booleans where the SQLite stores do.
- **The transaction.** `tx` takes a client from the pool for the whole callback and takes transactions one at a time through a
  gate, so a read then a write inside one is a single step, as the SQLite lock made it. A nested `tx` joins the open one
  through the async context. `savepoint` is used for the steps `peerRights` and `personCerts` can undo alone.
- **One process.** At start, a client of its own takes `pg_try_advisory_lock`. If another Podium holds it, the server stops with
  a message naming the database (host, port and name) and exits non-zero. It is released at `close`, or when the connection
  ends.
- **Maintenance.** There is no `VACUUM` or checkpoint. Autovacuum owns the space, so the Activity history's compaction does
  nothing and frees 0 bytes.
- **Order.** A query that could tie ends on `seq` or `id`. SQLite's migration 25 adds the `seq` columns the two `rowid`
  orderings need, so both adapters answer the same. A list that a caller can see states its order in both adapters, and neither leaves it to the table's storage order (#890):
  open peer requests end on `seq`, an insertion number (SQLite migration 26, PostgreSQL step 2) that a generated `id` cannot give, which a request made after the upgrade gets as `MAX(seq) + 1` in both adapters. A request that already existed at the upgrade has no recorded insertion order in PostgreSQL, so both adapters number those by `created_at` and then `id`, and two of them that tie list the same in each (#916; SQLite migration 26 was changed to match, which does not touch a database that already ran it), `clearedInto` on `id` after the start time,
  and the spend queries, the reporter keys, the reporter versions seen, the rollup days and each rollup table's rows end on a key.
- **No password in the open.** The label in the log and in `/health` is `host:port/dbname`.

The PostgreSQL tests are skipped unless `PODIUM_TEST_PG` names a server ([CONTRIBUTING](../../../CONTRIBUTING.md)); a run without it prints the skip, and a run with it and no server fails (`server/src/storage/postgres/gate.ts`). CI runs them
in the `test-postgres` job.

## What is not shared between processes

Open asks, sign-ins and lockouts stay in one process's memory, as they were. The storage layer does not move them, and two
server processes on one database would not see each other's. Podium is still one process per database. On PostgreSQL the
advisory lock enforces it: a second server on the same database refuses to start. There is no data migration from a SQLite
file, and no read replica or high availability.

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
