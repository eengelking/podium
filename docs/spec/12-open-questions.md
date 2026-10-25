---
title: "12. Open questions and flagged assumptions"
description: "The open questions and flagged assumptions an implementer verifies, with where each answer is recorded."
group: "Reference"
section: "12"
order: 12
---

# 12. Open questions and flagged assumptions

These were not resolvable from the type declarations alone. The implementer verifies each and records the answer in `docs/architecture/`. None blocks starting.

1. Does `$.session.usage().cost.usd` include subagent spend? (T3.4)
2. Are `classic.PermissionRequest` and `classic.Notification` hookable from a mod, and do they fire for a permission dialog in a headless run? If not, `waiting` is derived from main-loop `turn.complete` only. (T3.4)
3. Does `session.compact` fire with an `agentId` for a subagent's own compaction? If not, agent blowouts come only from `stopReason`. (T3.4)
4. What are the real context windows per model family for subagents, and the current prices? Fill `models.ts` from the `claude-api` skill, not from memory.
5. Does `tool.call` for the `Agent` tool run before or after `agent.spawn` for the same `tool_use_id`? The reporter must tolerate both orders (it keys pending data by `tool_use_id` and merges).
6. Exact `userConfig` syntax in `plugin.json`, and whether relative imports need file extensions. `claude plugin validate` decides.
7. How is a bash exit code exposed in a `tool.call` error result? The reporter parses `text` best effort; improve if the result carries a field.
8. Should the dashboard also show teammates (agent-team members) distinctly? v1 shows them as agents with `kind: "teammate"` and the same row design.
9. Does the sample worktree detection work when a session is started inside a worktree created by `isolation: "worktree"`? Verify with one real run.
10. Name: "Podium" is a working name. Keep it in one constant (`APP_NAME`) so it can change.

<!-- nav:start -->
---

Previous: [11. Explicitly out of scope / deferred](11-out-of-scope-and-deferred.md) · Up: [Specification](README.md)
<!-- nav:end -->
