---
title: "One session"
description: "Read a single session's summary, plan, agent tree and detail panel."
group: "Getting started"
order: 10
---

# One session

Click a card or a rail item. The page has a summary, a plan, an agent tree and a detail panel, described below.

## The summary

- The session's goal and working directory.
- Three charts for the last minute: tokens per second (its number is the average of the last 10 seconds), the largest
  context fill in any loop with blowout markers, and subagents running.
- A bar of facts, described in the table below.
- A colored band at the bottom of the summary that says what the session is doing. The Blowouts cell in the facts bar opens
  the detail when a context window has overflowed.

| Fact | What it shows |
|---|---|
| Agents | The orchestrator counts as one. A red "N failed" button opens the first failure |
| Est. cost | Estimated cost for the whole session |
| Tokens | The context held now |
| Running time | How long the session has run |
| Agent time | The orchestrator's time plus every agent's. It is longer than running time when agents run at once |
| Machine | The machine the session runs on, as its reporter named it. "Not reported" when the session has no user name, so no machine. Hover or tab to the cell for why |
| System | The machine's operating system and version, such as `macOS 15.4`, with the same icon as My reporters. "Not reported" when the reporter did not send it: update podium-reporter, or set `userName` when the Machine is also not reported |
| Reporter | The version of the podium-reporter mod the session runs, or "Settings hooks" when it has no mod. The version shows in amber with "update" or "upgrade server" when the server says it is outside the supported range |

## The plan and Files

On the left is the plan, as a checklist with the agent that owns each step, with a **Files** tab beside it.

The plan is Claude's task list, read from its `TaskCreate` and `TaskUpdate` tools (or `TodoWrite`). If those tools are not
available to the session, or Claude does not use them for the work, the panel reads "No plan reported. Agents were
launched ad hoc." Plan mode does not change that, because Podium does not read it. See
[Gotchas](../../gotchas/session-shows-no-plan.md) for how to turn the tools on.

A plan with more than 10 steps shows 10 at a time, with page buttons under the list. The count and bar at the top still
cover every step, and the panel opens on the page with the current step.

**Files** lists every file the session changed since it started, committed or not, each with how many lines were added
and removed (a binary file shows the word "binary"), 20 to a page. The column gets wider while Files is open.

- The list comes from `git diff` against the commit the session began on, so two sessions in the same checkout see the
  same changes. Use a worktree to keep them apart.
- It needs podium-reporter 0.6.0 or later, and says so when the reporter is older.
- An archived session on the History page shows no diffs. The machine that could read them is gone, and Podium does not keep them yet.

## The agent tree

On the right is the agent tree: every subagent and fork with its task, type, model, effort, context bar (amber from 75%
full, red from 80%), tokens, cost, time and status.

- Click a column header to sort. Each agent's own agents stay under it, sorted among themselves. Click the header again
  to reverse, and **Launch order** to go back.
- The **Session** cell copies the session id.
- The **Resume** cell copies the command that continues this same session in a new terminal. Run it once the session has ended.
- The **Fork** cell copies the command that starts a copy of the conversation in a new session and leaves this one alone. Use it to ask a stuck agent "why did you do that?" without changing the session you are investigating. A fork works in the same directory, so its file edits are real, and it does not carry over permissions you allowed or flags such as `--mcp-config`. Hover a cell to read what its command does.

A subagent or a fork can launch agents of its own, and those can too.

- Each is indented under the agent that launched it, as deep as it goes. Past two levels the Task column gets wider and
  the table scrolls sideways inside its box, so the task stays readable.
- Hover a row for its full task. The caption over the tree says how many agents were launched by other agents.
- On the wall card, the squares follow the same order, and hovering a nested one names the agent that launched it.
- In Activity, a launch by another agent ends with "launched by" and that agent's task.

**Delegating.** A row that is running but has agents of its own running, such as the orchestrator waiting on a subagent,
reads "delegating" in blue with a hollow dot. Hovering it lists the agents it is waiting on.

- It is not asking anything of you. Amber and "waiting on you" are the ones that need a reply.
- The session's card on the wall says the same: the card's bottom band reads "Delegating to 2 agents." (hover it for
  their names), and the rail item shows the blue hollow dot.
- When the last of those agents finishes they go back to "Running". The status filters, the sort order and the counts
  still treat the session as running.
- Podium cannot tell an agent launched in the background from one the row is really blocked on, so a row with a
  background agent running also reads "delegating".

## An agent's detail

Click an agent to open its detail in the right panel.

- **Launched by** names the agent that launched it (click it to go there) or says "the orchestrator".
- **Est. cost** is the agent's own. The orchestrator's row shows its own share, so the rows add up to the facts bar.
- **With its agents**, for an agent that launched others, adds up the agent and every agent under it, each once.
- **Tokens** is the context it holds now. **Used so far** under it lists the running totals (input, output, cache read,
  cache write). Cache read is large because the cached context is read again on every request.
- If it failed, you get the failing call, the last lines of its output, the evidence behind the likely cause and what
  happened next.
