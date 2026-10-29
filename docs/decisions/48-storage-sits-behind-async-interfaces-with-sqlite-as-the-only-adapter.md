---
title: "48. Storage sits behind async interfaces, SQLite is the only adapter and stays the default (#313)"
description: "The server reaches its data through async interfaces with one SQLite adapter, so a database can be replaced later; the cost is that every call is awaited."
group: "Project internals"
number: 48
date: "2026-10-28"
status: "accepted"
order: 48
---

# 48. Storage sits behind async interfaces, SQLite is the only adapter and stays the default (#313)

**Context.** The server called `node:sqlite` classes directly, and every call was synchronous. That ties the server to one
database and to one kind of call: a different database would need every caller to change at once. [Decision 4](04-sqlite-through-node-sqlite-validation-by-hand.md)
chose SQLite and still stands. This decision adds a seam in front of it and does not replace it. It is groundwork for #314,
which only researches Postgres and MariaDB.

**Decision.** The server depends on a `Storage` interface and async store interfaces (`server/src/storage/types.ts`). SQLite
is the only adapter, and `PODIUM_DB` with a path or `:memory:` still means a SQLite file, so the default is unchanged.
`openStorage` is the one place that chooses an implementation. No second database is added.

- Each SQLite connection has one lock, and `Storage.tx` runs a callback in a transaction that holds it.
- The Activity history file has its own connection and lock.
- The interfaces in `types.ts` are written out method by method, and nothing in `storage/` outside `sqlite/` and `index.ts` imports the adapter, so a second database implements them without reading SQLite's classes. A test enforces it.
- Synchronous readers use write-through caches loaded at start.
- Per-session sequences run in a `Serializer`, and broadcasts go through one ordered queue.

**Why.**

- A second database becomes an adapter and a registration, not a rewrite of every caller.
- Callers no longer see SQLite's types, so they cannot depend on its synchronous behavior by accident.
- It keeps the behavior. A differential run of the old and new builds over the same data showed no difference.

**Alternatives.**

- Keep the synchronous classes and add a second database next to them. Every caller would branch on the database.
- Add a query layer over both databases. A larger dependency than this needs while only one database is supported.

**Cost.**

- Every store call is a promise and must be awaited. A missed `await` compiles ([the gotcha](../gotchas/a-store-call-without-await-compiles-and-answers-wrongly.md)).
- A read then a write across awaits is no longer atomic, so it needs a `tx` or a `Serializer` turn.
- A few writes land a few ticks later than before ([Storage](../architecture/02-components/19-storage.md#small-timing-differences)).
- Open asks, sign-ins and lockouts still live in one process's memory.
- Nothing is proven for another database until one exists. #314 decides whether that is worth doing.

<!-- nav:start -->
---

Previous: [47. Load every changed file's diff while the page is open, in the browser only (#631)](47-load-every-diff-while-the-page-is-open-in-the.md) · Up: [Decisions](README.md)
<!-- nav:end -->
