---
title: "38. The Plan list ends with the done steps, in the order the server saw them finish (#454)"
description: "The Plan list shows in progress, blocked, pending, then done steps in the order the server saw them finish, as fine as the reporting interval."
group: "Project internals"
number: 38
date: "2026-10-19"
status: "accepted"
order: 38
---

# 38. The Plan list ends with the done steps, in the order the server saw them finish (#454)

**Context.** The Plan tab listed steps in the order the model wrote them and paged them 10 at a time. In a long plan the
step being worked on and the steps still to do landed on different pages with finished steps between them. A step
carries no finish time, so "in the order they finished" had to come from somewhere.

**Decision.** The list is ordered in progress, blocked, pending in plan order, then done in finish order (`docs/spec/` 8.1).
Blocked goes right after in progress, above pending: a blocked step is open work a person may need to act on, so it stays
on the first page. The server records the finish order. On each report it compares the plan with the stored one and gives a
step that has newly become done the next number (`doneSeq`, in `plan_json`); a step that stays done keeps its number and a
reopened step loses it. Steps done in the first plan the server saw have none and come first among the done, in plan order.

**Alternatives.**

- The browser notices a step change state. Rejected: a page opened late, or reloaded, has no order, which is the common
  case for a long plan.
- The reporter sends a finish time. Rejected: a protocol change in both copies for something the server can see anyway, and
  every older reporter would still send plans without it.
- Sliding the rows when a step moves. Left out: optional in the issue and it adds a motion case for reduced motion.

**Cost.**

- The server keeps a number per done step. It is derived on each report from the stored plan, so nothing new is stored
  apart from the field.
- Two steps that finish between two reports get numbers in plan order, not true order. The order is as fine as the
  reporting interval.
- A new plan that reuses step ids (TaskCreate numbers from 1) inherited the numbers of ids that were done and still
  were. #465 closed that, see below.

**Amended (#465): when two plans are the same plan.** The numbers carry over from the stored plan only when the new one
is the same plan: equal source, equal title, and the same text for every step id the two share (and at least one shared
id). Anything else is a replaced plan and starts over, as if first seen, so steps done in it get no number until a later
report sees them finish. Step texts are what separate two TaskCreate plans, since both number from 1 and the title is
often empty. Renaming a step therefore also starts the order over; the list falls back to plan order, which is the
accepted cost. A report with no plan no longer drops the numbers: while a report carries none, the server keeps the last
plan in `plan_kept_json` (migration 21) and compares the next plan with it. Rejected: comparing only titles (usually
null), and keeping a second copy of every plan (the column is filled only during a gap).

<!-- nav:start -->
---

Previous: [37. Orchestrators can message each other, but only one person's own (#347)](37-orchestrators-can-message-each-other-but-only-one.md) · Up: [Decisions](README.md) · Next: [39. The Admin can keep the activity feed, in a second SQLite file (#432)](39-the-admin-can-keep-the-activity-feed-in-a-second.md)
<!-- nav:end -->
