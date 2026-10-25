---
title: "A plan step has no owner"
description: "An agent links to a step only when its description matches the step's title literally; matching wording helps."
group: "Project internals"
area: "What the console shows"
date: "2026-10-11"
status: "open"
order: 26
---

# A plan step has no owner

**You see:** A plan step shows no agent next to it.

**Why:** Podium links an agent to a plan step by matching the agent's description to the step's title, and the match is
literal. "Count .ts files under server" and "Count .ts files in server" do not match.

**Do:** Nothing on your side. Matching wording between the step and the agent's task helps.

<!-- nav:start -->
---

Previous: [A session shows no plan](session-shows-no-plan.md) · Up: [Gotchas](README.md) · Next: [An agent's cost does not add up to the session's](agent-costs-do-not-add-up-to-the-session.md)
<!-- nav:end -->
