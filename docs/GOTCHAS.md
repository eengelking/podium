# Gotchas

Sharp edges that are easy to hit, and how to get past them. If something looks wrong, find your symptom here first.

Every entry has the same three parts:

- **You see**: what shows up on screen or in a terminal.
- **Why**: the cause, so you can tell whether it applies to you.
- **Do**: what to do about it.

This is the short, practical list. The full list of known limitations is under "Known issues" in
[ARCHITECTURE.md](ARCHITECTURE.md). For setup and day-to-day use, see the [user guide](USER_GUIDE.md).

## Contents

- [Connecting the mod](#connecting-the-mod)
- [Reporters and machines](#reporters-and-machines)
- [Running the server](#running-the-server)
- [What the dashboard shows](#what-the-dashboard-shows)
- [Orchestrator messaging](#orchestrator-messaging)
- [Session recording](#session-recording)
- [Developing](#developing)

## Connecting the mod

### `/podium` says "offline" and "Last error: HTTP 401"

**You see:** `/podium` reports `Connection: offline` with `Last error: HTTP 401`.

**Why:** The server has a token and the mod is not sending a valid one. A person's token only works with the
`userName` it was made for. A revoked or rotated-away token is refused too.

**Do:**

1. Get the token with `podiumctl token`. On a shared server, ask the owner for your own token.
2. Enter it with `/plugin configure podium-reporter@eengelking-marketplace`.

The mod logs the refusal once and tries again about once a minute, so queued reports go out within a minute of the
settings being right.

### The status line says "update mod", "update available" or "upgrade server"

**You see:** The status line ends in `· update mod`, `· update available` or `· upgrade server`, or a card is
marked `· update` or `· upgrade server`. The status line always starts with the mod's version, for example
`podium v0.11.1 ● 3 live`.

**Why:** The server and the mod are released separately, and the server keeps a range of mod versions it reads
correctly (SPEC 6.8).

| Message | Meaning |
|---|---|
| `update mod` | The mod in this session is older than the range. |
| `upgrade server` | The mod is newer than the range. |
| `update available` | The mod is inside the range, but the server supports a newer `major.minor`, so a newer mod exists. |

Reports still arrive in every case. Only `major.minor` is compared, so a patch release never triggers a message.
A version the server cannot read (the simulator's `0.1.0-sim`) shows nothing. A mod older than 0.3.0 cannot show the
message itself, but the dashboard still marks its card.

**Do:** For `update mod`, update the mod, then reload it in the session. A running session keeps the version it loaded
until you do.

```sh
claude plugin update podium-reporter@eengelking-marketplace
```

Then run `/reload-plugins` in the session. If the update says it is already at the latest version, refresh the listing
first with `claude plugin marketplace update eengelking-marketplace`. `/podium` prints both versions, which tells you
which way you are out of step. The full steps are in [Updating the mod](USER_GUIDE.md#updating-the-mod).

### The token option has no row in the `/config` menu

**You see:** The mod's other options are in the `/config` menu, but `token` is not.

**Why:** The option is marked `sensitive`, and Claude Code only draws menu rows for options that are not secret.

**Do:** Use `/plugin configure`. For a copy loaded with `--plugin-dir`, putting the token in
`~/.claude/settings.json` under `pluginConfigs`, `podium-reporter`, `options`, `token` also worked when we tried it.

### The status line has a warning sign in front of `podium v0.11.1 ● 1 live`

**You see:** The line reads `⚠ podium-reporter: podium v0.11.1 ● 1 live`.

**Why:** Claude Code adds the `⚠` and the mod's name to every line a mod pins with `$.ui.status`. Its
[mods API docs](https://code.claude.com/docs/en/plugins/mods/api.md) give the format as `⚠ my-mod: checks: 3 passing`.
It is not a Podium warning and not a trust marker. The docs describe no approval, signing or marketplace step that
clears it, and the mod passes only `podium v0.11.1 ● 1 live`. We have not checked it against a mod loaded with
`--plugin-dir`, but the docs do not say the icon depends on where the mod came from.

**Do:** Nothing removes it. `podium v0.11.1 ○ offline` is the real warning.

### The effort shown is the old one after I run `/effort`

**You see:** The effort bars on the dashboard still show the previous level.

**Why:** The mod reads the effort the session sends with each model request, and the plugin API has no event for the
setting changing.

**Do:** Send your next prompt. The new level shows after it. This is expected.

### Installing the mod from the marketplace fails with "Permission denied (publickey)"

**You see:** The install fails with `Permission denied (publickey)`.

**Why:** A marketplace entry that points at a subfolder of another repo with the `owner/repo` shorthand makes Claude
Code clone over SSH.

**Do:** Use the full `https://github.com/eengelking/podium.git` URL, as the `podium-reporter` entry does. If you add
your own entry for a public repo, do the same.

## Reporters and machines

The Reporters page in Admin lists reporters, not sessions and not machines. The rules that decide what counts as one
reporter are in SPEC section 7.7 ("Which reporters the server knows"). Nothing here is a bug in the server.

**Check it yourself.**

- On Admin > Reporters, a row shows the machine, the person and the token (as `pdm_` and a key id). Select a row for
  its machine id, source address and refused reports.
- A session's card shows its owner.
- In the server log, `reporter.connected` says which owner and machine was heard, and `report.conflict` says a report
  was refused because its session belongs to someone else. See [Logs](USER_GUIDE.md#logs) in the user guide.

### The page shows more reporters than I have machines

**You see:** Admin > Reporters lists more rows than you have computers.

**Why:** Each running Claude Code session is its own card, and a machine can run several. The page counts reporters,
so three sessions on one Mac can look like extra reporters when they show as separate rows (the next entries say why
they do).

**Do:** Count the cards on the wall for sessions and the machine ids on the page for machines.

### One machine showed as two rows with different machine ids (fixed in #267)

**You see:** One computer appears twice, each row with its own machine id.

**Why:** Before #267 each load of the mod kept its own machine id in its own store, so an inline copy and the
marketplace install reported as two machines. Every load now shares `podium-machine-id` in the Claude config directory
(`CLAUDE_CONFIG_DIR`, else `~/.claude`). The id is made in `mod/podium-reporter/hooks/machine.ts`.

**Do:** Update the mod. A machine that already had two ids settles on one: the first load to run after the upgrade
writes the file and the others adopt it.

Some edge cases:

- Two sessions that start in the same instant can each keep the id they wrote until they end, and agree from the next
  session on. The other id's row stays live only while its session does.
- If the config directory is copied to another machine, the id goes with it and the two machines share one id.
- Where the file cannot be read or written, the mod falls back to its own store, as before.

### One machine shows an extra row ending in `#` and a name

**You see:** A row keyed like `<machine id>#<owner>` next to the machine's first row.

**Why:** Since #221 a machine gets one row for each account that reports from it, keyed `<machine id>#<owner>` for
every account after the first. Since #226 a session keeps the name and token it started with, so a machine can carry
two people at once (two terminals, or one before and one after a change of settings) and shows two rows.

**Do:** Nothing. This is by design. Whether a machine should collapse to one row across accounts would reverse part of
#221 and is not decided.

### A reporter with no name has a row of its own, and another once it has one

**You see:** The same machine appears as an `addr:...` row, and again as a named row after you set a name.

**Why:** The mod sends a machine id only when the `userName` option is set. A reporter without a name is keyed by its
source address (`addr:...`). When the same machine later reports with a name, it becomes a second row.

**Do:**

1. Set `userName` and the person's token on every reporter. See
   [A name set with the shared secret, or with no token, shows no person](#a-name-set-with-the-shared-secret-or-with-no-token-shows-no-person).
2. Remove the old `addr:` row from Admin when you no longer need it.

### Rows that read "Not since restart" and never go away

**You see:** `addr:` rows in the **Not since restart** state that stay after the server has been running a while.

**Why:** A reporter with no name is matched by its sessions, so a container that comes back on a new address stays one
row when a session it already reported turns up from the new address. A reporter that has not reported such a session
gets a row of its own. A container's address changes on every restart, so each restart can leave an `addr:` row
behind. Nothing removes them but you.

**Do:** Use one of these. A reporter that reports again comes back.

- Tick the rows on Admin > Reporters and choose **Remove N…**, or choose **Remove all Not since restart**.
- Turn on **Forget old reporters** under Admin > Settings.

### I changed my reporter settings and a running session did not change who it reports as

**You see:** You saved a new name or token, and a session that was already running still reports as the old person.

**Why:** A running Claude Code session cannot be handed to another Podium user. A session takes its name and token
once, when it starts, and keeps them. Saving new values in `/plugin configure`, `/reload-plugins` and `/clear` do not
change them (#226), and a session that tries is refused. A session with no token has nothing held yet, so adding one
later does apply.

The settings hold one login for each Claude config directory, so two logins on one machine need the environment
variables below (#230, blocked on what Claude Code offers a mod).

**Do:** Quit Claude Code and start a new session. Or start the terminal with `PODIUM_USER` and `PODIUM_TOKEN` set:

```sh
PODIUM_USER=Ed PODIUM_TOKEN=<Ed's token> claude
```

The server log shows no refusal for a person whose reporter simply sent nothing, so from the server's side that person
looks as if they do not exist. If a reporter shows as signed in on the person's side and nothing appears in Podium,
restart Claude Code first.

### The status line says "refused: session belongs to someone else"

**You see:** `podium-reporter: podium v0.14.2 refused: session belongs to someone else` (your version will differ).
The server logs a `report.conflict` warning for the same session id every 5 to 10 seconds.

**Why:** The session is stored as owned by one person (Admin, say) and the mod is now sending as another. The server
refuses with a 409 (#209), and is right to. Whether the mod should keep a session's identity through a settings change,
a reload and a clear is not decided.

**Do:** Quit Claude Code and start a new session, as in the entry above. The message clears at the next accepted report.

## Running the server

### `podiumctl start` fails with "port N ... is already in use"

**You see:** `podiumctl start` stops with `port N ... is already in use`.

**Why:** Something else already listens on the bind address and port. Often it is a leftover `podiumctl run` or
`npm run dev`, or a Podium started another way.

**Do:** Run `podiumctl status` to see whether it is Podium, and stop it if it is. Or choose another port with `--port`.

How `start` behaves:

- In standalone mode `start` checks before it spawns anything, so nothing is left running and no pid file is written.
- Container mode needs no check. `podman run` or `docker run` fails with `address already in use` and `start` exits
  non-zero (tested with Podman 6.1.2 and Docker 29.8.1).
- If the server exits right after `start` spawns it (a bind error, a bad setting), `start` says so, prints the tail of
  `~/.podium/podium.log` and removes the pid file, instead of reporting success.

### I changed a setting and nothing happened

**You see:** You ran `podiumctl config set ...` and the server behaves as before.

**Why:** `podiumctl config set` only edits `~/.podium/config.env`.

**Do:** Run `podiumctl restart`. The `--mode`, `--engine`, `--port` and `--bind` flags are saved by `start`, `restart`, `build` and
`enable`.

### On macOS the first `podiumctl start` takes a while

**You see:** The first start pauses for a while.

**Why:** Podman runs in a VM. If it is not running, `podiumctl` starts it, and the first start also builds the image
(about 20 seconds on a warm cache).

**Do:** Wait. Later starts are quick. Docker Desktop is not started for you: if it is not running, `podiumctl` says so
and stops. Start it, then run the command again.

### `podiumctl` uses Podman, but I want Docker (or the other way round)

**You see:** Both are installed, and the container runs under the one you did not want.

**Why:** Container mode prefers Podman when it is installed. The engine that first ran `build`, `start`, `restart` or
`enable` is saved as `PODIUMCTL_ENGINE`, so later commands keep using it.

**Do:** `podiumctl rm`, then `podiumctl start --engine docker` (or `podman`). The data volume belongs to one engine, so
the other one starts with an empty database.

### `podiumctl disable` stopped my standalone server

**You see:** After `podiumctl disable`, a standalone server is no longer running.

**Why:** Under the launchd or systemd service the server is the service's child, so removing the service stops it. In
container mode the container keeps running.

**Do:** Check with `podiumctl status`, then `podiumctl start` if you want it back.

### A restart shows every session as stale

**You see:** After a server restart, every card is stale.

**Why:** Sessions come back from SQLite as stale and recover when their reporters next send, within about five seconds.
A session whose reporter never comes back is dropped about a minute after the server's own start.

**Do:** Wait a few seconds. A card counts down to the time it will be dropped, and **Remove** clears it sooner.

### `podman inspect podium` shows the token

**You see:** `podman inspect podium` (or `docker inspect podium`) prints the token.

**Why:** `podiumctl` keeps the token out of the command line, but it is part of the container's environment, and
`inspect` prints that. Anyone who can run Podman or Docker as you can read it.

**Do:** Treat the account that runs the container engine as trusted. See `.github/SECURITY.md`.

### Anyone on localhost can read the dashboard

**You see:** The dashboard opens with no sign-in.

**Why:** The token guards reports, hooks and deletes, and Admin has its own lock. Reads (`GET /api/fleet/*`) are open
on localhost by design (SPEC 7.7). With `--bind` or `HOST` set to anything but `127.0.0.1`, other machines can read it
too.

**Do:** Keep the default bind unless you want others to see the console. For several people on one server, see
[SERVER.md](SERVER.md).

### A name set with the shared secret, or with no token, shows no person

**You see:** A reporter sends `userName`, and the people view stays off or the session shows under **Admin** or
**Unassigned**.

**Why:** The people view groups sessions by who the server decided sent them, and that comes from the token. A reporter
that sends `userName` with the admin secret shows under Admin. One that sends it to a server with no `PODIUM_TOKEN`
shows under Unassigned. Neither turns the people view on. The name and machine still travel in those reports and are
stored, so they are not private either.

**Do:** Give each person a token in Admin, and put it in their reporter with their name.

### A group change shows a few seconds late

**You see:** You moved someone to another group in Admin, and the wall has not changed yet.

**Why:** Admin's groups are read when a session's view is built, so the change shows on the wall with each session's next
report (the heartbeat is five seconds), not at once. The Spend page in Admin updates on the next tick.

**Do:** Wait a few seconds.

### `systemctl --user start podium.service` does nothing after `podiumctl stop` (container mode)

**You see:** After `podiumctl stop`, a plain `systemctl --user start podium.service` has no effect.

**Why:** In container mode the unit is `Type=oneshot` with `RemainAfterExit=yes`. `podiumctl stop` stops the container
but systemd still counts the unit as active, so a plain `start` is a no-op. A container that dies is not restarted by
the unit. Standalone mode restarts a crashed server after 3 seconds.

**Do:** Use `podiumctl start`. Or run `systemctl --user stop podium.service` and then `start`.

### The Linux start-on-boot unit was rebooted in standalone mode only

**You see:** Nothing is wrong. This is a gap in our testing.

**Why:** `podiumctl enable` has run on Bazzite 44 (Fedora Atomic, systemd 259, Podman 5.8.7, SELinux enforcing) in both
modes, with Node from Homebrew (#268). Starting, `stop` and `disable` behave as described above. Standalone mode has
also been through a reboot, with `loginctl enable-linger $USER` (the server was up at boot before anyone logged in) and
without it (the server started at login). Container mode has not been rebooted.

**Do:** If you have tried container mode through a reboot, tell us.

## What the dashboard shows

### A session shows no plan

**You see:** The card reads "No plan reported. Agents were launched ad hoc."

**Why:** Podium builds the plan only from the session's task list: the `TaskCreate` and `TaskUpdate` tools (or
`TodoWrite`). If Claude did not use them for the work, there is nothing to show. That happens when the tools are not
available to the session, and also when they are but Claude chose not to use them for a small job. Plan mode does not
make a plan appear: Podium does not read it, so `ExitPlanMode` alone gives no steps.

**Do:** Make sure the task tools are on, then ask Claude to track the work as a task list.

1. Start Claude Code with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in its environment, or add it to the `env` block of
   `~/.claude/settings.json`.
2. Ask Claude to track the work as a task list.

The agent tree is shown either way.

### A plan step has no owner

**You see:** A plan step shows no agent next to it.

**Why:** Podium links an agent to a plan step by matching the agent's description to the step's title, and the match is
literal. "Count .ts files under server" and "Count .ts files in server" do not match.

**Do:** Nothing on your side. Matching wording between the step and the agent's task helps.

### An agent's cost does not add up to the session's

**You see:** The agents' costs in the tree do not sum to the figure on the card.

**Why:** An agent's row shows its own estimated cost, not the agents it launched. The facts bar and the card show the
session's figure from Claude Code, which includes every agent at every depth once, plus the orchestrator itself. The orchestrator's row
shows its own share: that figure less each agent's estimate, so the rows add up to it.

From reporter 0.12.0 the server prices the session and every agent from the same per-model token totals and the prices
in Admin > Model prices, so the rows add up. A session from an older reporter shows Claude Code's ledger as its figure,
while an agent's is an estimate from a price table, so its rows will not sum exactly.

**Do:** To see a branch, open the agent. **With its agents** adds it and everything under it. Update the mod for exact
sums.

### Every agent sits under the orchestrator in a session started without the mod

**You see:** In a session reported by settings hooks, the agent tree is flat.

**Why:** The settings hooks (`SubagentStart`, `SubagentStop`) say which agent started but not which agent launched it,
so a hook-only session cannot nest. The mod reads the parent from `agent.spawn` and nests correctly at any depth
(SPEC 5.3).

**Do:** Install the mod to get the nested tree.

### Elapsed times freeze when the tab is in the background

**You see:** Running times stop moving while the tab is hidden.

**Why:** Browsers throttle timers in hidden tabs.

**Do:** Nothing. The numbers catch up when you look at the tab again.

### The dashboard's GPU use goes up after adding an animation

**You see:** GPU use climbs after a UI change that adds a CSS animation.

**Why:** A CSS animation that repeats forever and uses a smooth timing function (`ease`, `linear`) makes the browser
draw a frame on every display refresh, 120 or more a second, for as long as the tab is open, however small the element
is. Several at different phases are worse, because together they change the screen on almost every refresh.

**Do (contributors):**

- Drive repeating motion from the shared `data-beat` that `useHeartbeat` steps four times every 1.8 seconds, as the
  pulse and blink in `fleet.css` do.
- Build a pulse ring as a pseudo-element that is scaled and faded, not a `box-shadow`.
- Avoid a progress bar that slides between values. It redraws after each update the same way.
- `gpuLoad.test.tsx` fails on any infinite CSS animation and on a bar transition.
- To measure a change, close other tabs and windows that use the GPU, run the simulator
  (`npm run podium:sim -- --sessions 10 --agents 10`) and run `scripts/gpu-sample.sh`.

Applying incoming data on the same beat was tried and gained nothing you could measure, so it is not done. The viewer's
own **Refresh every** choice (#138) holds incoming data back between redraws on purpose: `useHeldState` shows the
newest state once per interval, and `FleetView` is memoized so a parent render does not redraw it in between.

### A resumed session's running time starts when Podium first saw it

**You see:** A session you resumed shows a running time that is shorter than its real age.

**Why:** Podium keeps the start time a session reports only if it is within 2 minutes of the moment the server first
heard of it. If the mod reports an earlier start (a resumed session, or one already running when you installed the
mod), the card counts from the first report instead. The engine's start time is not always the session's own: under
Claude Code's background daemon, sessions that began minutes apart reported the same one. Once stored, a session's
start never changes.

**Do:** Nothing. This is how the start time is kept.

### A session sitting at the prompt shows as waiting

**You see:** Idle sessions show a waiting callout, and with many of them the wall fills up.

**Why:** The session is waiting on you.

**Do:** Nothing. That is correct. Use the status filter to focus on the sessions you care about.

### A new session is not on the wall until I send a prompt

**You see:** A freshly opened session has no card, and its status line reads `podium ● 0 live`.

**Why:** Podium keeps a session off the wall until it has done something (it is running, or has tokens, cost, context
use, a blowout, an agent or a plan). Claude Code's background daemon runs a parked twin of each interactive window and
a pool of spares, and each of them reports as a session. Without this rule one window showed three identical cards. The
number in the status line is the cards on the wall, not the Claude Code processes. A session known only from settings
hooks is never hidden.

**Do:** Send a prompt. The count becomes `1` or more. The rule is SPEC 7.5, and the user guide explains it in
[Sessions that have not done anything yet](USER_GUIDE.md#sessions-that-have-not-done-anything-yet).

### A session I closed is still on the wall

**You see:** You closed the window and the card is still there.

**Why:** Closing the window can move the conversation to the background instead of ending it. It is a real session, so
its card stays.

**Do:** `claude agents` lists background sessions, and `claude attach <id|name>` opens one. End it with
`claude stop <id>`, and the card leaves. `claude rm <id>` also deletes the session's worktree. Use the id `claude agents`
shows, not the id on the card, which differs after `/clear`. The user guide has the full steps in
[Closing a background session](USER_GUIDE.md#closing-a-background-session).

### A session started without the mod stays "live" for ten minutes after it goes quiet

**You see:** A hook-only session still looks live well after it stopped.

**Why:** Settings hooks send no heartbeat, so a hook-only session gets `HOOK_STALE_AFTER_MS` (10 minutes) before it
shows as stale. A session the mod reports uses the 15-second default.

**Do:** Install the mod for faster stale detection.

## Orchestrator messaging

The setup is in [MESSAGING.md](MESSAGING.md), and its [Troubleshooting](MESSAGING.md#troubleshooting) table covers
each answer the tools give. These are the ones that surprise people.

### Two orchestrators on the same machine cannot message each other

**You see:** `podium_peers` does not list the other orchestrators on this machine, and says nothing about them under
`Not listed:` either. `podium_send` to one of them says "You cannot see an orchestrator called …".

**Why:** Rights belong to reporters, and a reporter is one machine plus one person's token. Two sessions on one
machine share a reporter, so they need that reporter's right to itself, which no one has given yet.

**Do:** On My reporters, set the cell on the Grid's diagonal for that machine, or turn on **Trust my own reporters**.

### A message does not arrive while the other session waits at a permission prompt

**You see:** `podium_send` answered "Waiting for … It is working, and gets the message when its turn ends", and the
receiving session sits at a permission prompt.

**Why:** Podium hands a message over only when the receiver reports itself idle. A session at a permission prompt is
waiting on its person, not idle, so the message waits with it (SPEC 7.7, "Delivery").

**Do:** Answer the prompt. The message arrives once that turn ends.

### My reporters is missing after signing in with the admin secret

**You see:** You signed in with the name `Admin` and the admin secret, and the top bar has no **My reporters**.

**Why:** Messaging is only between one person's own reporters, and the admin secret belongs to no one, so it has no
reporters to show and cannot take part.

**Do:** Sign in with your own name and token, the ones your reporters use.

## Session recording

The feature is in [REPLAY.md](REPLAY.md).

### Record says "This session's reporter does not allow recording"

**You see:** you chose a session and pressed Start recording, and the dialog or the layer says the reporter does not
allow recording. Nothing is recorded.

**Why:** the third yes answer is the reporter's `sessionRecording` option on the machine the session runs on, and it is
off by default. The browser cannot turn it on, on purpose.

**Do:** on that machine, run `/plugin configure podium-reporter@eengelking-marketplace` and turn on **Allow session
recording**, then start the recording again. Capture begins at the next reply, so allow a few seconds.

### A permission prompt or question I answered in the terminal is not in the replay

**You see:** the replay shows the tool call and its result, but no "Allowed a tool once" or "Answered a question" row.

**Why:** the replay marks only answers and approvals sent from Podium. The mod cannot see a permission prompt that was
answered in the terminal, and a question's result arrives as an object it cannot read as text.

**Do:** read the tool's result: it shows what ran and whether it was refused. A decision row means someone answered from
Podium.

### After `/clear` the recording is on a different session

**You see:** after `/clear` the old session's recording reads stopped, with no one named, and the new session shows it
recording.

**Why:** `/clear` gives the session a new id. The server carries a running recording over to the new session, with the same
starter and start time, and stops the old one. The owner's consent is not carried: the new session's own report must state
that `sessionRecording` is on.

**Do:** replay the first part from the old session's page and the rest from the new one. If the new session says the
reporter does not allow recording, turn the option on for that machine.

## Developing

### An Admin style does nothing, or looks like the fleet page's

**You see:** A CSS rule in `admin.css` has no effect, or the element takes on the fleet page's look.

**Why:** Admin's CSS is scoped under `.adminv`, but `fleet.css` styles bare class names under `.podium` (`.sec`,
`.main`, `.code`, `.back`, `.field`, `.btn` and more) with higher specificity, so a class of the same name in Admin
picks up its rules.

**Do:** Before you add a class to `admin.css`, search `fleet.css` for it. Prefix a layout class that collides (Admin
uses `asec` and `apage` for this reason).

### `npm run test:mod` and `npm run typecheck:mod` fail on a clean machine

**You see:** Both commands fail where Claude Code is not installed.

**Why:** Both need Claude Code installed, and CI cannot run them.

**Do:** Install Claude Code and run them locally when you change the mod.

### A test run with `claude -p` cannot launch a fork

**You see:** The Agent tool answers "Agent type 'fork' not found".

**Why:** Forks are off in a non-interactive run. Subagents launching subagents work without any setting.

**Do:** Set `CLAUDE_CODE_FORK_SUBAGENT=1` for the run.

### A prompt sent to Claude Code with `tmux send-keys` stays in the box unsent

**You see:** You sent a long prompt and `Enter` to a Claude Code window in one `tmux send-keys`. The text is in the
prompt box and no turn starts.

**Why:** The keys arrive in one burst, which Claude Code most likely reads as a paste, and an Enter inside a paste
does not submit it.

**Do:** Send the text, pause, then send Enter on its own:

```sh
tmux send-keys -t podium-e2e:planner -l 'Run podium_peers.'
sleep 1
tmux send-keys -t podium-e2e:planner C-m
```

To watch a nested run without touching your own server:

1. Copy the mod and point its `serverUrl` default at a server on another port with its own `PODIUM_DB`.
2. Pass `--settings '{"enabledPlugins":{"podium-reporter@eengelking-marketplace":false}}'` so the installed copy stays
   quiet.

The simulator's `--nested` flag shows the same shapes with no run at all.

### A server test fails now and then with a 404, a 401 or a body of `{}`, and passes on the next run

**You see:** A server test fails once, then passes on a rerun.

**Why:** supertest listens on the wildcard address and then connects to `127.0.0.1`. On macOS, if another process holds
`127.0.0.1:P`, the wildcard bind of the same port `P` still succeeds, and connections to `127.0.0.1:P` go to the other
process. So a busy machine (the full run's own workers, the container, a second run, a browser) sometimes answers a
test's request with someone else's server (#137).

**Do:** The fix is already in place. Keep it working:

- `server/src/testSetup.ts` makes a bare `listen(0)` bind `127.0.0.1`. Vitest loads it for every file. A new test setup
  file that replaces `setupFiles` must keep `testSetup.ts` in the list.
- A test that starts its own server should say `127.0.0.1` too.
- It binds with Node's internal `_listen2`, because supertest reads the port the moment `listen(0)` returns and a public
  `listen(0, '127.0.0.1')` is not synchronous. `testSetup.test.ts` fails if a Node upgrade breaks that.

To check for the flake, run several full runs at once. Before the fix, six loops of `npx vitest run` in parallel failed
about 7% of runs, and none of 60 failed after. Today, keep it to three loops.

- Let the sockets drain between rounds (`netstat -an -p tcp | grep -c TIME_WAIT` under a few
  hundred).
- A run opens about 3,000 connections and macOS has about 16,000 ephemeral ports. With vitest 5, six loops run out of
  them and fail with `listen EADDRNOTAVAIL 127.0.0.1` all over the suite. That is the machine, not a test.
- One real timing flake remains: `shipper.test.ts` "sends a full batch on its own" waits a fixed 20 ms for a gzip to
  finish and fails now and then under load, on vitest 2 as well.

### The frontend build says `Property 'toBeInTheDocument' does not exist on type 'Assertion'`

**You see:** The frontend build fails with that TypeScript error.

**Why:** vitest 5 declares `Assertion<R, T>` with two type parameters, and `@testing-library/jest-dom` declares it with
one, so TypeScript drops jest-dom's own matcher types.

**Do:** `frontend/src/jest-dom.d.ts` redeclares them for two parameters. If a jest-dom release fixes its types, delete
that file.

### Finished nested agents are missing from `$.agent.list()`

**You see:** `$.agent.list()` no longer returns agents that finished.

**Why:** Once a parent agent finishes, the engine's list drops the finished agents it launched (SPEC 5.3). The mod keeps
every agent it has seen, and the server never deletes an agent a later report leaves out, so the console keeps them. A
hot reload after that point rebuilds only what the list still has.

**Do:** Do not rely on `$.agent.list()` for history. Read from what the mod has recorded.

### A `turn.step` hook that reads the stream loses the step's result

**You see:** Every watched step reports no usage, no stop reason and no blowout.

**Why:** `turn.step` is a streaming hook. `yield* next(e)` passes the chunks on and evaluates to the step's result, but
`for await (const chunk of next(e))` throws the result away, because a generator's return value is not a value of the
loop. The activity feed (#118) has to see the text chunks, so for a watched loop the reporter keeps the stream, reads it
with `for await`, yields each chunk on as it came, and then takes the result from `await stream.result`. Only a watched
loop takes this path. Every other step still uses `yield* next(e)`.

**Do:** Do not forget the last step, `await stream.result`. The same applies to a test that drives `$.turn.step` by hand:
read it with `next()` until `done`, as `stepOnce` in `register.test.ts` does.

### A mod fix did not reach anyone

**You see:** You merged a mod change and installed copies behave as before.

**Why:** Installed copies only update when `version` in `mod/podium-reporter/.claude-plugin/plugin.json` changes.

**Do:** The version is bumped in the release-prep PR, not in feature PRs. See "Releases" in `.claude/CLAUDE.md` for the
files that change together, including `VERSION` in `mod/podium-reporter/hooks/register.ts` (the number the mod reports;
a test checks the two match). CI (`mod-version-check`) checks the release PR into `main`.

### A new color theme shows up in the dropdown but the page stays on Podium's colors

**You see:** The theme is listed, and picking it changes nothing.

**Why:** A theme lives in three places:

- its entry in `frontend/src/fleet/themes.ts`,
- its light and dark token blocks in `tokens.css`,
- the id list in the inline script in `frontend/index.html` that applies the choice before first paint.

`themes.test.ts` fails if they disagree, or if a block lacks a color token such as `--deleg`, `--deleg-text` and
`--admin-text`.

**Do:** Update all three. A new palette also needs an entry in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and a
clean run of `npx tsx scripts/theme-contrast.ts`.
