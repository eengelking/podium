---
title: "6.3 Plan building rules"
description: "How the reporter builds a session's plan from task tool calls."
group: "Reference"
section: "6.3"
order: 3
---

# 6.3 Plan building rules

Module: `plan.ts` (pure).

- Keep a map of tasks by id. `TaskCreate` result gives the id; `subject` becomes the step text; `activeForm` becomes `activeText`. `TaskUpdate` applies `status` (`pending`→`pending`, `in_progress`→`active`, `completed`→`done`, `deleted`→remove), `subject`, `activeForm`, `owner`, `addBlockedBy` (a step with an unfinished blocker is `blocked` unless it is `active` or `done`). `TodoWrite` replaces the whole list; ids are `todo-<index>`; the later of Task*/TodoWrite wins as `source`.
- Plan title: the optional tool `mcp__podium-reporter__plan({ title, phase? })` sets it. Otherwise `metadata.planTitle` or `metadata.title` of the first TaskCreate. Otherwise `null` (the UI then shows "Plan").
- Step owner: `TaskUpdate.owner` if it matches an agent `name`; else the running agent whose description, normalized (lowercase, alphanumerics only), equals or contains the step text or vice versa; else `null`. `ownerLabel` is `"<type> · <Model> <effort>"` for the matched agent.
- No tasks yet ⇒ `plan: null`. That is the case for a session whose Claude Code does not provide the task tools or does not use them, and plan mode (`ExitPlanMode`) is not read, so it gives no plan either. The user-facing explanation is in `docs/gotchas/` ("A session shows no plan").

<!-- nav:start -->
---

Previous: [6.2 The Report](06-02-the-report.md) · Up: [6. The reporter protocol](README.md) · Next: [6.4 Failure and excerpt rules](06-04-failure-and-excerpt-rules.md)
<!-- nav:end -->
