---
title: "24. An agent's activity is sent only while someone watches it, and never kept"
description: "An agent's activity is captured only while someone watches the panel, held in memory and never stored, which protects privacy but loses history."
group: "Project internals"
number: 24
date: "2026-10-13"
status: "accepted"
order: 24
---

# 24. An agent's activity is sent only while someone watches it, and never kept

*Amended by 39 (#432): the Admin can now choose to keep it. The default, and everything below, is unchanged.*

**Decision.** The activity feed (#118) has its own reporter option, `activityFeed`, off by default and
separate from `fullPrompts`.

- With it on, nothing is captured, sent or stored for a loop until a viewer opens its panel. The panel's
  fetch takes a short lease on the server, the reply to each report lists the leased loops (`watch`), and
  the mod captures only those.
- The server keeps the last 20 entries in memory. It drops them when the lease lapses (the viewer's interval
  plus 15 seconds), when the session leaves or on restart, and never keeps an entry older than the lease, so
  a viewer who comes back starts empty. There is no table and no history.
- The panel fetches on the viewer's interval (5 seconds by default) only while it is open and the tab is
  visible.
- Tool calls and the text between them are sent. The model's thinking is not.

**Why.**

- What an agent is doing right now is more sensitive than its task prompt or answer, and everyone who can
  open the console can read it, so it gets its own switch and is off unless asked for.
- Capturing only what someone is looking at keeps the cost at zero for the many agents nobody watches, keeps
  the reports small, and means there is nothing to retain, export or leak afterwards.
- The question it answers, "where is this agent in its work", is about now, so a history adds little.
- Thinking may come summarized or not at all depending on the model, and is the most private part.

**Cost.**

- A viewer sees nothing from before they opened the panel, and the first entries arrive one report cycle
  after the lease starts (about a second, more on a long interval).
- Two viewers share one lease, so a slow viewer keeps a loop watched for longer than a fast one alone would.
- A restart of the server loses every feed.
- The reports of a watched loop carry up to 20 entries of 300 characters again on every report, because
  reports are full snapshots.

<!-- nav:start -->
---

Previous: [23. The server prices tokens, with prices the Admin can change](23-the-server-prices-tokens-with-prices-the-admin.md) · Up: [Decisions](README.md) · Next: [25. The Admin can switch the activity feed off for the whole server](25-the-admin-can-switch-the-activity-feed-off.md)
<!-- nav:end -->
