---
title: "77. Data binds to a person's id or an agent's id, never to a name (#1284, #1289)"
description: "An id that is never reused binds a person's and an agent's data, and a name is display text, so a same-named newcomer inherits nothing."
group: "Project internals"
number: 77
date: "2026-11-21"
status: "accepted"
order: 77
---

# 77. Data binds to a person's id or an agent's id, never to a name (#1284, #1289)

*Amends the older stance, written into several migration comments and spec lines, that sessions, spend and Admin log entries "keep the name as text" and are found by it. Decisions 66, 74 and 75 already key a conversation by `people.id`; this one states the rule for everything else.*

## Context

Names change, and they are given again. A person is deleted and a new person takes the name. A session is reset with `/clear` and the new one takes the old agent's name. When data
is found by a name, the newcomer finds what the earlier holder left: their sessions, their reporters, their rights and requests, their messages, their Chat read counts, their
spend. Nothing in the older design stopped that, because the name was the key. PR #1288 (#1284) found how far it went and moved the binding.

## Decision

- **A person and an agent always have a unique id, and that id binds data.** A person's id is `people.id`. An agent's id is the one the server gives its session (`agent_ids`) when
  it first hears of it. Neither is ever reused.
- **A name never binds data.** It is display text, and a label a person types to address someone (`name@machine`, an `@mention`), which resolves to an id before anything is read or
  written. A name decides no access to a person's data.
- **A row whose person is gone is detached, and never handed to a newcomer.** Deleting a person leaves their sessions, reporters, spend and similar rows with no owner id (NULL, or 0
  in the daily tables), the name kept as text. A person who takes the name later owns none of them. A newcomer who claims a deleted person's reporter key has that key's links
  cleared first.
- **A new column, key, query or check that names a person or an agent uses the id.** A name column beside it is for display only. The id has no foreign key, because a deleted
  person's id must stay on the rows that name it, and the id is never reused.
- **A new agent is a new id.** A `/clear` makes one, whatever name it takes. A send to an id whose session has ended is refused, and decision 75 builds on that.

What stays by name is display, routing or throttling and decides no access: the sign-in lookup, typed addresses, rate-limit keys, Admin log and activity text, and the grouping and
sorting the console shows. Statistics keyed by an owner's name merge two people of one name in a row, and the totals do not change.

## Why

- A name that binds data lets a newcomer inherit what an earlier holder had. That is a leak of one person's work to another, and it cannot be fixed afterwards, because the data
  and the newcomer can no longer be told apart.
- An id cannot be typed, taken or changed, so the question "whose is this?" has one answer for as long as the row exists.
- Detaching on deletion keeps the totals and the history, which an administrator still wants, without giving them to anyone.

## Alternatives

- Delete a person's rows with the person: a deleted person's spend and history would disappear from reports.
- Keep binding by name and block a name's reuse: a name could never be given again, and an agent's name changes on `/clear` anyway.
- Add foreign keys to `people.id`: the id has to outlive the person on the rows it detaches, and a foreign key would block that or cascade the rows away.

## Cost

Two limits that #1288 left open, each its own issue:

- **The upgrade still maps by name in one place.** `peer_owner_settings` has no time column, so a newcomer who took a deleted person's name before the upgrade still gets the owner
  defaults (trust level, limits) an older server kept under that name, and the `person:<name>` link keys migrate by name. The defaults govern only that person's own reporters.
  Closing it needs a design decision.
- **A person named literally `gone:x` collides with the `person:gone:` form.** That form is a link end for a migrated row whose name matched nobody, so such a person's link end
  reads as a detached one.

Beyond those, every backfill only gives a row to a person who existed when the row was written, and a row that fails that check stays detached, so an upgraded server may hold more
detached rows than before.

<!-- nav:start -->
---

Previous: [76. The server tests on every adapter run from `npm run test:db`, with the options of `e2e:fast` (#1294)](76-the-server-tests-on-every-adapter-run-from-npm-run-test-db-with-the-options-of-e2e-fast.md) · Up: [Decisions](README.md)
<!-- nav:end -->
