---
title: "Known reporters"
description: "How the server tracks the reporters it has seen, and the Admin tab that lists them."
group: "Project internals"
order: 6
---

# Known reporters

Files: `server/src/fleet/reporters.ts`, `frontend/src/fleet/admin/ReportersTab.tsx`. Issues #142, #166, #167
and #221.

**The store**

- `ReporterStore` owns migration 11 (`reporters` and `reporter_sessions`) and is built once in `index.ts`, then
  handed to both routers.
- `routes.ts` calls `record()` after a report or hook is stored. The key is the machine id (or the source address
  when the report has none), plus `#<owner>` for a second account on the same machine (`accountKey`), and the
  credential is recorded as a key id, never a token.
- `routes.ts` calls `rejected()` at each refusal. It keeps the last 200 in memory only.

**One row per reporter**

- A report with no machine id is filed under the row that already holds its session id (`knownKey`). A row made
  for the new address before that session turned up is merged into it, so a reporter that changes address (a
  container that restarts) stays one row. Migration 12 merges the duplicates that already existed.
- An unnamed reporter is named by its newest session's project, else its address.

**Ignore rules** (#167, migration 13, `reporter_ignores`)

- They live in the same store. `routes.ts` asks `ignoredBy()` before it stores a report or hook and, on a match,
  refuses with a 403 (`refuseIgnored`) and records the refusal.
- Rules are matched in JavaScript, with `*` turned into a case-insensitive pattern and everything else escaped,
  so no stored text is ever a regular expression.
- `removeMany`, `removeState` and `keys` serve the bulk removal behind `POST /api/admin/reporters/remove`.

**Retention and state**

- Retention (`fleet.retain`) never touches the table, so a reporter outlives its sessions. The one exception is
  the forget-by-age setting (`forgetStale`, two keys in `settings`). `index.ts` hands it to `startSweeper` as an
  `onRetention` hook, and `forgetReporters` runs hourly, logging to the Admin log.
- The session count comes from `reporter_sessions`.
- The state (reporting, idle, silent, not since restart) is computed in SQL from the last report, the server's
  start time and now, so filtering, counting and sorting by it stay server-side and paged. The browser asks again
  every 10 seconds.
- The page is admin-only because it shows source addresses and machine names.
- The report format did not change, so the mod's options are not available to show.

<!-- nav:start -->
---

Previous: [Orchestrator page](05-orchestrator-page.md) · Up: [Components](README.md) · Next: [Prompt and answer modal](07-prompt-and-answer-modal.md)
<!-- nav:end -->
