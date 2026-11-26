---
title: "81. Memory search is an in-process index behind an interface, fed from Storage and checked against it"
description: "The brain's search runs from an index in the server process, rebuilt from Storage and updated on every write, and every result is re-checked through Storage."
group: "Project internals"
number: 81
date: "2026-11-25"
status: "proposed"
order: 81
---

# 81. Memory search is an in-process index behind an interface, fed from Storage and checked against it

*Builds on 79 and 48. Relies on 53 (one server per database). The rules are in SPEC 13.4.*

## Context

The brain has to find memories fast and answer the same on SQLite, PostgreSQL and MariaDB. Each database has its own full-text search
and ranks differently, so the contract could not hold them to one answer. The first draft used a table of terms in every adapter,
which gives the same answer but is the largest table in the database, writes about a thousand rows for a long memory inside the
one-at-a-time transaction gate, and ranks by counting matched words, so a memory stuffed with words wins. The maintainer asked for a search
that is the same on every database and fast, and was open to an index outside the database that is filled from it, such as a
small search server. An adversarial review compared three options.

## Decision

- **Search is served by an index inside the server process, behind an interface (`MemoryIndex`).** The database stays the only durable
  store. The index is built from `Storage` at start, is updated in the request that wrote (after the commit, before the reply), and is checked
  against the store every 10 minutes.
- **The index never decides access.** It returns ranked candidates narrowed by owner, scope, project and state, and each page is
  then re-checked through `Storage` with the real access rules. A stale or wrong index can miss a memory and cannot show one the
  reader may not read.
- **It lives outside the adapters, imports no driver and reads memories only through store methods,** so one engine serves every adapter and
  no adapter carries search SQL.
- **The index is relevance by BM25 over fields, multiplied by a bounded weight factor,** as SPEC 13.4 states.
- **The library is MiniSearch, and it is swappable.** Only its implementation of `MemoryIndex` imports it, a test fails any other import, and one contract test runs over every implementation and asserts behavior, not scores, because libraries score differently. This is the pattern the storage adapters use (48).
- **It is re-indexed on every add, change and delete, and says so while it builds,** so there is no drift by design. The periodic check is a safety net.
- **A separate search server and embeddings are later implementations of the same interface,** not part of the first version.

## Why

- Results are the same on every adapter by construction, because one engine ranks them. The contract needs one differential case, not search SQL in
  three adapters.
- A save followed by a search a second later finds the memory, which an index fed at intervals cannot promise, and a trashed or purged
  memory leaves the index at once.
- Private text stays in one place. A search server would hold a second copy of every private memory in its own files and on its own
  port, and every trash and purge would have to reach it, which is a new place for an operator to read content in silence.
- Nothing new has to be installed, run, published, tested in CI or kept up to date. A second service would add a process to
  `podiumctl`, to the e2e matrix and to the CI jobs that PROJECT.md lists for a new database.
- BM25's saturation and length normalization stop a memory from winning on stuffed words, which a count of matched terms does not.
- The server already runs one process per database (53), so an in-memory index is coherent.

## Alternatives

- **Other libraries.** Fuse.js matches strings fuzzily and does not rank by relevance. Lunr cannot update its index in place. Orama and FlexSearch are capable, and can replace MiniSearch behind the interface if it falls short.
- **A table of terms in every adapter.** Rejected: the largest table in the database, heavy writes behind the transaction gate, a
  weak prefix match, and ranking by a count that a stuffed memory wins.
- **Each database's own full-text search.** Rejected: three rankings, so one query returns three orders and the contract cannot
  hold them.
- **A separate search server (for example Manticore) fed at intervals.** Rejected for now: a second process and port to package and
  secure, a second copy of private text with purges that have to reach it, results that lag a save, and results that still have to be
  re-checked against the database. It can come back as another implementation of the interface if the in-process index stops scaling.
- **Search by meaning (embeddings) from the start.** Deferred: it needs a model or a service, and has no form shared by the three databases.

## Cost

- The index holds every searchable memory in the server's memory. At the limits that is tens to a few hundred megabytes and a start-up
  build of seconds, which the build measures and sets a budget for.
- The index can drift if a write path skips the update. One store method that reports the change and the periodic check are the guards, and
  they have to be kept.
- A search before the first build answers `503` with `Retry-After`.
- The index is valid only with one server per database. If that ever changes, it needs a shared form.
- There is no stemming and no search by meaning in the first version.

<!-- nav:start -->
---

Previous: [80. Memories sync by version chain with a three-way merge, and a conflict is kept and asked](80-memories-sync-by-version-chain-with-a-three-way-merge-and-a-conflict-is-kept-and-asked.md) · Up: [Decisions](README.md)
<!-- nav:end -->
