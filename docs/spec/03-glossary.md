---
title: "3. Glossary"
description: "The terms the spec uses (session, orchestrator, agent, fork, blowout and more) and what each one means."
group: "Reference"
section: "3"
order: 3
---

# 3. Glossary

| Term | Meaning |
|---|---|
| Session | One running Claude Code process conversation, identified by its session id (`$.session.id()`). A `/clear` ends a session and starts another in the same process. |
| Orchestrator | The main loop of a session. Podium's top-level row. Same thing as a session. |
| Agent | A loop the orchestrator started: a subagent, a fork, or a teammate. Has an `agentId`. |
| Subagent | An agent that starts from a blank slate (only its prompt). Model and effort can be set at spawn. |
| Fork | An agent that is a copy of its parent: keeps the parent's whole context. Always uses the parent's model and effort. The Agent tool spells it `subagent_type: "fork"`. |
| Loop | The main loop or any agent. Context is measured per loop. |
| Plan | The orchestrator's task list (`TaskCreate`/`TaskUpdate` tools, or `TodoWrite`), shown as steps. Without those tool calls there is no plan; plan mode is not a source (6.3). |
| Blowout | A loop's context window filled up and was compacted automatically, or the API reported the window exceeded. The count per loop is the signal for lost context. |
| Compaction | Summarizing older conversation to free context. Manual (`/compact`) is not a blowout. Automatic is. |
| Reporter | The mod. Runs in the Claude Code process and posts reports. |
| Report | One JSON snapshot of a session plus any new activity events, POSTed to the server. |
| Stale | A session the server has not heard from for 15 seconds and that never reported ending. |
| Effort | The reasoning-effort level: `low`, `medium`, `high`, `xhigh`, `max`. |
| Mod / plugin | The Claude Code extension mechanism. This spec uses "mod" for the reporter. |
| Ask | One thing a session waits on its person for, that Podium can answer (#206): an AskUserQuestion form, a plan (ExitPlanMode), or a tool's permission prompt. Its id is the tool call's `tool_use_id`. |
| Delivery | One answer or message sent from the browser, held by the server until the mod fetches it and says whether the session took it (6.2, 7.1). |

---

<!-- nav:start -->
---

Previous: [2. Tech stack](02-tech-stack.md) · Up: [Specification](README.md) · Next: [4. Architecture](04-architecture.md)
<!-- nav:end -->
