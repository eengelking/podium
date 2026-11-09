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

Two sections follow it, for every harness that reports. The **Harness** filter narrows them, and the report above them is not kept per harness, so it
covers every harness and the page says so.

- **Sessions per person per day** gives each person's days active, sessions, sessions per active day and their busiest day. The last row counts
  everyone in the filter. The **Group** filter narrows it.
- **Busiest hours** is the most sessions live at once in each hour of the day, over the period, as a chart or a table. It counts every session, so
  the Group filter does not apply to it.

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

Four sections follow it, for every harness that reports. The **Harness** filter narrows them. The report above them is not kept per harness, so it
covers every harness and the page says so. These four are kept for everyone together, so while a **Person**, **Group** or **Model** filter is set the page
says that and leaves them out.

- **Length and waiting** shows how long sessions ran and how much of that they spent blocked on a person: a tool asking for permission, a plan waiting for approval
  or a question waiting for an answer. A session sitting at the prompt is not counted, and neither is a wait for background work or a timer. It gives the average and
  longest length, the time waiting and its share of session time, for each day, week or month, with a row for the whole period and for each harness. Waiting is
  measured from the reports a session sends, so it is counted to the reporting interval.
- **What sessions waited for** splits that waiting into permission, question and plan: how many waits, how long they took and the average.
- **Agents launched** counts agents by type, with a column for each harness.
- **How deep agent chains go** counts agents by how many levels down they sit. Depth 1 is an agent the session launched itself.

Waiting is recorded from the release that added it, so earlier days show a dash and the page says from which day it starts. Each table has its own **CSV**
and **JSON** in its title line. Only the kind of wait and the time are kept, never what the question, plan or tool was.

## Tools

Which tools sessions call, how many calls a session makes, and which versions of each harness are running. It covers every
harness that reports (Claude Code and OpenCode today), and the **Harness** filter narrows it to one. Only tool names and
counts are kept: never the arguments, a file path or a command.

- **Tool calls** shows the calls in each day, week or month, with the number of sessions and the median and 90th percentile of
  calls per session.
- **Calls by tool** lists each tool with a column for each harness. An MCP server is one row with its total; open it to see
  its tools, which add up to the row. **CSV** and **JSON** download this table, with the harness in every row.
- **Calls per session** gives the middle session and the busier tenth, for each period and for the whole period by harness.
  Sessions with more than 100 calls are grouped, so those figures can be a few calls off. A session with no tool counts is
  left out, so older sessions do not pull the middle down to zero.
- **Harness versions** shows how many reporters ran each version in each period, and how many run an older version than the
  newest Podium has seen for that harness. A harness is only compared with itself.

The tool counts start when Podium is upgraded to this release and fill in for the sessions it still holds (30 days), so a
longer period says "Podium has no history before ..." instead of showing zeros.

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
