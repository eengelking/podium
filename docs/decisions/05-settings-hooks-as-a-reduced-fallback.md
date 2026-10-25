---
title: "5. Settings hooks as a reduced fallback"
description: "POST /api/fleet/hook accepts settings hooks for sessions without the mod, showing a reduced view with no tokens, cost or plan."
group: "Project internals"
number: 5
date: "2026-10-11"
status: "accepted"
order: 5
---

# 5. Settings hooks as a reduced fallback

**Decision.** `POST /api/fleet/hook` accepts Claude Code's settings hooks for sessions that never loaded the
mod. They show up marked "settings hooks" with no tokens, cost or plan.

**Why.** You should not have to restart a session to see it at all. A session the mod reports is never
changed by hooks, so enabling both is harmless (`docs/architecture/`, spec question 37).

**Cost.** Hook-only sessions send no heartbeat, so they get a longer stale window (`HOOK_STALE_AFTER_MS`,
10 minutes).

<!-- nav:start -->
---

Previous: [4. SQLite through node:sqlite, validation by hand](04-sqlite-through-node-sqlite-validation-by-hand.md) · Up: [Decisions](README.md) · Next: [6. The report types are copied, and a test keeps them equal](06-the-report-types-are-copied-and-a-test-keeps-them.md)
<!-- nav:end -->
