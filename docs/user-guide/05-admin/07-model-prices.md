---
title: "Model prices"
description: "Edit the per-model prices that every cost in Podium is worked out from."
group: "Getting started"
order: 7
---

# Model prices

One row per model with five prices in US dollars per million tokens: input, output, cache read, cache write for 5 minutes
and cache write for 1 hour. They start as the prices on Anthropic's pricing sheet (the date is shown).

- Edit a price and click **Save**. Every cost in Podium (the wall, each orchestrator, **Est. cost today** and History)
  changes to match at once, including for sessions already running, and the change stays after a restart.
- A changed row shows **Changed** and a **Reset to built-in** button.
- Haiku 5.5 has a second row for prompts over 100,000 tokens, which cost more.
- To price a model Podium has no price for, such as a local model, type its id in **Model id** under **Add a model**, fill
  in the five prices and save. Until then its cost reads "n/a".
- Cache writes use the 5-minute price unless Claude Code reports which writes were 1-hour ones.

<!-- nav:start -->
---

Previous: [Settings](06-settings.md) · Up: [Admin](README.md) · Next: [Security](08-security.md)
<!-- nav:end -->
