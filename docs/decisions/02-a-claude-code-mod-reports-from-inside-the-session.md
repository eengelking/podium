---
title: "2. A Claude Code mod reports from inside the session"
description: "The reporter is a Claude Code mod, the only way to see agents, usage and plans from inside a session, at the cost of depending on a new mod API."
group: "Project internals"
number: 2
date: "2026-10-11"
status: "accepted"
order: 2
---

# 2. A Claude Code mod reports from inside the session

**Decision.** The reporter is a Claude Code mod (`mod/podium-reporter/`), not a log parser or an external
process.

**Why.** It is the only mechanism that sees agent spawns, per-step usage, compaction, tool results and plans
from inside a session, and can send them out (`docs/spec/` section 2).

**Cost.** Sessions started without the mod are invisible, except through the reduced settings-hook ingest
(entry 5). The mod depends on Claude Code's mod API, which is new.

<!-- nav:start -->
---

Previous: [1. Podium only observes](01-podium-only-observes.md) · Up: [Decisions](README.md) · Next: [3. Full snapshots plus unacknowledged events](03-full-snapshots-plus-unacknowledged-events.md)
<!-- nav:end -->
