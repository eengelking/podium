---
title: "5.8 Session identity, /clear, restarts"
description: "How the reporter keeps one session identity across /clear, resume and restarts."
group: "Reference"
section: "5.8"
order: 8
---

# 5.8 Session identity, /clear, restarts

- A session id changes on `/clear` and on resume. After `/clear` the engine fires `session.end` with
  `reason: "clear"` and **does not fire `session.start`** for the new id.
- Therefore the reporter's flush loop calls `$.session.id()` every time. When it differs from the id in state:
  1. Send a final `done` report for the old id (`endReason: "clear"`).
  2. Reset per-session state (agents, plan, blowouts, event sequence).
  3. Begin reporting under the new id as a new session.
- When the old id ended with `reason: "clear"`, every report under the new id carries
  `clearedFrom: <old id>` ([6.2](../06-reporter-protocol/06-02-the-report.md)), so History can link the two (#206). This holds for a
  `/clear` typed in the terminal and one sent from Podium alike.
- A hot reload re-runs `session.start` for a live session. State rebuilds from `$.agent.list()` and
  `$.session.*`. The first report after a reload carries the full agent list and may lack older event history.
  The server tolerates this: events are idempotent by id and agents are upserted.
- Closing the terminal gives no hook in time. The server's stale logic ([section 7.5](../07-server/07-05-lifecycle-timers.md))
  handles it.

<!-- nav:start -->
---

Previous: [5.7 Git queries](05-07-git-queries.md) · Up: [5. The Claude Code mod API: everything the reporter needs](README.md) · Next: [5.9 Mod configuration (userConfig)](05-09-mod-configuration-userconfig.md)
<!-- nav:end -->
