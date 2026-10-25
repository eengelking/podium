---
title: "An agent's cost does not add up to the session's"
description: "An agent's row shows its own estimate while the card shows the session's figure; update the mod for exact sums."
group: "Project internals"
area: "What the console shows"
date: "2026-10-12"
status: "open"
order: 27
---

# An agent's cost does not add up to the session's

**You see:** The agents' costs in the tree do not sum to the figure on the card.

**Why:** An agent's row shows its own estimated cost, not the agents it launched. The facts bar and the card show the
session's figure from Claude Code, which includes every agent at every depth once, plus the orchestrator itself. The orchestrator's row
shows its own share: that figure less each agent's estimate, so the rows add up to it.

From reporter 0.12.0 the server prices the session and every agent from the same per-model token totals and the prices
in Admin > Model prices, so the rows add up. A session from an older reporter shows Claude Code's ledger as its figure,
while an agent's is an estimate from a price table, so its rows will not sum exactly.

**Do:** To see a branch, open the agent. **With its agents** adds it and everything under it. Update the mod for exact
sums.

<!-- nav:start -->
---

Previous: [A plan step has no owner](plan-step-has-no-owner.md) · Up: [Gotchas](README.md) · Next: [Every agent sits under the orchestrator in a session started without the mod](flat-agent-tree-without-the-mod.md)
<!-- nav:end -->
