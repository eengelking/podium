---
title: "11. Explicitly out of scope / deferred"
description: "What is out of scope or deferred, and what the design must not preclude."
group: "Reference"
section: "11"
order: 11
---

# 11. Explicitly out of scope / deferred

The design must not preclude these.

- A terminal pane or band inside Claude Code that shows the same fleet (the `/podium config` settings window is the one pane that ships) (the mod's `$.ui.open` and `ui.render` can draw it later; keep `state.ts` UI-free so a pane can read it).
- Remote or multi-machine fleets beyond one shared server: a named reporter already sends `machine` (6.2), and the people view groups by person and machine (8.1).
- Alerts and notifications (a blowout at level 2 pushes a desktop notification): `session.blowouts.level` and `$.ui.notify` are the hooks for it.
- Budgets, comparisons between runs, cost per plan step. (A spend projection for the period shipped in #483.)
- A scheduled-agent view (`CronCreate` tasks, `session_crons` on the Stop hook). A session waiting on a wake-up is only worded as such (#119); no list of schedules is shown.
- For the brain ([section 13](13-the-brain/README.md)): orchestration agents of Podium's own that run reviews, languages other than English, more than one Podium server, search by meaning (an embedding column and a store method that joins it to the terms, which would change the order inside one step of 13.4 and nothing else), a file watcher that syncs on every change, a memory limited to one agent, a scope that reaches everyone on the server, and recalled memories placed in a prompt automatically. The design must not preclude the first two. The last three are out unless the maintainer asks for them.

<!-- nav:start -->
---

Previous: [10. Rules for the implementing agent](10-rules-for-the-implementing-agent.md) · Up: [Specification](README.md) · Next: [12. Open questions and flagged assumptions](12-open-questions.md)
<!-- nav:end -->
