---
title: "11. Explicitly out of scope / deferred"
description: "What is out of scope or deferred, and what the design must not preclude."
group: "Reference"
section: "11"
order: 11
---

# 11. Explicitly out of scope / deferred

The design must not preclude these.

- A terminal pane or band inside Claude Code that shows the same fleet (the mod's `$.ui.open` and `ui.render` can draw it later; keep `state.ts` UI-free so a pane can read it).
- Remote or multi-machine fleets beyond one shared server: a named reporter already sends `machine` (6.2), and the people view groups by person and machine (8.1).
- Alerts and notifications (a blowout at level 2 pushes a desktop notification): `session.blowouts.level` and `$.ui.notify` are the hooks for it.
- Budgets and forecasts, comparisons between runs, cost per plan step.
- A scheduled-agent view (`CronCreate` tasks, `session_crons` on the Stop hook). A session waiting on a wake-up is only worded as such (#119); no list of schedules is shown.
- Authentication beyond the shared token.

<!-- nav:start -->
---

Previous: [10. Rules for the implementing agent](10-rules-for-the-implementing-agent.md) · Up: [Specification](README.md) · Next: [12. Open questions and flagged assumptions](12-open-questions.md)
<!-- nav:end -->
