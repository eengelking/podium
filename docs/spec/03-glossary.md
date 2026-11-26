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
| Harness | The program that runs an agent session. Claude Code and OpenCode are the supported harnesses (DECISIONS 54). |
| Session | One running harness conversation (for Claude Code, one process conversation), identified by its session id (`$.session.id()`). A `/clear` ends a session and starts another in the same process. |
| Orchestrator | The main loop of a session. Podium's top-level row. Same thing as a session. |
| Agent | A loop the orchestrator started: a subagent, a fork, or a teammate. Has an `agentId`. |
| Subagent | An agent that starts from a blank slate (only its prompt). Model and effort can be set at spawn. |
| Fork | An agent that is a copy of its parent: keeps the parent's whole context. Always uses the parent's model and effort. The Agent tool spells it `subagent_type: "fork"`. |
| Loop | The main loop or any agent. Context is measured per loop. |
| Plan | The orchestrator's task list (`TaskCreate`/`TaskUpdate` tools, or `TodoWrite`), shown as steps. Without those tool calls there is no plan; plan mode is not a source (6.3). |
| Blowout | A loop's context window filled up and was compacted automatically (at 80% full or more, or when the fill is unknown), or the API reported the window exceeded. The count per loop is the signal for lost context. |
| Compaction | Summarizing older conversation to free context. Manual (`/compact`) is not a blowout. Automatic is, unless the context was below 80% full: Claude Code also compacts early, probably after a quiet stretch, and that is only a `compact` event, and the card shows it as the Comp pill. |
| Reporter | The part that runs inside a harness and posts reports. For Claude Code it is the mod. |
| Report | One JSON snapshot of a session plus any new activity events, POSTed to the server. |
| Stale | A session the server has not heard from for 15 seconds and that never reported ending. |
| Effort | The reasoning-effort level: `low`, `medium`, `high`, `xhigh`, `max`. |
| Mod / plugin | The Claude Code extension mechanism. This spec uses "mod" for the reporter. |
| Ask | One thing a session waits on its person for, that Podium can answer (#206): an AskUserQuestion form, a plan (ExitPlanMode), or a tool's permission prompt. Its id is the tool call's `tool_use_id`. |
| Delivery | One answer or message sent from the browser, held by the server until the mod fetches it and says whether the session took it (6.2, 7.1). |
| Brain | The server's store of a person's memories, shared by their agents and found by search (13). |
| Memory | One note in the brain: a name, a description, a body, resources, tags, a type and a project, kept as a chain of versions (13.2). |
| Project (brain) | Anything one or more people work on, one per name on the server, identified by the repository's name or named by hand. Every memory but a Global one belongs to one (13.3). |
| Global memory | A person's memory that belongs to no project, for preferences. Only its owner reads it (13.3). |
| Resource | A reference attached to a memory, read on its own after the body (13.2, 13.4). |
| Scope | Who may read a memory: `personal` (the owner and the agents they allow) or `shared` (the members of its project) (13.3). |
| Shared version | The version of a shared memory that members see. An agent's change waits for the owner's approval before it becomes the shared version (13.3). |
| Mirror | One reporter's copy of a harness's memory folder, with the version of each memory both sides last agreed on (13.5). |
| Tombstone | What stays when a memory is deleted: its id, owner and the time, and no text, so the delete reaches other machines (13.2). |

---

<!-- nav:start -->
---

Previous: [2. Tech stack](02-tech-stack.md) · Up: [Specification](README.md) · Next: [4. Architecture](04-architecture.md)
<!-- nav:end -->
