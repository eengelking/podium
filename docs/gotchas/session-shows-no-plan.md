---
title: "A session shows no plan"
description: "Podium builds the plan from the session's task list only; turn on the task tools and ask Claude to track the work as a task list."
group: "Project internals"
area: "What the console shows"
date: "2026-10-14"
status: "open"
order: 25
---

# A session shows no plan

**You see:** The card reads "No plan reported. Agents were launched ad hoc."

**Why:** Podium builds the plan only from the session's task list: the `TaskCreate` and `TaskUpdate` tools (or
`TodoWrite`). If Claude did not use them for the work, there is nothing to show. That happens when the tools are not
available to the session, and also when they are but Claude chose not to use them for a small job. Plan mode does not
make a plan appear: Podium does not read it, so `ExitPlanMode` alone gives no steps.

**Do:** Make sure the task tools are on, then ask Claude to track the work as a task list.

1. Start Claude Code with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in its environment, or add it to the `env` block of
   `~/.claude/settings.json`.
2. Ask Claude to track the work as a task list.

The agent tree is shown either way.

<!-- nav:start -->
---

Previous: [systemctl --user start podium.service does nothing after podiumctl stop (container mode)](systemctl-start-does-nothing-after-podiumctl-stop.md) · Up: [Gotchas](README.md) · Next: [A plan step has no owner](plan-step-has-no-owner.md)
<!-- nav:end -->
