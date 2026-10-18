# User guide

How to set up Podium, read the dashboard and fix common problems.

Podium shows every Claude Code session on your machine in one browser tab. It watches. It never sends a prompt to a
session, stops an agent or changes anything, unless you turn on [answering from Podium](#answering-a-session-from-podium).

Related docs: [REPORTER.md](REPORTER.md) for the mod's options, [SERVER.md](SERVER.md) for the server's settings and
[GOTCHAS.md](GOTCHAS.md) for sharp edges.

## Contents

**Get started**

- [What you need](#what-you-need)
- [Set it up](#set-it-up)
- [Something is wrong](#something-is-wrong)

**Use the dashboard**

- [Reading the dashboard](#reading-the-dashboard)
- [The wall](#the-wall)
- [The board](#the-board)
- [People](#people)
- [Sessions that have not done anything yet](#sessions-that-have-not-done-anything-yet)
- [Closing a background session](#closing-a-background-session)
- [One session](#one-session)
- [Activity](#activity)
- [Answering a session from Podium](#answering-a-session-from-podium)
- [History](#history)
- [What the numbers mean](#what-the-numbers-mean)

**Run it**

- [Admin](#admin)
- [Everyday commands](#everyday-commands)
- [Logs](#logs)
- [Sessions you started without the mod](#sessions-you-started-without-the-mod)
- [Updating the mod](#updating-the-mod)
- [What leaves a session](#what-leaves-a-session)
- [Remove it](#remove-it)

## What you need

- Claude Code, to run the sessions you want to watch.
- Node 24 and npm, to get the server and `podiumctl`.
- Podman, if you want the server in a container (recommended). Without it, `podiumctl` runs the server as a plain Node
  process.

## Set it up

There are two parts: the server (the dashboard) and the reporter mod (inside each Claude Code session).

### 1. Start the server

```sh
git clone https://github.com/eengelking/podium.git && cd podium && npm link
podiumctl start
```

The first start builds the container image, generates an auth token and saves it to `~/.podium/config.env`. The
dashboard is at http://127.0.0.1:4317/#/.

- **Plain Node process instead of a container.** Run `podiumctl build --mode standalone` once, then
  `podiumctl start --mode standalone`.
- **Start when you log in.** Run `podiumctl enable`.

### 2. Install the reporter mod

In Claude Code:

```
/plugin marketplace add eengelking/skills
/plugin install podium-reporter@eengelking-marketplace
```

Then give it the token:

1. Print the token with `podiumctl token`.
2. Enter it with `/plugin configure podium-reporter@eengelking-marketplace`.

If someone else runs the server, ask them for your own token and enter it as `token`, with your name as `userName`
(see [Admin](#admin)). To run one server for several people, see "Several people on one Podium" in
[SERVER.md](SERVER.md#run-it-with-podiumctl). It covers the bind address, the firewall, the names the server accepts
(`PODIUM_ALLOWED_HOSTS`, for reaching it by a name rather than an address) and what everyone who can reach the server
can see.

**One saved login per machine.** The sign-in you do with `/plugin configure` holds one name and one token for the whole
Claude config on that machine, so every terminal there shares it. Signing in again as someone else in one terminal
changes it for the sessions you start afterwards, and cannot give two terminals different logins. This is a limit of
Claude Code, not of Podium. It gives a reporter one set of settings per config, no place to keep a login for a single
session, and it tells every running session when they change. A later Claude Code release may add one, and Podium will
use it when it does (#230).

To report as two Podium identities from one machine (say Admin in one terminal and yourself in another), start each
terminal with its own name and token:

```bash
PODIUM_USER=Ed PODIUM_TOKEN=<Ed's token> claude
```

When either variable is set, the session uses them and ignores the `userName` and `token` options. A session keeps the
identity it started with, so changing the options later does not turn a running session into someone else. To change
who a session reports as, start a new one.

### 3. Check that it works

1. In a session, run `/podium`. You should see `Connection: online`.
2. Send the session a prompt.
3. Look at the browser. A session appears within a couple of seconds of doing its first bit of work, not before.

The status line tells you where you are:

| Status line | Meaning |
|---|---|
| `podium vX.Y.Z ● 0 live` | Connected, but no session has done any work yet. See [Sessions that have not done anything yet](#sessions-that-have-not-done-anything-yet) |
| `podium vX.Y.Z ● 1 live` | Connected, and one card is on the wall |
| `podium vX.Y.Z ○ offline` | Not connected. See [Something is wrong](#something-is-wrong) |

A name you give a session in Claude Code, for example with `/rename`, is its title on the card, the rail and the
orchestrator page, from your next prompt. `/podium name <text>` sets a name too, and wins over it. The card and the
orchestrator page also show the first eight characters of the session id. Click it to copy the whole id.

## Something is wrong

Find what you see, then follow the fix. [GOTCHAS.md](GOTCHAS.md) has more.

| You see | Likely cause and fix |
|---|---|
| `/podium` says offline, `HTTP 401` | The token is missing, wrong or revoked, or it does not belong to the `userName` setting. Run `podiumctl token`, then `/plugin configure`. On a shared server, ask the owner for a new token |
| `/podium` says offline, no 401 | The server is not running. Run `podiumctl status`, then `podiumctl start` |
| The wall is empty | No session has the mod loaded yet, its token is wrong, or none has been sent a prompt |
| A new session is not on the wall, or its status line says `podium ● 0 live` | It has not done anything yet. Send a prompt |
| A session I closed is still on the wall | It moved to the background. `claude agents` lists it and `claude stop <id>` ends it. See [Closing a background session](#closing-a-background-session) |
| A card turned stale | The session stopped reporting (closed, crashed or lost the connection). It goes away by itself, or press Remove |
| I changed the config and nothing happened | Run `podiumctl restart` |
| A card shows `reporter 0.1.0 · update`, the top bar says reporters need an update, or the status line ends in `· update mod` | The mod in that session is older than the server supports. It keeps reporting meanwhile. See [Updating the mod](#updating-the-mod) |
| The status line ends in `· update available` | Your mod works, but the server supports a newer one. See [Updating the mod](#updating-the-mod) |
| A card or the status line shows `· upgrade server` | The mod is newer than the server supports. Upgrade the server (see [Updating the mod](#updating-the-mod)) |
| The status line starts with `⚠` (`⚠ podium v1.1.0 ● 6 live`) | The mod's server URL is `http://` to another machine, so its token is not encrypted in transit. Put a TLS proxy in front of Podium and set the server URL to `https://...` in the podium-reporter settings, or accept the risk on a network you trust. Reporting continues |

**Asking for help or filing a bug.** Include the output of `/podium` and of `podiumctl status`.

1. Type `/podium` inside the Claude Code session that shows the problem. It is not a shell command like `podiumctl`.
2. Paste what it prints, with the output of `podiumctl status`.

The `Connection:` and `Versions:` lines say whether the mod is online, refused or out of step with the server. It does
not print your token, but check what you paste and remove any token or other secret before posting.

## Reading the dashboard

The dashboard has a top bar, a left rail and a right panel.

- **Logo.** The Podium logo at the top left is a link home. From History or Admin it takes you back to the fleet page.
- **Top bar.** A pill names the page ("Fleet" on the wall, "Orchestrator" on a session's page, "History", "Admin"),
  then the connection (`N reporters live`, or a red "disconnected, retrying"). Admin's top bar shows the same
  connection indicator beside its "Admin" pill.
- **Row under the top bar.** It has the theme picker.
- **Left rail.** It lists your sessions.
- **Right panel.** It shows [activity](#activity).

Drag the handles between the columns to resize them.

### Themes

Pick a color theme from the Theme dropdown in the row under the top bar: Podium, Solarized, Nord, Gruvbox, Catppuccin
or GitHub. Then choose Light, Dark or System for it. System follows your operating system and changes with it.

- Podium is the default.
- Your choice is kept in this browser. A light or dark choice from an older version carries over as Podium in that mode.
- The palettes belong to their authors. They are credited under Theme credits at the bottom left of the left rail, next
  to a License link, and in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- The same footer shows the version of the server you are looking at, for example `Podium v0.1.0`, so you can tell
  which build is live.

### Wall display

For a wall display, collapse what you do not need.

| Part | Button | Key |
|---|---|---|
| Left pane | Its own button | `[` |
| Right pane | Its own button | `]` |
| Top bar | Its own button | `\` |
| All three (**Wall mode**) | The button in the top right | `w` |

- A collapsed pane leaves a slim tab to open it again, and the pane returns to the width you had. Your choice is
  remembered.
- Wall mode collapses all three at once and asks the browser for fullscreen. Leave it with `Esc` or the Exit wall mode
  button, and everything goes back to how it was.
- After a few seconds without movement the cursor and the buttons hide. Move the mouse or press a key to bring them
  back.
- If the connection to the server is lost, a red alert stays on screen even with everything collapsed.
- Below 1040 px wide the panes stack, and the buttons fold a stacked section instead.

### What it costs to run

The more sessions and agents report, the more Podium needs. Every agent adds data that the server stores and sends to
the browser, and the browser draws it.

- The server's CPU and memory (ingest, SQLite, the state sent to every client) are used whether or not a browser is open.
- The browser's CPU, memory and GPU are used by each open tab.

As one example, Chrome on an M5 MacBook Pro used about 24% GPU with ten simulated sessions and a hundred agents on
screen, against about 15% for a plain page. That is one machine and one browser, not a promise.
`scripts/gpu-sample.sh` (macOS) measures your own.

To lower it:

- Choose a longer **Refresh every** (in the bar above the wall, left of Theme). The page then redraws once every 5 to 60
  seconds instead of every 2, and anything that needs you still shows at once.
- Keep fewer sessions on screen.
- Leave the tab hidden. Animations pause while it is.
- Use wall mode, which hides the side panes and top bar so the browser stops drawing them.
- Close the dashboard when nobody is looking.

### The wall

The default view (`#/`) is a card per session. At the top are six tiles: Orchestrators live, Subagents running, Context
blowouts, Plan steps done, Est. cost today and Tokens, last minute. Below them you can:

- filter by status (All, Running, Waiting, Stale, Blowouts),
- sort (Status, Model, Context blowouts, Context used, Cost, Newest),
- search by name, project or branch.

#### What a card shows

- The session's name and status.
- Its project and git branch (or worktree, with ahead and behind counts and how many files changed).
- Its model, effort and context fill.
- Its plan with the current step, or "No plan reported. Agents were launched ad hoc." (see
  [Gotchas](GOTCHAS.md#a-session-shows-no-plan)).
- A strip with one square per agent.
- Its cost, tokens and running time.

Tokens is the context the session and its agents hold right now, the same figure Claude Code shows for an agent. Hover it
for the definition. A path or branch that is too long for the card is shortened (the path from the front, the branch at
the end). Hover it to see the full value.

#### Card states

| State | What it means |
|---|---|
| Red callout | The session has blown out its context window twice or more, which usually means it has lost context |
| **Waiting** | The session wants you: a permission prompt, a question, or the end of its turn. The card says whether it needs your approval or your input |
| **Stale** | The session has stopped reporting. The card says how long until it goes away by itself |

A stale card has a **Remove** button (also on its rail row, and **Remove now** on its page) to clear it at once. The
session stays in History, and the card comes back if the session reports again.

### The board

**Board** in the top bar (`#/board`) shows every session's plan steps as cards in five columns: Pending, In progress,
Review, Blocked and Done. It answers "what is in progress across all my sessions?" without opening each one.

Each card is titled with its orchestrator, shows the work under it, and names the agent doing it at the bottom. Click a
card to open its orchestrator. You cannot move a card: the state comes from Claude Code, and Podium only watches.

- **Review** holds an in-progress step while its session waits on you (a question, a plan or a permission prompt). A
  session that waits on you but has no plan shows as one card there. A Review card says why: the question it asks, or
  the tool it wants to use.
- A card that changes column slides across and flashes for a moment.
- **Mixed** shows every orchestrator's cards together. **By orchestrator** groups them. **Me** (only while you are
  signed in) shows just your sessions.
- A column shows 25 cards a page. Use the page buttons at its foot.
- A session with no task list, or with every step done and finished, is listed under the board. Click the (i) there to
  see how to get a plan.
- The board opens with the left and right panels collapsed so the columns get the width. Open either from its edge tab.
  The board remembers that apart from the fleet page.

### People

When several people report to one Podium with their own tokens (see [Admin](#admin)), the console groups their sessions.
Nothing changes until a session reports with a person's token. Sessions sent with the admin secret, or to a server with
no token, keep the plain wall.

The row with the filters then gains a **People** group:

- **Group by**: People (a band per person), Group (a band per group from Admin) or All (the plain wall, with the owner on
  each card). When you are signed in as a person there is also **Me**: the plain wall with just your own orchestrators.
- **Order by**: Needs attention (your own band first, then whoever has the most sessions waiting or stale), Spend, or
  Name. It orders the bands, and is hidden for All and Me. **Sort by**, beside the filters, orders the cards inside each
  band.

#### Who you are

Podium knows who you are from your sign-in (the **Sign in** button in the top bar, the same one you use to respond).
Signing in needs the Admin to have turned on responding.

- Signed in as a person, your band is marked "you" (your group's band "your group") and comes first under Needs
  attention, and **Me** is offered.
- Signed out, or signed in as Admin, there is no "you" and no Me.

#### A person's band

A band header shows their initials and name, their group, the machines their sessions run on, how many are live, how
many are waiting or stale, and their share of today's estimated spend.

- Click the header to fold the band to that line. Podium remembers which bands you folded.
- Each card in the band says which machine it runs on. One person on two machines is one band. When two of their
  machines have the same name, the card adds the start of the machine's id.
- Sessions reported with the admin secret are in an **Admin** band.
- Sessions with no owner (only possible on a server with no token) are under **Unassigned**, after everyone else.
- In Group, people without a group, Admin and Unassigned are under **No group**, and a group with no live sessions has
  no band.

The left list groups the same way. Click a person or group there to show only theirs on the wall. Click it again, or
click **All orchestrators**, to see everyone again. Spend by person or group is in Admin, under **Spend**.

When the window is narrow the row makes room in order. The "N shown · M cleared today" caption becomes an info icon
(hover it to read the words), then the People group moves to a line of its own under the filters. Nothing is hidden.

A person is shown as initials and a name, never a color, because color already means the model and the status.

### Sessions that have not done anything yet

A session is put on the wall once it has done something: it is running, or it has tokens, cost, context use, a blowout,
an agent or a plan. Until you send it a prompt it is not shown, and the status line in a fresh session reads
`podium ● 0 live`. This is on purpose.

Claude Code's background daemon runs sessions you did not start by hand. On Claude Code 2.1.296 we saw a parked
background twin of each interactive window and a pool of pre-warmed spare processes. Every one of them loads the
reporter and reports itself as a session, so a single window could put three identical "waiting on you" cards on the
wall. Podium keeps the ones that have done nothing off the wall, out of the activity feed and out of the history, and
shows them the moment they start work. The rule is in [SPEC 7.5](SPEC.md).

What that means in practice:

- Open Claude Code in a project: no card yet. Send a prompt and one card appears.
- The `N` in `podium ● N live` is the number of cards on the wall, not the number of Claude Code processes on your
  machine.
- After `/clear` the old card ends and the new session gets a card once you send its first prompt.
- Sessions you started without the mod, reported through settings hooks, are never hidden this way, because hooks carry
  no token or cost figures to judge them by.

#### A card after you close the window

A card can stay on the wall after you close the window. Closing Claude Code can leave the conversation running in the
background (the window says "Your conversation moved to the background"). That is a real session and it stays until it
ends. See [Closing a background session](#closing-a-background-session) to list and end it.

A session with no window on it is marked:

1. After `/exit`, the card turns dashed and muted with a "nobody attached" chip and a countdown.
2. After `DETACHED_HIDE_AFTER_MS` (a minute by default) it leaves the wall. A note at the bottom of the wall says how many
   background sessions are hidden and what they cost, with a Show them link. It still counts in the totals and in
   History.
3. Run `claude attach` and the card comes back as a normal card at once.

Close the note with its X to turn it off. Admin > Settings turns it back on and can also keep background sessions on the
wall. A one-off `claude -p` run reads the same way, because it never has a window. This needs the mod at 0.7.0 or later.
An older mod's sessions are never marked.

### Closing a background session

Podium cannot close a session for you. Claude Code can:

1. **List them.** `claude agents` opens Claude Code's agent view, with each background session and whether it needs
   input. For a plain list, run `claude agents --json --cwd ~/dev/skills` (use your own project directory). Each entry
   has an `id`, a `name` and a `state`. Add `--all` to include finished ones.
2. **Match the card to the session.** Look for the project directory and the name. Do not match on the id shown on a
   card. A card shows the session id, which changes on `/clear`, while the commands below take the background session's
   own `id` from the list. After a `/clear` the two differ (a card might read `ba37e9d6` for the session
   `claude agents` calls `ee780da5`).
3. **End it.** `claude stop <id>` stops the session and keeps its conversation, so `claude attach <id>` can open it again
   later. The card leaves the wall a few seconds after it stops.
4. **Or delete it.** `claude rm <id>` deletes the session and its worktree, and works on sessions that have already
   exited. If the worktree has unpushed commits or uncommitted changes, `claude rm` reports them and does not discard
   them unless you pass the flag it prints. Use `stop` when you only want it off the wall.

Two more commands help:

- `claude attach <id|name>` opens one in the current terminal. The arrow-left key returns to the agent view, and Ctrl+Z
  drops back to your shell.
- `claude logs <id|name>` prints its recent output.

`attach` and `logs` accept part of the name, but `stop` and `rm` need the id. These are Claude Code's commands, so
`claude <command> --help` is the final word if they change.

### One session

Click a card or a rail item. The page has four parts.

#### The summary

- The session's goal and working directory.
- Three charts for the last minute: tokens per second (its number is the average of the last 10 seconds), the largest
  context fill in any loop with blowout markers, and subagents running.
- A bar of facts, described in the table below.
- A colored band at the bottom of the summary that says what the session is doing. Blowouts opens the detail when a
  context window has overflowed.

| Fact | What it shows |
|---|---|
| Agents | The orchestrator counts as one. A red "N failed" button opens the first failure |
| Est. cost | Estimated cost for the whole session |
| Tokens | The context held now |
| Running time | How long the session has run |
| Agent time | The orchestrator's time plus every agent's. It is longer than running time when agents run at once |
| Reporter | The version of the podium-reporter mod the session runs, or "Settings hooks" when it has no mod. The version shows in amber with "update" or "upgrade server" when the server says it is outside the supported range |

#### The plan and Files

On the left is the plan, as a checklist with the agent that owns each step, with a **Files** tab beside it.

The plan is Claude's task list, read from its `TaskCreate` and `TaskUpdate` tools (or `TodoWrite`). If those tools are not
available to the session, or Claude does not use them for the work, the panel reads "No plan reported. Agents were
launched ad hoc." Plan mode does not change that, because Podium does not read it. See
[Gotchas](GOTCHAS.md#a-session-shows-no-plan) for how to turn the tools on.

A plan with more than 10 steps shows 10 at a time, with page buttons under the list. The count and bar at the top still
cover every step, and the panel opens on the page with the current step.

**Files** lists every file the session changed since it started, committed or not, each with how many lines were added
and removed (a binary file shows the word "binary"), 20 to a page. The column gets wider while Files is open.

- The list comes from `git diff` against the commit the session began on, so two sessions in the same checkout see the
  same changes. Use a worktree to keep them apart.
- It needs podium-reporter 0.6.0 or later, and says so when the reporter is older.

#### The agent tree

On the right is the agent tree: every subagent and fork with its task, type, model, effort, context bar (amber from 75%
full, red from 80%), tokens, cost, time and status.

- Click a column header to sort. Each agent's own agents stay under it, sorted among themselves. Click the header again
  to reverse, and **Launch order** to go back.
- The **Resume** cell (Copy command) copies the command that resumes the session.

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

#### An agent's detail

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

- Click one to read the text in a window over the dashboard, with markdown shown as formatting (headings, lists, code,
  links). Esc, the X or a click outside closes it, and **Copy** copies the raw text.
- A button is dimmed until there is something to show. The answer stays dimmed while the agent runs.
- By default Podium only has the first 400 characters of each, and the window says so. To see the whole text, turn on the
  mod's `fullPrompts` option (podium-reporter 0.10.0 or later). The full text then goes to the server, and everyone who
  can open the console can read it.

#### The agent activity feed

The **Activity** section under an agent's detail shows what the agent is doing: its recent tool calls (the tool and a
short summary, such as the command or the file) and the text it writes between them, newest at the bottom. The
orchestrator's Activity section works the same way, for its own calls and text.

- It starts empty when you open the panel and fills from then on, every 5 seconds by default. **Refresh every** changes
  that (10, 20, 30 or 60 seconds), and your browser remembers the choice.
- Scroll up to read earlier entries and the list stops following. **Jump to latest** brings it back.
- **Expand** opens the same list in a larger window, which closes like the Report one.
- Nothing is fetched while the panel is closed or the tab is hidden. Podium keeps only the last 20 entries, only while
  someone is watching. Close the panel and it is gone, and opening it again starts empty.

It needs podium-reporter 0.13.0 or later with the mod's `activityFeed` option on, and the server's **Agent activity
feed** flag on in Admin > Settings > Feature flags. Everyone who can open the console can watch, which is why the option
is off by default. The option is per machine, like the rest of the mod's options, so each person who wants the feed for
their own sessions turns it on for themselves.

To turn it on:

1. Update the mod if the section says your session reports an older version (see [Updating the mod](#updating-the-mod)).
2. In Claude Code on the machine that runs the sessions, run `/plugin configure podium-reporter@eengelking-marketplace`
   and set **Send an agent's recent activity** (`activityFeed`) to on. The same setting is in the `/config` menu, or you
   can set `activityFeed` to `true` under `pluginConfigs` in `~/.claude/settings.json`
   ([REPORTER.md](REPORTER.md#install-the-mod) lists where).
3. A changed setting reloads the mod, so a session that is already running should pick it up. If the panel still says the
   option is off, run `/reload-plugins` in that session.
4. Open the agent's panel. The feed starts empty and fills from that moment, because nothing is sent for an agent nobody
   is watching.
5. If the section says "The activity feed is turned off by the Admin.", the person who runs the server has switched it
   off for everyone in Admin > Settings > Feature flags. It is on by default. An open panel keeps checking and starts
   the feed again, empty, once the flag is back on. You do not need to reload.

#### A session that waits on background work

A session that ended its turn but has a background shell, monitor, agent or workflow still running, or a scheduled
wake-up, is not waiting on you.

- Its card says "Waiting for 1 background shell to finish." (or "Waiting for a scheduled wake-up at 14:30."), in blue
  with a pulsing ring instead of amber.
- It stays in the Waiting filter, but it is not counted in "waiting on you".
- The card shows only that sentence. The orchestrator page adds what it is waiting on below it, cut with " ..." when it
  is long, and hovering the status lists every task.
- The moment the work ends, the card goes back to "Waiting for your input."

The reporter reads the work from the Stop hook. A shell's command is never sent.

### Activity

The right panel lists what just happened, newest first, 12 at a time. Click a row to jump to the session and agent it is
about. Rows for sessions that have ended are greyed out.

| Row | When |
|---|---|
| Yellow, "Waiting for your approval." or "Waiting for your input." | A session is waiting on you (a permission prompt or a question). A chip under it names the tool, such as `Bash` or `AskUserQuestion`. Once the session moves on, the row turns plain and reads "Waited for your approval." |
| Blue, for example "Waiting for 1 background shell to finish." | A session is idle on background work. A chip names the kind of work (`shell`, `agent`, `wake-up`) |
| Plain sentence, such as "Session ended (cleared)." | A turn that ended after a failing call, a session ending or starting, or an agent seen only by settings hooks |

### Answering a session from Podium

When a session stops to ask you something, its amber band gets a **Respond** button at the right end, on the card and on
the orchestrator page. It opens the Activity modal with the question, the plan or the tool's request under the feed, and
a message box at the bottom. The terminal keeps working the whole time, and whichever answers first wins.
`mockup/podium-respond.html` shows every case.

#### Turn it on

It is off until all of these are on:

- The server's **Respond from Podium** switch (Admin > Settings > Feature flags).
- The server's **Agent activity feed** switch next to it.
- On the session's machine, the mod's **Respond from Podium** option (`respond`) together with **Send an agent's recent
  activity** (`activityFeed`). Set the option in Claude Code with `/plugin configure podium-reporter@eengelking-marketplace`.

It also needs podium-reporter 0.14.0 or later and a server started with a token. The `respond` option has four levels:

| Level | What can be answered |
|---|---|
| `off` | Nothing. This is the default |
| `questions` | Answers to questions, and new messages while idle |
| `questions-and-plans` | The above, plus approving or rejecting a plan |
| `everything` | The above, plus allowing or denying a tool (allow once only), and `/clear`, `/compact` |

#### Sign in

To answer, sign in with your name and token, the same ones as the mod's `userName` and `token` options. An Admin can use
the name **Admin** with the admin secret. Sign in from the modal or from **Sign in** at the far right of the top bar.

Only the session's owner, or an Admin, can respond. On anyone else's card **Respond** is dimmed with their name. A
sign-in ends after 12 hours without use, on **Sign out**, when the server restarts, and when your token changes.

#### What you can send

- **A question.** Pick an option on each tab (or **Type something**), check **Review**, then **Submit answers**. Writing in
  the message box instead replaces the answer, like "Chat about this" in the terminal.
- **A plan.** Choose **Yes, and use auto mode**, **Yes, auto-accept edits**, **Yes, manually approve edits**, or **No,
  keep planning** with what to change. If Claude Code doesn't take an approval, the modal says so and you approve it in
  the terminal. On a computer where an organization manages Claude Code, only **No, keep planning** is offered.
- **A tool's request.** **Allow once**, or **Deny** with an optional reason. "Always allow" stays in the terminal. A
  command too long to show in full can only be allowed in the terminal, but Podium still lets you deny it.
- **A message.** While the session is idle it starts the next turn. Sent while it runs, it waits until the session is
  idle. Type `/` for the two commands Podium can send: `/clear` (it asks first) and `/compact`, each on its own with
  nothing after it. Anything else runs only in the terminal.

#### What happens next

An answer counts once the session confirms it, usually within 2 seconds. Until then the modal says **Sending**.

- If the terminal answered first, if someone else answered first, or if the question closed in the session, the modal
  says so and nothing is sent.
- If the session has stopped checking in, your answer waits and goes out when it reports again, unless the terminal
  answered by then. **Discard my answer** takes it back.
- In the terminal, podium-reporter writes "also open in Podium. Answer here or there." while a question is open, and
  names who answered from Podium and when.
- A tool request answered in the terminal still looks open in Podium until the command finishes, since Claude Code says
  nothing sooner.

### History

- `#/history` lists the sessions that ended on a day you pick, with their agent detail from stored data. It survives a
  server restart.
- A busy day is shown a page at a time (25, 50 or 100 rows; 50 to start). The count at the top is the whole day. Open a
  session and press your browser's Back button to return to the same page.

### What the numbers mean

**Cost** is an estimate from token counts and a price table, and it is never a bill.

- The prices are the ones in **Admin > Model prices**, which start as Anthropic's published list prices. Change them
  there to match what you pay.
- The session's figure covers the orchestrator and every agent, nested ones included. The figures for agents are each
  agent's own use, and the dashboard labels them as estimates. The orchestrator's row in the agent tree shows the
  session figure.
- A session from a reporter older than 0.12.0 sends no per-model tokens, so its cost is the figure Claude Code's own
  ledger gave, and your prices do not change it.
- A session on a model that is not a Claude model (a local model served by Ollama, for example) has no price, so its cost
  reads "n/a". The "Est. cost today" tile leaves it out and says how many sessions it skipped.

**Context fill** is the share of the model's window in use. When Podium does not know a model's window, the bar is empty
and marked unknown rather than computed against a guessed size.

**A blowout** is a loop that overflowed its window and was compacted or stopped.

**Effort** is read from each model request, so after `/effort` it updates at your next prompt. It is drawn as five bars
with no text. More lit bars mean more effort, and the color changes with the level:

| Level | Color |
|---|---|
| low | orange |
| medium | green |
| high | blue |
| xhigh | purple |
| max | rainbow |

Hover the bars to read the level. Dimmed bars mean the level was not reported.

## Admin

Admin is for the person who runs the server.

### Getting in

The **Admin** button in the top bar's upper right shows only when you are signed in to the console as someone in the
**Administrators** group (see [Groups](#groups)), or as **Admin** with the admin secret. It opens Admin with no second
sign-in.

Anyone else goes to `#/admin`, which asks for a name and a token. Use your own name and token if you are in
Administrators, or the name **Admin** and the admin secret, which `podiumctl token` prints.

- Admin locks again after 10 minutes without activity. An Administrator who is still signed in to the console is let
  straight back in.
- Five wrong names or tokens lock it for 15 minutes.
- A server started without a token has no Admin, because there would be nothing to protect it.

### Getting around

Admin has eight pages, listed in a menu down the left side:

| Menu group | Pages |
|---|---|
| People and access | [People](#people-page), [Groups](#groups), [Reporters](#reporters) |
| Server | [Settings](#settings), [Model prices](#model-prices), [Reporting and security](#reporting-and-security) |
| Activity | [Spend](#spend), [Admin log](#admin-log) |

- **Lock Admin** is at the bottom of the menu. After you use it, reloading the page asks for your name and token again,
  even while you are still signed in to respond. The 10-minute idle lock, by contrast, lets a signed-in Administrator
  straight back in.
- On a narrow screen the menu becomes a strip along the top.
- Every list is paged, 50 rows at a time (25 and 100 are also offered). Spend starts at 25 and offers 50 and 100.

A report is accepted when its token belongs to the person whose name it also sends. The server decides who a report is
from by the token, so a valid token with someone else's name is refused. A person cannot see or rotate their own token.
Only the owner can.

### People page

Under **Create user**, type a name and choose Create user.

- Podium shows the token once, above the page (it stays there when you switch pages), with the settings to paste into
  that person's reporter: `userName`, `token` and `serverUrl`. Copy them before you choose "I have saved it", because
  Podium keeps only a hash and cannot show the token again.
- The list shows the token's key id as `pdm_` and twelve characters, the same way Reporters shows it, when each person
  last reported and from which machines.
- **Rotate** gives a person a new token and stops the old one.
- **Revoke** refuses their reports from the next one on, and their sessions go stale and drop as usual. A revoked
  person's row offers **Issue new token** instead.
- The search finds a person by name, group or machine.
- A person in the Administrators group has their name in orange.

### Groups

Under **Create group**, make groups such as Frontend or DevOps, and pick one for a person on the People page.

- A group is a label for arranging the console (Group by Group, see [People](#people)). Only Administrators grants
  anything.
- Deleting a group moves its people to "No group".
- **Administrators** is built in and cannot be renamed or deleted. The admin secret is always in it. Put a person in it
  and they can open Admin with their own token. Move them out, or revoke their token, and their open Admin session locks.
- A change shows on the wall with each session's next report, within a few seconds.

### Reporters

Every machine that has reported to this server, one row each. Rows are kept after the machine's sessions are deleted, so
you can check that a reporter is connected and see which ones ever were. The list updates by itself every 10 seconds.

The strip on top counts reporters by state and filters the list:

| State | Meaning |
|---|---|
| **Reporting** | Heard from in the last 2 minutes |
| **Idle** | Heard from up to an hour ago |
| **Silent** | Heard from longer ago. It means only that nothing has arrived: Podium cannot tell a reporter that is turned off from one that cannot reach it (hover or focus the state for this) |
| **Not since restart** | Last heard before the server started. After a restart, most rows read this until they report again. Hover or focus it to read why |

Each row shows the machine, the person, the token it uses, the reporter version (with a warning when it is older or newer
than this Podium supports), the last report and the number of sessions.

Select a row for its details: version and compatibility, machine id, source address, the token's key id (never the
token), then two panels. **Recent sessions** is paged like the other Admin lists, so you can reach every session the
server still holds for it. **Reports the server turned away** lists refused reports.

A reporter with no user name (the `userName` option) sends no machine id. Its row shows its newest project, or its
address, with "no name set" beside it, and it is matched by its sessions, so a container that comes back on a new address
stays one row. Hover or focus a state, or "no name set", for what it means for that row.

**Admin secret warning.** A reporter that reports with the admin secret instead of a token made for one person is always
flagged:

- an amber **Admin secret** badge in the Token column,
- a band above the list that counts them (**Show only these** filters to them),
- a warning at the top of its details with the steps to fix it: make a person in People, then enter their token and name
  in the reporter's options.

**Removing and ignoring.**

- **Remove from list** (in a reporter's details, with a tooltip that says the same) takes a reporter off the list. It
  comes back if it reports again, and its sessions are not touched.
- To clear out many at once, tick the boxes (the box in the header ticks the page, and **Select all N that match**
  reaches past it), then **Remove N…**. With a state chosen, **Remove all <state>** beside the search does the same.
- To keep a reporter off the list for good, choose **Ignore…** in its details. It sits beside **Remove from list**, and
  the dots mean it asks what to ignore before doing anything. Its reports are then turned away, so its sessions stop
  appearing on the fleet.
- The **Ignore rules** section after the table shows every rule (a key, an address or a version, with `*` for "anything",
  as in `10.88.*` or `*-sim`). **Remove rule** undoes one.

A source address and a machine name are personal data, so only Admin shows them.

If one machine shows several rows, or a changed login does not reach a running session, see
[Reporters and machines](GOTCHAS.md#reporters-and-machines).

### Settings

These settings apply to every browser and stay after a restart.

**Feature flags**, at the top, turn a feature on or off for everyone on this server.

- **Respond from Podium** (`respond`) is off by default. It lets people answer and message the sessions they own (see
  [Answering a session from Podium](#answering-a-session-from-podium)). Each answer is written to the Admin log with who
  sent it, followed by a row saying what became of it:
  - the session took it, or refused it;
  - it never got there, because its sender discarded it, its ask closed first, the session ended or was deleted first, or
    responding was turned off first;
  - a message the session had queued when it ended says only that the session ended while it was still queued, because
    Podium cannot tell whether Claude Code read it.
- **Agent activity feed** (`activity-feed`) is on by default. Turned off, every agent and orchestrator panel says the
  Admin turned the feed off, the server asks no mod for activity and forgets what it held, whatever each machine's
  `activityFeed` option says. Turned back on, open panels start the feed again, empty, without a reload.

**Wall notices.** The notes Podium shows at the bottom of the wall each have a switch here, and the X on a note turns its
switch off for everyone. After you close one, Podium says so and links to this page.

**Background sessions.** **Show background sessions on the wall** keeps sessions nobody is attached to in view. It is off
by default.

**Forget old reporters** is off by default. It removes a reporter from Admin > Reporters once the server has not heard
from it for the number of **Days** you set (30 to start with).

- It is checked when the server starts and then every hour.
- Each run that removes any is written to the Admin log.
- Sessions are not touched, and a reporter comes back if it reports again.

### Model prices

One row per model with five prices in US dollars per million tokens: input, output, cache read, cache write for 5 minutes
and cache write for 1 hour. They start as the prices on Anthropic's pricing sheet (the date is shown).

- Edit a price and click **Save**. Every cost in Podium (the wall, each orchestrator, **Est. cost today** and History)
  changes to match at once, including for sessions already running, and the change stays after a restart.
- A changed row shows **Changed** and a **Reset to built-in** button.
- Haiku 5.5 has a second row for prompts over 100,000 tokens, which cost more.
- To price a model Podium has no price for, such as a local model, type its id in **Model id** under **Add a model**, fill
  in the five prices and save. Until then its cost reads "n/a".
- Cache writes use the 5-minute price unless Claude Code reports which writes were 1-hour ones.

### Reporting and security

One switch, **Allow reporters to use the admin secret**. When it is off, a reporter that still sends the secret is
refused. Sessions that report with the secret show under the owner **Admin**.

### Spend

What each person, or each group, has spent since midnight today on the server, live or ended sessions, as bars or as a
table.

- Choose **People** or **Groups** and **Chart** or **Table**.
- The total spent and the number of live sessions are at the top right. The list is largest first, 25 rows at a time.
- The total and the table's Total row always count everyone, not just the page you are on, and the total equals the "Est.
  cost today" tile.
- These are estimates from tokens, not a bill.
- Someone whose sessions have all ended still has a row, but no band on the wall.

### Admin log

Who made each change (a person, or the admin secret), with the address each came from. It records:

- unlocks and failed unlocks,
- new people, rotations and revocations,
- group changes,
- reporters removed,
- changes to the feature flags, the wall settings and model prices.

It never holds a token or the secret. Entries are kept for 90 days (set `RETAIN_ADMIN_LOG_MS` to change that), and the
newest 100 are kept however old they are. The page says how long entries are kept.

## Everyday commands

| Command | What it does |
|---|---|
| `podiumctl status` | Mode, state, health, URL, whether it starts on boot (exit 3 if stopped) |
| `podiumctl logs -f` | Follow the server log |
| `podiumctl restart` | Apply a config change |
| `podiumctl stop` | Stop it; your data is kept |
| `podiumctl token` | Print the admin secret (`--rotate` makes a new one and ends every open Admin session after a restart; people's own tokens keep working) |
| `podiumctl config` | Show the saved settings (`config set KEY=VALUE ...` changes one or more, `config unset KEY ...` removes them; quote a value that has spaces) |
| `podiumctl enable` / `disable` | Start on boot or not |

`podiumctl --help` lists the rest.

## Logs

`podiumctl logs` shows what the server did. Each line is an event with a fixed name, so you or an agent can search for it.

In the default text format you see what Podium always printed: its start, reports it rejected, errors and its shutdown.
The other events below (sessions, reporters, sweeps, Admin changes, refused tokens) print in text only with
`PODIUM_LOG_LEVEL=debug`. The JSON format and the copy sent to VictoriaLogs carry every event at the level in the table.

| Event | Level | When |
|---|---|---|
| `server.start`, `server.stop` | info | The server started or stopped. In the JSON format and in VictoriaLogs, `server.start` also carries the port, database, whether auth is on, and the log and lifecycle settings |
| `report.rejected`, `hook.rejected` | warn | A report or hook payload failed validation; `reason` and `path` say why |
| `auth.failed` | warn | A request had no token, a wrong or revoked one, or a token that does not belong to the report's name |
| `report.conflict` | warn | A report for a session that belongs to someone else |
| `reporter.connected` | info | A reporter (owner, machine, mod or settings hooks) was heard for the first time, or again after a silence |
| `reporter.silent` | warn | A session stopped reporting and turned stale |
| `session.started`, `session.ended`, `session.deleted` | info | A session's first report (or its return after leaving the wall), its end (`reason` is `done` or `heartbeat lost`), or a delete |
| `reporters.forgotten` | info | The Forget old reporters setting removed reporters that had been silent for its number of days |
| `sweep.removed` | info | The sweep took ended or heartbeat-lost sessions off the wall; it names the first 10 session ids and counts the rest in `session_ids_omitted` |
| `admin.*` | info | An Admin change, named as in the Admin Log (`admin.person_created`, `admin.feature_changed`); a failed unlock is `admin.unlock_failed` at warn |
| `ingest.failed`, `request.failed`, `sweeper.failed` | error | Something broke on the server |
| `report.accepted`, `http.request` | debug | Every stored report, and every HTTP request (method, path, route, status, time; never the query string) |
| `http.aborted` | debug | A request the client dropped before the server answered (the fields of `http.request` without a status, since none was sent) |

### Log settings

Two settings change what you get. Set each with `podiumctl config set KEY=VALUE`, then run `podiumctl restart`.

| Setting | Values |
|---|---|
| `PODIUM_LOG_LEVEL` | `debug`, `info` (the default), `warn` or `error`. In text, `debug` adds the session, reporter, sweep, Admin and request lines |
| `PODIUM_LOG_FORMAT` | `text` (the default) prints each line's message, as Podium always has. `json` prints one object per line with `timestamp`, `level`, `message`, `event`, `service`, `host`, `version` and the event's fields, such as `session_id`, `route`, `status` and `reason`. A collector such as Vector or Fluent Bit can read it from the container's output |

### What is kept out of the logs

No line carries a token, the admin secret, a ship header, a prompt, an answer or activity text.

As a second guard, every piece of text in a line is scrubbed for common secret shapes, and what it finds becomes
`[redacted]`:

- `Bearer` and `Basic` credentials,
- `password=`, `secret=`, `token=` and `api_key=` values (in text, query strings and JSON),
- the password in `https://user:pass@host`,
- keys that start `sk-`, `ghp_`, `github_pat_`, `AKIA` or `xoxb-`, and JWTs.

It recognises shapes only. A secret in a format it does not know, or one written as plain prose such as "the password is
hunter2", is not caught. It does not look at the Admin Log or stored data.

### Send the logs to VictoriaLogs

Podium can push every log line to a central platform. It is off until you give it an address, and then only the log lines
leave the machine. It was built for [VictoriaLogs](https://docs.victoriametrics.com/victorialogs/), and works with
anything that takes VictoriaLogs' JSON line ingest.

```sh
podiumctl config set PODIUM_LOG_SHIP_URL=http://host.containers.internal:9428
podiumctl restart
```

If the server cannot reach the address, its log says `log shipping to ... failed` once, with the reason.

- **The address.** In container mode the server runs inside Podman, so `127.0.0.1` is the container itself. Use
  `host.containers.internal` for a VictoriaLogs on the same machine, or its address on your network. In standalone mode
  `http://127.0.0.1:9428` works.
- **The path.** Podium adds `/insert/jsonline` and the arguments that map its fields (`_time_field=timestamp`,
  `_msg_field=message`, `_stream_fields=service,host`). Give a full URL to change them.
- **Authentication or a tenant.** Set headers:

  ```sh
  podiumctl config set "PODIUM_LOG_SHIP_HEADERS=Authorization=Bearer <token>;AccountID=0"
  ```

  `podiumctl config` shows the header names and hides their values (a pair with no `=` is hidden whole).
  `--show-token` shows them. It also hides a user name or password in the URL and the values of its query arguments.
- **VictoriaLogs is down, or answers with an error** such as 401 (wrong credentials), 403, 404 (wrong URL) or a 5xx.
  Podium keeps the last `PODIUM_LOG_SHIP_BUFFER` lines (2000), drops the oldest past that, retries, and says once in its
  own log that it is dropping and again when it recovers. Reports are never held up.
- **VictoriaLogs refuses a batch as malformed or too large** (400, 413 or 422). Retrying would not help, so Podium drops
  that batch and says once that the endpoint refused it and how many lines were dropped.

### Point an agent at it

Add the [VictoriaLogs MCP server](https://github.com/VictoriaMetrics-Community/mcp-victorialogs) to Claude Code, pointed
at the same VictoriaLogs, and ask in plain words ("why were reports rejected in the last hour?"). It runs LogsQL queries
such as these:

```logsql
# Rejected reports in the last hour, counted by reason
_time:1h {service="podium"} event:="report.rejected" | stats by (reason) count() rejected

# One session's start and end
{service="podium"} session_id:="<session id>" event:in("session.started", "session.ended") | sort by (_time)

# Refused tokens and where they came from
_time:24h {service="podium"} event:="auth.failed" | stats by (reason, source) count() refused

# Admin changes today
_time:1d {service="podium"} event:="admin."* | fields _time, event, source, setting, on

# Sessions that went quiet, and errors
_time:1h {service="podium"} event:in("reporter.silent", "ingest.failed", "request.failed", "sweeper.failed")
```

`host` is the server's host name, which in container mode is the container's id, so it changes when the container is
recreated. Filter on `service` to see every run.

## Sessions you started without the mod

You do not have to restart them to see them. Claude Code's settings hooks can report a reduced view: the session, its
directory and model, and its agents, marked "settings hooks". See
[Sessions without the mod](REPORTER.md#sessions-without-the-mod) in REPORTER.md for the snippet to add to
`~/.claude/settings.json`.

## Updating the mod

The mod and the server are released separately, so you update them separately. A card marked `reporter 0.1.0 · update`
means the mod in that session is older than the server supports. For what each message means, see
[Gotchas](GOTCHAS.md#the-status-line-says-update-mod-update-available-or-upgrade-server).

To update it:

1. Refresh the marketplace listing and update the mod in one line, in a shell:

   ```bash
   claude plugin marketplace update eengelking-marketplace && claude plugin update podium-reporter@eengelking-marketplace
   ```

   The update prints `Checking for updates...` and then the new version, or says it is already at the latest version.
   Inside a session you can use `/plugin`, open the Installed tab, pick `podium-reporter` and choose Update now.
2. Apply it. A running session keeps the version it loaded, so run `/reload-plugins` in it, or start a new session.
   Sessions you do not reload keep reporting the old version and stay marked.
3. Run `/podium`. The `Versions:` line shows the mod's version, and the `· update mod` or `· update available` ending on
   the status line goes away after the next report.

If the command says it is already at the latest version but the card is still marked, the marketplace has not published
a newer mod yet. Refreshing the listing alone does not update the installed plugin, which is why the one-liner runs both.

**Auto-update.** Marketplaces other than Anthropic's do not update plugins by themselves. To have Claude Code do it:

1. Open `/plugin` and choose the Marketplaces tab.
2. Pick `eengelking-marketplace` and turn on auto-update.

It updates the plugin on disk some minutes after you send a first message, and the new version loads in your next session.

**The other direction.** A card marked `· upgrade server` means the mod is newer than the server. Upgrade the server with
`podiumctl build` and then `podiumctl restart`. For a plain Node install, pull, run `npm run build`, then restart.

## What leaves a session

Data leaves a session only to the server URL you set, and only the fields
[REPORTER.md](REPORTER.md#what-leaves-the-session) lists. Text is cut to fixed limits, and anything that looks like a
secret is replaced with `[redacted]` before it is sent. Podium never reads transcripts or files.

| What | When it leaves the session |
|---|---|
| An agent's whole task prompt and final answer | Only if you turn on the mod's `fullPrompts` option (off by default) |
| What an agent is doing (recent tool calls and the text it writes, each cut to 300 characters) | Only if you turn on the mod's `activityFeed` option (off by default), and even then only while someone has that agent's panel open in the console |
| What a session waits on you for (a question with its options, a plan, or a tool's arguments) | Only if you set the mod's `respond` option (`off` by default) and the server takes answers. Only the session's owner and an Admin can see it, and the server keeps it in memory only |
| Your name and your machine | Only once you set the mod's `userName` option (empty by default) |
| The model's thinking | Never |

Once `userName` is set, each report carries that name, the machine's short host name and a random id the mod keeps for
this machine. Everyone who can open the console sees them. Podium never reads your operating system user name or
`git config` for this.

The name shown on a session comes from the token that sent it, not from `userName`. The server checks that the two match,
so nobody can report under your name without your token.

## Remove it

```sh
podiumctl disable                 # if you enabled start on boot
podiumctl rm --purge --yes        # removes the container, its data volume and the image
```

Then remove the mod with `claude plugin uninstall podium-reporter@eengelking-marketplace`, and delete `~/.podium` if you
want the saved config and token gone too.
