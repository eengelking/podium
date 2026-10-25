---
title: "5.6 What the engine does and does not tell you"
description: "What data the engine gives the reporter, what it leaves out, and how tokens are counted."
group: "Reference"
section: "5.6"
order: 6
---

# 5.6 What the engine does and does not tell you

Read this before designing.

| Wanted | Where it comes from | Caveat |
|---|---|---|
| Orchestrator model | `$.session.model()`, `turn.step.model` (no `agentId`) | Per step, so a mid-session `/model` shows up. |
| Orchestrator effort | `turn.step.effort` (no `agentId`) | Absent for models without effort support: report `null`. Read on each model request, and no event fires when the setting changes, so a `/effort` change shows after the next prompt. |
| Subagent model | `agent.spawn` result `model`, `turn.step.model` | Resolved alias, may be a full id. Map to a family (section 6.5). |
| Subagent effort | `tool.call` Agent input `effort` (requested), then `turn.step.effort` for that `agentId` (observed, wins) | `agent.spawn` has no effort. Fork: copy the parent's. Record `effortSource`. |
| Skills loaded | `tool.call` with `tool === "Skill"` (per loop via `agentId`), `skill.prompt` (no loop) | An agent definition may preload skills; that is not visible. Report what was observed. |
| Context fill, main loop | `$.session.usage().context.percent`, `session.measure` | `tokens` may be absent before the first response. |
| Context fill, an agent | `turn.step` result `usage` (input + cache read + cache creation tokens) over the model's window | No per-agent window API. Use the table in 6.5. Clamp to 100. Unknown window (non-Claude model): percent is `null`. |
| Tokens, as shown (issue #96) | The same `usage` as context fill (see "Tokens as shown" below) | A running total of all four counters reads about 100 times too large. |
| Blowouts | `session.compact` (auto) and `turn.step` `stopReason` | If the build lacks `session.compact` for agents, fall back to the `stopReason` signal and note it. |
| Cost, session | `$.session.usage().cost.usd` | Real ledger. Includes every agent, those launched by other agents too (verified with a three-level run, #101). |
| Cost, agent | tokens × price table | Estimate only. `null` for a non-Claude model (no price). |
| Plan | `tool.call` for Task*/TodoWrite | Built-in tools have no plan title or phase. |
| Waiting on the user | `classic.PermissionRequest`, `classic.Notification`, `turn.complete` of the main loop | Best effort. If neither classic event is hookable, main-loop `turn.complete` ⇒ `waiting` with `waitReason: "input"`. With background work or a wake-up in flight (`classic.Stop`) it is `waiting` with `waitReason: null` and `background` set instead (#119). |
| Git | `$.process.run(["git", …])` | Section 5.7. |
| Failures | `tool.call` results with `isError`/`{deny}`, `turn.complete.reason`, `turn.step.stopReason` | The engine gives evidence, not a diagnosis. |

## Tokens as shown (issue #96)

- An agent's Tokens figure is its latest context size: input + cache read + cache write of its newest request.
  That is what Claude Code's own agent line shows.
- Its output tokens are not added (#108 did, #120 reverted it). The newest request's context already contains
  the output of the earlier ones, so adding it counted that output twice and ran further above Claude Code's
  the longer the agent worked.
- An orchestrator's figure is its own context size. The facts bar and the wall card show the orchestrator's
  plus every agent's, so the rows add up.
- The agent panel also lists the running totals of the four counters ("Used so far"). Every Tokens label
  carries a tooltip saying this.
- A running total of all four counters re-counts the cached context on every request and reads about 100
  times too large. `tokensTotal`, `tokens_total` and the tokens-per-second figures stay running totals,
  because they measure throughput, not context.

<!-- nav:start -->
---

Previous: [5.5 Tool inputs the reporter reads (Verified)](05-05-tool-inputs-the-reporter-reads.md) · Up: [5. The Claude Code mod API: everything the reporter needs](README.md) · Next: [5.7 Git queries](05-07-git-queries.md)
<!-- nav:end -->
