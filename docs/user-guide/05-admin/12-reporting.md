---
title: "Reporting"
description: "Report who used Podium, what it cost and what went wrong for a period you pick."
group: "Getting started"
order: 12
---

# Reporting

The Reporting pages answer "who used this, what did it cost, and what went wrong" for a period you pick, and let you
take the answer into a document or ticket. They read daily summaries Podium keeps, so a report can reach back further
than the 30 days of sessions and events that Podium holds. Only an Administrator opens them.

Every Reporting page works the same way:

- **Period and filters.** Choose a period (the last 7, 30 or 90 days, this month, last month, or custom dates), whether to
  count by day, week or month, and, where the page has them, a person, group or model. The page opens on the last 30
  days by day. Your choice is remembered in this browser.
- **What it is based on.** A line under the filters gives the time zone (days are the server's calendar days; weeks start
  on Monday), what the figures are built from and how far back the data goes. If you ask for a period that starts before
  that, the page says "Podium has no history before ..." and shows only what it has. It never fills the gap with zeros.
- **Export.** **CSV** and **JSON** download exactly the table you are looking at, for the same period and filters.
  **Print** prints the page without the menu.
- Costs are estimates from tokens, not a bill. A model without a price shows a dash and is left out of the totals.

## Usage

Active people, active reporters, sessions started and the most sessions live at once, for each day, week or month.

## Spend

Three sections.

- **Spend today** is what each person, or each group, has spent since midnight on the server, live or ended sessions, as
  bars or as a table.
  - Choose **People** or **Groups** and **Chart** or **Table**.
  - The total spent and the number of live sessions are at the top right. The list is largest first, 25 rows at a time.
  - The total and the table's Total row always count everyone, not just the page you are on, and the total equals the
    "Est. cost today" tile.
  - Someone whose sessions have all ended still has a row, but no band on the wall.
  - **Click a person** to see what their number is made of: by session (each with a link to it in History), by model,
    and the orchestrator against the agents it launched. Each cut adds up to the row. Sessions on a model without a price
    show a dash and are counted in a line under the breakdown, so the priced parts still add up to the row. Click a
    **group** to see its people first.
- **Projection** estimates spend to the end of the month, or for the next 30 days, from a straight run rate over the last
  7, 14 or 30 complete days. It shows the window, the run rate per day and the assumptions beside the number. It does
  not allow for weekdays, a trend or a price change, and it is not a budget. With fewer than 7 days of history, or for
  someone who was active on fewer than 3 of the days in the window, it says "Not enough history" instead of a number.
- **Spend over time** gives total spend by day, week or month, and can break it down by person, group, model or project.
  A session counts on the day it was last seen, so one that runs past midnight is not split.

## People and groups

How many people, groups and reporters there are, who reported in the period, who has gone quiet or never reported, and
which reporter and engine versions are in use.

## Reporting sessions

Counts by outcome, model, effort or plan, with average and longest duration, agents launched per session, and how many
sessions hit a context blowout.

## Failures

Counts of failures by class, tool or person over time, to help find a root cause. For sessions Podium still holds (30
days), a row links to one in History; older failures show counts only.

## Admin activity

The Admin log, filtered by kind and period: token rotations, revocations, settings changes and so on. Entries go back 90
days.

<!-- nav:start -->
---

Previous: [Stored activity](11-stored-activity.md) · Up: [Admin](README.md) · Next: [Admin log](13-admin-log.md)
<!-- nav:end -->
