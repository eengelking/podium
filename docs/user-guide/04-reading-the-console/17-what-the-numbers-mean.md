---
title: "What the numbers mean"
description: "Look up how cost and the other numbers on the console are worked out."
group: "Getting started"
order: 17
---

# What the numbers mean

**Cost** is an estimate from token counts and a price table, and it is never a bill.

- The prices are the ones in **Admin > Model prices**, which start as Anthropic's published list prices. Change them
  there to match what you pay.
- The session's figure covers the orchestrator and every agent, nested ones included. The figures for agents are each
  agent's own use, and the console labels them as estimates. The orchestrator's row in the agent tree shows the
  session figure.
- A session from a reporter older than 0.12.0 sends no per-model tokens, so its cost is the figure Claude Code's own
  ledger gave, and your prices do not change it.
- A session on a model that is not a Claude model (a local model served by Ollama, for example) has no price, so its cost
  reads "n/a". The "Est. cost today" tile leaves it out and says how many sessions it skipped.

**Context fill** is the share of the model's window in use. When Podium does not know a model's window, the bar is empty
and marked unknown rather than computed against a guessed size.

**A blowout** is a loop that overflowed its window and was compacted or stopped.

**Effort** is read from each model request, so after `/effort` it updates at your next prompt. It is drawn as five bars
with no text. More lit bars mean more effort, and the color changes with the level:

| Level | Color |
|---|---|
| low | orange |
| medium | green |
| high | blue |
| xhigh | purple |
| max | rainbow |

Hover the bars to read the level. Dimmed bars mean the level was not reported.

<!-- nav:start -->
---

Previous: [History](16-history.md) · Up: [Reading the console](README.md)
<!-- nav:end -->
