---
title: "3. Full snapshots plus unacknowledged events"
description: "Each report carries the whole session state plus unacknowledged events, so a lost report is harmless, at the cost of larger reports."
group: "Project internals"
number: 3
date: "2026-10-11"
status: "accepted"
order: 3
---

# 3. Full snapshots plus unacknowledged events

**Decision.** Each report carries the whole session state and the events the server has not acknowledged.
The server upserts it and never needs an earlier report to understand a later one (`docs/spec/` section 6).

**Why.** A lost or repeated report cannot corrupt anything, and a restarted server recovers from the next
report. The mod owns what is true inside a session. The server owns time (staleness, lingering, dropping,
series).

**Cost.** Reports are larger than a delta would be. At one per second that does not matter.

<!-- nav:start -->
---

Previous: [2. A Claude Code mod reports from inside the session](02-a-claude-code-mod-reports-from-inside-the-session.md) · Up: [Decisions](README.md) · Next: [4. SQLite through node:sqlite, validation by hand](04-sqlite-through-node-sqlite-validation-by-hand.md)
<!-- nav:end -->
