---
title: "13.9 Storage, limits and retention"
description: "What the store holds in every adapter, the checks that must exist before any route, the limits and their defaults, and how long each kind of row is kept."
group: "Reference"
section: "13.9"
order: 9
---

# 13.9 Storage, limits and retention

The brain reaches its database only through `Storage` ([DECISIONS 48](../../decisions/48-storage-sits-behind-async-interfaces-with-sqlite-as-the-only-adapter.md)).
Every query is a method on a store interface in `server/src/storage/types.ts`, every table is made in SQLite, PostgreSQL and
MariaDB with its own migration, and every method has a case in `contract.ts` that passes on all three. The names below describe
the data the build needs. The column names are not fixed until the schema lands. Search is not here: it is an index in the server
([13.4](13-04-search-and-weight.md)), fed by store methods.

## 13.9 What the store holds

| Data | Holds |
|---|---|
| Memories | The record of [13.2](13-02-the-memory.md) without the text: id, owner, scope, project, type, state, current version, weight, `weight_at`, provenance, `source`, and a change counter |
| Versions | One row per version: its memory, parent (and a second parent for a merge), author, time, content hash, and the content. A conflict's local side is a version on a side branch. The content is what a purge removes |
| Tags | One row per memory and tag |
| Edges | `related` and `supersedes` between two memories |
| Votes | One row per voter and memory: the voter's kind and id (neither nullable), the value, the reason and the time ([13.4](13-04-search-and-weight.md)) |
| Uses | One row per person, memory and day, swept after two days |
| Resources | Part of a version: name, description and content for each |
| Weight history | Every vote event (memory, amount, reason, time) and a count of uses per memory per day, with no voter and no reader |
| Projects | A person's projects, their directory rules and their grants per reporter ([13.3](13-03-who-can-read-and-write.md)) |
| Mirrors | One row per server-side reporter, harness, folder id and memory: the base version and the time of the last sync ([13.5](13-05-sync-with-local-memory-files.md)) |
| Conflicts | An open conflict: the stored local version, the base, the folder, the time, and how it was resolved |
| Promotion requests | A request of its own, outside the `everyone` scope until approved ([13.3](13-03-who-can-read-and-write.md)) |
| Offers | A share offer: sender, recipient, memory, the version it is bound to, a copy of that version's text for the offer's life, state, times |
| Proposals | The review log ([13.6](13-06-the-reviewer.md)): run, reviewer, session, memory, base version, change, reason, outcome |
| Settings | Entries in the existing settings store, read through the `Live*` cache like the other Admin settings |

