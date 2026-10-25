---
title: "Data"
description: "See what Podium stores, for how long, and what you can remove."
group: "Getting started"
order: 10
---

# Data

What Podium stores, for how long, and what you can remove. It has three sections.

**Daily rollups.** The daily summaries (usage, sessions, failures and the fleet) are kept for 395 days (set
`RETAIN_ROLLUP_MS` to change that). They hold counts, tokens, cost and names, never prompts, answers, tool input or paths.

**Detail rows.** How long the detailed rows last: samples 24 hours, events and ended sessions 30 days, the Admin log 90
days. These are set with environment variables on the server (`RETAIN_SAMPLES_MS`, `RETAIN_EVENTS_MS`,
`RETAIN_SESSIONS_MS`, `RETAIN_ADMIN_LOG_MS`) and cannot be changed on this page.

**Activity history.** How long the agent activity feed is kept after a viewer leaves. The default is **Not stored**,
which is how Podium has always worked. Pick a policy from the list:

- **Purge after a set time**: hours, days, weeks or months. Entries older than that are removed.
- **Purge when the session ends**: history is kept while the session runs and removed when it ends.
- **Keep everything**: nothing is removed automatically. Use [Stored activity](11-stored-activity.md) to delete.
- An optional **size cap** in gigabytes removes the oldest entries first.

Choosing a keep policy makes every reporter send more, and makes the server store more, so a warning says so before
you save. It needs a token on the server: without one, nobody could be told apart as the person who may read it, so
the keep choices are turned off. Podium checks each save: a choice that would remove entries that are already stored,
or stop keeping history, asks first and says how many entries and how much space will go. When you stop keeping
history you can delete what is stored or leave it for later. A purge runs every few minutes, and each run that
removes something is written to the Admin log once. Under the line, the page shows the last purge and how much is
stored.

Stored text can hold anything an agent read or ran. Reporters remove secrets before they send it, but that is not a
guarantee, so deleting has to be quick and complete (below).

<!-- nav:start -->
---

Previous: [Certificates](09-certificates.md) · Up: [Admin](README.md) · Next: [Stored activity](11-stored-activity.md)
<!-- nav:end -->