- If its context blew out, you get a timeline of each overflow.

Click the orchestrator's own row, at the top of the tree, to open its detail. It shows the same facts as an agent's and,
with podium-reporter 0.4.0 or later, its own steps, the tools it used and the skills it loaded. Calls made by the agents
it launched are counted in those agents' panels, not here.

**Report.** The **Report** group has two buttons, **Task prompt** and **Final answer**.

- Click one to read the text in a window over the console, with markdown shown as formatting (headings, lists, code,
  links). Esc, the X or a click outside closes it, and **Copy** copies the raw text.
- A button is dimmed until there is something to show. The answer stays dimmed while the agent runs.
- By default Podium only has the first 400 characters of each, and the window says so. To see the whole text, turn on the
  mod's `fullPrompts` option (podium-reporter 0.10.0 or later). The full text then goes to the server, and everyone who
  can open the console can read it.

## The agent activity feed

The **Activity** section under an agent's detail shows what the agent is doing: its recent tool calls (the tool and a
short summary, such as the command or the file) and the text it writes between them, newest at the bottom. The
orchestrator's Activity section works the same way, for its own calls and text.

- It starts empty when you open the panel and fills from then on, every 5 seconds by default. **Refresh every** changes
  that (10, 20, 30 or 60 seconds), and your browser remembers the choice.
- Scroll up to read earlier entries and the list stops following. **Jump to latest** brings it back.
- **Expand** opens the same list in a larger window, which closes like the Report one.
- Nothing is fetched while the panel is closed or the tab is hidden. By default Podium keeps only the last 20 entries,
  only while someone is watching. Close the panel and it is gone, and opening it again starts empty. The Admin can
  choose to keep more: see [Stored history](#stored-history) below.

It needs podium-reporter 0.13.0 or later with the mod's `activityFeed` option on, and the server's **Agent activity
feed** flag on in Admin > Settings > Feature flags. Everyone who can open the console can watch, which is why the option
is off by default. The option is per machine, like the rest of the mod's options, so each person who wants the feed for
their own sessions turns it on for themselves.

### Stored history

The Admin can have Podium keep the feed for longer (Admin > Server > Data, [Data](../05-admin/10-data.md)). It is off by default, so
nothing changes unless they turn it on. When it is on, Podium stores what every running agent and the orchestrator does,
whether or not anyone is watching, until the Admin's period ends.

- The window then shows the newest stored entries with your live ones after them, and **Show older** pages back. The
  footer says how many entries are stored and since when, and the line under it says how long they stay.
- It also works for a session that has ended, until its entries are purged.
- Only the session's owner and the Admin can read stored history. Anyone else sees a line saying so, and no entries. You
  need to be signed in (the same sign-in as responding and file diffs).
- It is a record of what the reporter sent, not a complete one: the mod keeps 20 entries per loop between reports, so a
  busy session can miss some. Secrets are removed on your machine before anything is sent, and the Admin can delete
  stored history at any time ([Stored activity](../05-admin/11-stored-activity.md)).

### Turn on the feed

1. Update the mod if the section says your session reports an older version (see [Updating the mod](../09-updating-the-mod.md)).
2. In Claude Code on the machine that runs the sessions, run `/plugin configure podium-reporter@eengelking-marketplace`
   and set **Send an agent's recent activity** (`activityFeed`) to on. The same setting is in the `/config` menu, or you
   can set `activityFeed` to `true` under `pluginConfigs` in `~/.claude/settings.json`
   ([REPORTER.md](../../REPORTER.md#install-the-mod) lists where).
3. A changed setting reloads the mod, so a session that is already running should pick it up. If the panel still says the
   option is off, run `/reload-plugins` in that session.
4. Open the agent's panel. The feed starts empty and fills from that moment, because nothing is sent for an agent nobody
   is watching (unless the Admin keeps stored history, which also stores what happened before you opened the panel).
5. If the section says "The activity feed is turned off by the Admin.", the person who runs the server has switched it
   off for everyone in Admin > Settings > Feature flags. It is on by default. An open panel keeps checking and starts
   the feed again, empty, once the flag is back on. You do not need to reload.

## A session that waits on background work

A session that ended its turn but has a background shell, monitor, agent or workflow still running, or a scheduled
wake-up, is not waiting on you.

- Its card says "Waiting for 1 background shell to finish." (or "Waiting for a scheduled wake-up at 14:30."), in blue
  with a pulsing ring instead of amber.
- It stays in the Waiting filter, but it is not counted in "waiting on you".
- The card shows only that sentence. The orchestrator page adds what it is waiting on below it, cut with " ..." when it
  is long, and hovering the status lists every task.
- The moment the work ends, the card goes back to "Waiting for your input."

The reporter reads the work from the Stop hook. A shell's command is never sent.

<!-- nav:start -->
---

Previous: [Closing a background session](09-closing-a-background-session.md) · Up: [Reading the console](README.md) · Next: [Activity](11-activity.md)
<!-- nav:end -->
