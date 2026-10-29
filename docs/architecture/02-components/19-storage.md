---
title: "Storage"
description: "How the server reaches its database: async interfaces, SQLite as the only adapter, the locks, the write-through caches and the rules for calling it."
group: "Project internals"
order: 19
---

# Storage

This page covers how the server reads and writes its data, one part of [the components](README.md). It is for a contributor
who is about to call a store, add one or change what sits under it. Nothing here changes what the console shows. The
tables and their migrations are in [SPEC 7.2](../../spec/07-server/07-02-database.md), and the reason for the shape is in
[DECISIONS 48](../../decisions/48-storage-sits-behind-async-interfaces-with-sqlite-as-the-only-adapter.md).

Contents:

- [The layers](#the-layers)
- [Choosing the implementation](#choosing-the-implementation)
- [The lock and the transaction](#the-lock-and-the-transaction)
- [Reads that cannot wait](#reads-that-cannot-wait)
- [Ordering above the storage](#ordering-above-the-storage)
- [Start and stop](#start-and-stop)
- [Rules for calling it](#rules-for-calling-it)
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
| `contract.ts` | The checks a store must pass, run against each adapter: the same results as the synchronous stores, the type of every field of the main rows, how names compare, and the order lists come back in |
| `reportQueries.ts` | The fleet-wide reporting queries behind Admin > Reporting |

Nothing in those files imports `storage/sqlite/` or `node:sqlite`, except `index.ts`; `neutral.test.ts` fails if one does, and if any file outside the adapter that is not a test reaches for `sqliteHandle` or
`activityHandle`; the shared test builders that need raw SQL (`rollupFixtures.ts`) live in `storage/sqlite/`.
The adapter imports from them, never the other way round, and its `openSqliteStorage` is typed against the interfaces in
`types.ts`, so a signature that drifts is a compile error there.

`server/src/storage/sqlite/` is the only adapter. `index.ts` there (`openSqliteStorage`) builds it, `peers.ts` and
`activity.ts` wrap the messaging and Activity history services, and `lock.ts` holds the lock. The rest of the folder is the
synchronous SQLite classes the adapter wraps: `db.ts` (schema, migrations, the fleet queries), `people.ts`, `reporters.ts`,
`peerService.ts`, `peerRights.ts`, `peerMessages.ts`, `peerSettings.ts`, `featureFlags.ts`, `wallSettings.ts`,
`modelPrices.ts`, `recordingSettings.ts`, `activityHistorySettings.ts`, `activityDb.ts`, `activityHistory.ts`,
`recordings.ts`, `personCerts.ts` and `tlsSettings.ts`. They still use `node:sqlite` directly. Nothing outside
`storage/` imports them, apart from tests.

Every method on a store returns a promise. `Fleet`, the routers and the sweeper take a `Storage` and call it. Tests open
`openSqliteStorage(':memory:')`.

## Choosing the implementation

`openStorage` reads `PODIUM_DB`. A plain path, or `:memory:`, means SQLite. A value written `kind://target` picks a
registered kind, and an unknown kind stops the server at start with a message that lists the known ones. Only `sqlite` is
registered. A registration is a loader that `import()`s the adapter when its kind is chosen, so a server never loads the
driver of a kind it does not use, and `openStorage` returns a promise. Adding a database means adding its adapter and one
registration in `index.ts`, and nowhere else in the server changes. This issue adds no second database.

SQLite is only the default. `DEFAULT_STORAGE_KIND` names it, and each registration declares its own default target
(`<repo>/data/podium.sqlite` for SQLite), so the registry and not the server knows what an install with no `PODIUM_DB`
uses. The app depends on the adapter's interface and never on a database: `neutral.test.ts` fails when a non-test file
outside `storage/sqlite/` and `storage/index.ts` names SQLite, `vacuum`, `pragma`, `rowid` or `wal`, and an option only one
database understands (`vacuumPages` is one) lives on that adapter's own options type, not on the shared ones.

`storageSpec` splits the value into its kind and target, and the server starts through it. A bad kind fails before anything
else reads the path. The target only names the database: it labels it in the log and in the health check.

Where the server keeps its own files is a different question, answered by `dataDir`. That is `PODIUM_DATA_DIR` when it is
set, and otherwise the folder of the database file, which is what it has always been (`/data` in the container, `data/`
standalone). The TLS folder is `tls/` inside it. A kind whose target is not a file has no such folder, so for one the server
stops at start unless `PODIUM_DATA_DIR` is set. The Activity history file is the SQLite adapter's own business and sits beside
the SQLite file.

## The lock and the transaction

Each SQLite connection has one `AsyncLock` (`storage/sqlite/lock.ts`): a queue that runs one adapter call at a time. The
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
  history writes described below, have drained. `fleet/asyncHandler.ts` wraps an Express 4 handler so a rejected promise
  becomes a 500 instead of a request that never answers.

## Start and stop

`index.ts` opens the storage, awaits `fleet.init()` and only then listens. On a stop, the server closes its listeners,
waits for `fleet.flush()`, then calls `storage.close()`, which drains each lock and closes its file. Messages and writes
already asked for finish before either file closes.

With built-in TLS on, `tlsBoot.ts` keeps the order of two things straight. The HTTPS listener is registered the moment it
starts serving, so a client certificate is trusted from the first connection. The plain-HTTP gate for reporters opens only
after the seed row for "allow reporters over HTTP" is stored, so a fresh install is never refused in between. The sweeper
skips a timer run while the previous one is still going, because a sweep now queues behind storage work.

## Rules for calling it

These are the rules the code now depends on. The type checker does not catch a broken one, so read them before you add a call.

1. **Await every store call.** `x ?? promise`, `!promise`, `if (promise)` and a call whose result is dropped all compile. The
   promise is truthy, so the condition is wrong, or the work runs unobserved. See
   [the gotcha](../../gotchas/a-store-call-without-await-compiles-and-answers-wrongly.md).
2. **Never hold `Storage.tx` across a wait that is not storage.** A network call, OpenSSL, a timer or a stream held inside the
   callback keeps the lock, and every other request waits behind it. Do that work before or after the `tx`.
3. **A read followed by a write needs a `tx` or a `Serializer` turn.** Between two awaits another task can run, so
   "read the row, decide, write it back" over several awaits is no longer atomic by itself.
4. **A synchronous read of a setting comes from its `Live*` cache.** Do not add an async read where a card or a report is built.

## What is not shared between processes

Open asks, sign-ins and lockouts stay in one process's memory, as they were. The storage layer does not move them, and two
server processes on one database would not see each other's. Podium is still one process per database.

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
