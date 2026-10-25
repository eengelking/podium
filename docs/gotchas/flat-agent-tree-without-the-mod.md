---
title: "Every agent sits under the orchestrator in a session started without the mod"
description: "Settings hooks do not say which agent launched which, so a hook-only session cannot nest; install the mod for the nested tree."
group: "Project internals"
area: "What the console shows"
date: "2026-10-12"
status: "open"
order: 28
---

# Every agent sits under the orchestrator in a session started without the mod

**You see:** In a session reported by settings hooks, the agent tree is flat.

**Why:** The settings hooks (`SubagentStart`, `SubagentStop`) say which agent started but not which agent launched it,
so a hook-only session cannot nest. The mod reads the parent from `agent.spawn` and nests correctly at any depth
(SPEC 5.3).

**Do:** Install the mod to get the nested tree.

<!-- nav:start -->
---

Previous: [An agent's cost does not add up to the session's](agent-costs-do-not-add-up-to-the-session.md) · Up: [Gotchas](README.md) · Next: [Elapsed times freeze when the tab is in the background](elapsed-times-freeze-in-a-background-tab.md)
<!-- nav:end -->