Admin reads and deletes go to the existing Admin log, which never holds the text. The act the person is owed is kept on their
`act:` thread as for other Admin acts (DECISIONS 69, #1328).

## 13.9 Before any route exists

Three things are built first, because the rest rests on them:

1. **The Admin read registry check covers memory fields.** `adminReads.test.ts` finds a read of content only when a row declares
   `text`, `prompt`, `answer`, `input`, `question` or `plan`. It is extended to `body`, `description`, `tags` and the content
   fields of conflicts, offers and proposals, with a test that a row with a `body` and no registry entry fails the build. Until it
   is, a new memory route with no entry would pass `npm test` and be a quiet read.
2. **The harness spike of [13.5](13-05-sync-with-local-memory-files.md)** is done, so no sync issue is written on an assumption.
3. **A measurement at the limits** below, on every adapter and in the index: the time and size of a rebuild, the cost of a first
   import of 300 files and of a person's session-start sync, and the time reporters wait while it runs. Every adapter runs
   transactions one at a time per process, so a long write blocks the rest, and imports are batched outside the gate and write a
   bounded number of rows at once. The numbers go in this page, and a limit changes only on a measurement.

## 13.9 Rules for the schema and the store

- **A schema change lands in every adapter** (PATTERNS, "A schema change lands in every adapter"). `adapters.test.ts` fails a table,
  column or index that exists in one adapter and not another.
- **A memory change and its change counter are written in one transaction** with `Storage.tx`, and nothing waits on a network
  call inside it. The index is updated after the commit, in the same request ([13.4](13-04-search-and-weight.md)).
- **A person's memory id is never reused,** and no memory row has a foreign key to `people.id`, so a deleted person's `everyone`
  memories keep their owner empty and the name as text (DECISIONS 77).
- **No nullable column is part of a unique key.** `NULL` counts as distinct in all three databases, so a nullable voter would let
  duplicates through.
- **A contract case for every behavior:** the access rules (a reader never gets a memory the rules deny, and a denied id answers as
  a missing one), the readable-ids check the index's results go through, the version chain, the compare-and-swap of a push, the
  trash, restore and purge of a memory, the fade of weight and a changed or withdrawn vote, a share offer's accept, decline,
  withdraw and expiry, a promotion request, a person's deletion, and a limit lowered below existing data. A migration that
  rewrites rows gets an upgrade test in each adapter.
- **Search has its own tests** ([13.4](13-04-search-and-weight.md)): the tokenizer and ranking with fixtures, one differential case that loads the same
  fixtures through every adapter and requires the same results, a test that a stale index returns nothing the reader may not
  read, and one that a trashed memory is not found.
- **The Admin read registry** has an entry for every route that returns a memory's text, a version, an offer, a proposal, a
  conflict or an import list, and each `told` entry names the case that signs in as an Admin ([13.3](13-03-who-can-read-and-write.md)).

## 13.9 Limits and defaults

The Admin can change each limit in Admin > Memories. A limit lowered below existing data **grandfathers** what is there: an
existing memory keeps working, and a new write over the limit is refused with the limit named, never truncated. The defaults are:

| Limit | Default |
|---|---|
| Memory `body` | 8,000 characters |
| Resources per memory / each resource | 10 / 8,000 characters |
| Weight amounts | use +1, up +3, not relevant -1, wrong, outdated or unsafe -4 |
| A promotion waits before the owner may approve | 7 days |
| `name` / `description` | 120 / 300 characters |
| Tags per memory | 10 |
| Memories per person | 5,000 |
| `everyone` memories in all / per person | 20,000 / 500 |
| Open share offers per sender | 20 |
| Tool calls per session | 60 a minute; saves 20 a minute and 200 an hour |
| Flags per person | 20 a day |
| Search results per page | 10, at most 50 |
| Weight half-life | 90 days |
| Flags that hide an `everyone` memory | 3 people, or one Admin's confirmation |
| Trash | 30 days |
| A share offer expires | 30 days |
| A reviewer's run | 200 proposals or 2 hours |

## 13.9 Retention

| Kind | Kept |
|---|---|
| The current version of a live memory | As long as the memory is |
| An older version | While a mirror names it as a base, for 30 days, and the 20 most recent, then purged with its text |
| A trashed memory, with its text | 30 days, then purged to a tombstone |
| A tombstone | 180 days by default, then removed |
| A mirror | Until it has not synced for the tombstone retention. Then it expires and its next sync is a full reconcile ([13.5](13-05-sync-with-local-memory-files.md)), and its base versions can be purged |
| A resolved conflict | 30 days |
| An answered or expired offer | 30 days, without the text |
| A proposal and its outcome | 90 days, and its proposed text only while open or while the change can be undone |
| An Admin read or delete in the Admin log | As the Admin log is kept, never with the text |
| A vote, and the weight history | As long as the memory is |

A sweep applies these on the server's existing sweep timer ([7.5](../07-server/07-05-lifecycle-timers.md)) and logs the counts it removed, never a memory.
Where a rule says a mirror's base is kept and another says an old version is purged, the mirror wins until the mirror expires.

## 13.9 Backup and restore

Podium has no backup or restore command today. [SERVER.md](../../SERVER.md) says what to back up for PostgreSQL and MariaDB,
including what lives outside the database. This section adds a versioned backup and a checked restore, for the whole database
and not only the brain.

- **Back up with the server stopped.** The user guide says how for each database: copy the SQLite files, or use the database's
  own dump tool for PostgreSQL and MariaDB.
- **A backup records the server version** it was taken from.
- **A restore into a different version is refused.** A server that starts on an older database migrates it and cannot tell that it
  was restored, so the check lives in a restore command in `podiumctl` that compares the recorded version with the installed one.
- After a restore, mirrors reconcile in full ([13.5](13-05-sync-with-local-memory-files.md)), and the index is rebuilt with its banner
  ([13.4](13-04-search-and-weight.md)).

This is a separate issue from the brain's own tables, and it ships before the first release that holds memories.

## 13.9 What every issue must carry

Each issue cut from this section lists, in its Definition of Done, the tests it must add and run: the contract cases on every
adapter, the index contract, the e2e specs and their row in `docs/e2e/COVERAGE.md`, the live test for each harness it touches,
and the documentation-sync sweep (the user guide, the atlas when the change is structural, and the standards through their own
process).

## Related

- [13.2 The memory](13-02-the-memory.md)
- [7.2 Database](../07-server/07-02-database.md)

<!-- nav:start -->
---

Previous: [13.8 The console](13-08-the-console.md) · Up: [13. The brain](README.md) · Next: [13.10 Open questions](13-10-open-questions.md)
<!-- nav:end -->
