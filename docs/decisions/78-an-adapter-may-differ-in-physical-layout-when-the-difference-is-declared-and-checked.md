---
title: "78. An adapter may differ in physical layout when the difference is declared, checked and changes no data a store call can see (#1296)"
description: "SQLite may lay a table out without a rowid when the difference is declared in one list and the same contract case passes on every adapter."
group: "Project internals"
number: 78
date: "2026-11-22"
status: "accepted"
order: 78
---

# 78. An adapter may differ in physical layout when the difference is declared, checked and changes no data a store call can see (#1296)

*Amends the pattern "A schema change lands in every adapter" in `docs/PATTERNS.md` and the rule "A database change is made in every adapter" in PROJECT.md. Builds on 48, 53 and 76. It changes how the rule is read, and no table, column or index.*

## Context

PROJECT.md says a new, changed or removed column, table, index, key or constraint is made in every adapter, and `server/src/storage/adapters.test.ts` fails when one adapter has a table, column or index another lacks. The reason is that an interface creates nothing in a database, and a change made in one adapter leaves the others behind.

The rule was written for what a store can see. It does not say what to do with a change that is only about how SQLite lays a table out. The audit (#1296, DUP-021) found one. A SQLite table with a composite text primary key keeps the key twice, in the row and in the key's own index. `WITHOUT ROWID` keeps it once. For `conversation_deliveries`, the table that holds the most rows per message, 200,000 rows fall from 57.2 MB to 30.7 MB (46%), measured on a seeded file, and from 57.2 MB to 22.8 MB (60%) with the key change the audit calls DUP-015. MariaDB's InnoDB already keeps a row once, in its clustered key. PostgreSQL keeps the key in the heap and in the index, as SQLite does, and has no layout that removes it.

Under the rule as written the change is "one adapter and not the others" and the PR is incomplete. Under the rule's reason it is not: no table, column, index, key, order or value differs, and the same contract case passes on all three.

## Decision

- **A physical layout option may be set in one adapter** when all of these hold:
  - it changes no table, column, index, key, constraint, default, collation, order, value or error that a store call returns or throws, and no durability or isolation;
  - it brings that adapter's storage to what another adapter's design already has (MariaDB's clustered key for `WITHOUT ROWID`), or the other adapters have no such option, and the entry says which;
  - it is declared in the adapter's own folder, in the one list of physical differences, with the table, the option, the reason, the measured gain and the contract case that proves the data is the same;
  - the same contract case passes on every adapter.
- **What must stay identical:** the names of tables, columns and indexes, the columns of every key and their order, uniqueness, `NOT NULL` and defaults, the result and the order of every store method, the messages of what it throws, and the rows after a migration. `adapters.test.ts` keeps checking the names, and the contract keeps checking the rest.
- **What is physical:** a table's row storage (`WITHOUT ROWID` in SQLite, row format or fill factor in the others) and the choice of a page or file parameter. Durability (an unlogged table), a different index set, a column type with different limits, a different collation, or a table that exists in one adapter only are not physical, and this decision does not allow them.
- **The list is checked, not trusted.** Each adapter reads the layout of its own tables from its database, and the test fails when that differs from the declared list in either direction: an undeclared option, or a declared one that is not there.
- **A migration for a physical option is the adapter's alone.** The other adapters have no step for it. The step says in its comment that it is physical and names this decision, and the PR body says no other adapter is affected and why.
- **First use:** `conversation_deliveries` in SQLite, in the same step as the key change DUP-015 (the key becomes `(message_id, member_kind, member_ref)`).

## Why

- The rule exists so that no adapter is left behind on data. A layout that no store call can see leaves none behind, and a reason to refuse the change that does not apply is only noise.
- The saving is large on the table that grows fastest, in the database most people run (SQLite is the default), and costs one rebuild that the key change needs anyway.
- A declared and checked list is stricter than the old position, where a physical difference in one adapter would pass the schema test unseen. Today nothing records one.

## Alternatives

- **No exceptions.** The rule stays whole, and SQLite keeps storing the key twice. Rejected for the cost above.
- **An undeclared exception, by review.** A reviewer would have to see it. Rejected: the schema parity test cannot see a layout, so a second and a third one would go unnoticed.
- **A change to PostgreSQL and MariaDB to match.** There is nothing to change in MariaDB, and PostgreSQL has no layout that keeps a row once.

## Cost

- One more list, one more method on `ContractAdapter` and one more test. The list is empty for PostgreSQL and MariaDB.
- A `WITHOUT ROWID` table has no `rowid` and no `AUTOINCREMENT`, and a scan returns rows in key order, not insertion order. A query with no `ORDER BY` can change its order. The pattern "every list query has a defined `ORDER BY`" and `scripts/storage-order-parity.mjs` hold this, and the declared case must read the table in an order that would show it.
- The condition "the other adapters already keep it once" is not true of PostgreSQL for a composite key, so the entry's second condition says what is true: the option brings the adapter to what another adapter's design already has, or the others have no such option.

<!-- nav:start -->
---

Previous: [77. Data binds to a person's id or an agent's id, never to a name (#1284, #1289)](77-data-binds-to-a-persons-or-an-agents-id-never-to-a-name.md) · Up: [Decisions](README.md) · Next: [79. The brain keeps every memory in a project, personal or shared, and every Admin read of one is told](79-the-brain-keeps-every-memory-in-a-project-personal-or-shared-and-every-admin-read-of-one-is-told.md)
<!-- nav:end -->
