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

- **Projects and branches per person** counts the projects and git branches each person worked in. A branch counts once per person and project however many days or sessions, and the last row counts each project and branch once. The names are the ones the wall already shows, and no path is kept. The **Group** filter narrows it.
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

A fourth section, **Tokens and cache hit rate**, follows them. It shows how many tokens went in, came out and were served from the cache in each day, week or month, as a chart of the cache hit rate
and a table, with a row for the whole period and for each harness. The **cache hit rate** is the tokens read from the cache over all the input the model was given (input, cache read and cache write),
so a harness that does not report cache tokens lowers it. It has its own **Harness** filter and its own **CSV** and **JSON**. Cost estimates are unchanged.

## People and groups

How many people, groups and reporters there are, who reported in the period, who has gone quiet or never reported, and
which reporter and engine versions are in use.

**Platform and reporter version** lists the reporters heard from in the last 30 days by harness, operating system and reporter version, with whether each needs an update. The platform is the system's name the reporter
sends, without its version, host name, user name or path, and a reporter that sent none shows Not reported. The **Harness** filter narrows it, and it has its own **CSV** and **JSON**.

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
- **Model and effort mix** shows, for each day, week or month, the share of sessions on each model, or at each effort (choose with **Mix of**). The most used few get a column and the rest share one. A
  session counts once, under the model and effort it ended on, and a harness that reports no effort shows as Not reported.
- **Context fullness at the end** shows how many sessions ended under 50%, from 50% to 80% and above 80% full, and how many compacted on their own or continued after a `/clear`, with a row for each
  harness. Compacted counts what Claude Code did by itself while Podium still keeps the events (30 days), not a `/compact` you ran yourself, and a `/clear` starts a new session, so each one is counted once, on the session it started.

Waiting is recorded from the release that added it, so earlier days show a dash and the page says from which day it starts. Each table has its own **CSV**
and **JSON** in its title line. Only the kind of wait and the time are kept, never what the question, plan or tool was.

## Harness updates

What stopped arriving after Claude Code or OpenCode updated, so you learn about a break before a person does. It covers every harness, the **Harness** filter narrows it, and **CSV** and **JSON** download the first table with the harness in every row.

- **Features that stopped** lists each hook, event field or tool name that a newer version of a harness no longer sends, beside the version that lost it. For each it shows the share of sessions that sent it on the
  version before and on this one, the reporters on that version on the last day of the period, and what you lose in the console (for example, "Permission prompts are not counted"). A feature is listed once, against the first version
  that lost it, when at least a quarter of the earlier version's sessions sent it, under a tenth of that share send it now, and the new version has at least 20 sessions and 2 reporters. A version that changed nothing is not listed,
  and the page says "Nothing has stopped". A reporter older than 1.6.0 sends no hook counts, so it is left out of the comparison and never looks like a break. A tool name that stops may only mean people stopped using it.
- **Reporters behind the newest version** counts, for each period, the reporters on a version older than the newest Podium had seen for that harness, as a chart and a table with a row for each harness. A harness is only compared with itself.
- The top bar shows `N features stopped after a harness update` next to "reporters need an update", only while Admin is unlocked. Click it to open this page.

Only names and counts are kept: never a value, an argument, a path or a prompt.

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
- **Tool failures** shows how many calls of each tool failed and what share of its calls that is, most failures first, with
  the biggest as bars. A tool a person or a rule refused did not run, so it is not a failure. An MCP server opens to its tools.
  The **History** column opens the sessions that recorded the failure while Podium still holds them (30 days). A failure
  older than that, or in a session you cannot open, shows counts only.
- **Permission prompts** shows how often each tool asked before it ran, and how the ask ended: allowed, denied, or no answer
  (the session ended first). **Answered in Podium** counts the asks answered from the console, whether allowed or denied. A tool
  you have already allowed does not ask, so it is not counted. A plan's approval and a question are not permission prompts.
- **Call duration** shows the middle call (median) and the slower twentieth (95th percentile) of each tool, slowest first. A
  call is timed from when it starts running to when it ends, so a call that waited for an answer to its permission prompt
  includes the wait, and a Task call lasts as long as the agent it launches. The lengths are grouped in steps of 10%, so a figure
  is within 10% of the real one. A harness that does not report call times is left out, and the page says which.
- **Skills** shows how often each skill was used (the sessions that used it, by harness, and how many different people ran them). Only the skill's name is kept. The reporters see skills, not other slash commands such as `/clear`, so those are not listed.
- **Harness versions** shows how many reporters ran each version in each period, and how many run an older version than the
  newest Podium has seen for that harness. A harness is only compared with itself.

- **Cost per tool call and per session** divides spend by the calls and sessions behind it, for each model and harness, using your Model prices. A model without a price shows a dash, and its
  calls are counted apart, so they never pull a total down. **A tool has no cost of its own:** a model call costs tokens, and a call to a tool is one step in it, so Podium cannot say what one tool
  spent. Per call is a model's spend over all its tool calls.
- **What sessions that used a tool cost** lists each tool with how many sessions called it and the average priced spend of those sessions. It tells you where heavy sessions use a tool, not what the
  tool cost.

Calls include the orchestrator's own as well as its agents'. The tool counts start when Podium is upgraded to this release and fill in for the sessions it still holds (30 days), so a
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
