---
title: "The reporter mod"
description: "Install and configure podium-reporter, the Claude Code mod that sends a session's data to Podium, and see exactly what leaves a session."
group: Running it
---

# The reporter mod

`podium-reporter` is the Claude Code mod that sends a session's data to the Podium server. This page is for
anyone installing or configuring it. It covers installing the mod, its options, exactly what leaves a
session, and how to report sessions that were started without it. To run the server, see
[SERVER.md](SERVER.md).

Contents:

- [Install the mod](#install-the-mod)
- [In the session](#in-the-session)
- [Options](#options)
- [Over TLS](#over-tls)
- [Messaging your other orchestrators](#messaging-your-other-orchestrators)
- [What leaves the session](#what-leaves-the-session)
- [Sessions without the mod](#sessions-without-the-mod)

## Install the mod

The reporter is a Claude Code mod in `mod/podium-reporter/`. Install it from the eengelking
marketplace, in Claude Code:

```
/plugin marketplace add eengelking/skills
/plugin install podium-reporter@eengelking-marketplace
```

If the server uses a token (`podiumctl start` generates one), enter it with
`/plugin configure podium-reporter@eengelking-marketplace`:

- On your own machine the token is the admin secret, which `podiumctl token` prints.
- If someone runs the server for a group, they make you a token in Admin. Enter it as `token`, and your
  name as `userName`.
- The `token` option is secret, so it has no row in the `/config` menu.

If the server needs a token and you send none, or send one that does not belong to your name, the reporter
gets HTTP 401, logs it once, and tries again about once a minute. `/podium` and the status line say so.

To work on the mod itself, load it from a checkout for one session instead:

```sh
claude --plugin-dir /path/to/podium/mod/podium-reporter
```

To update an installed mod, run this in a shell and then `/reload-plugins` in the session (see "Updating
the mod" in [docs/user-guide/](user-guide/README.md)):

```sh
claude plugin marketplace update eengelking-marketplace && claude plugin update podium-reporter@eengelking-marketplace
```

## In the session

The session appears in Podium once you send its first prompt. A session that has done nothing yet is kept
off the wall, because Claude Code's background daemon also runs idle twins and spares that report too (see
"Sessions that have not done anything yet" in [docs/user-guide/](user-guide/README.md)).

- `/podium` prints the console link, the connection state and report counts.
- `/podium name <text>` gives the session a display name. Without one, a name you gave the session in Claude
  Code (for example with `/rename`) is its name in Podium, picked up from the next prompt. The `sessionName`
  option and the worktree or folder name come after.
- Effort is read from each model request, so a change made with `/effort` shows after the session's next
  prompt, not when you pick it.
- With `peers` on, `/podium allow <id>`, `/podium decline <id>` and `/podium deliver <id>` answer a messaging
  request (see [Messaging your other orchestrators](#messaging-your-other-orchestrators)). `/podium` runs at
  once, even during a turn, and lists the requests still waiting for you. `/podium allow` names the level the pair
  has afterwards, which can be higher than the one asked for, since allowing never lowers a right.

The status line under the prompt reads:

| Status line | Meaning |
|---|---|
| `podium vX.Y.Z ● N live` | Connected. N is the cards on the wall, so a session that has not run yet reads 0 |
| `podium vX.Y.Z ○ offline` | The server is unreachable. Reports queue up and go out when it is back |
| ends in `· update mod` | The mod and the server are on versions that do not match, and the mod is older |
| ends in `· upgrade server` | The mod is newer than the server supports |
| ends in `· update available` | The server supports a newer mod than yours |

Claude Code puts a `⚠` and the mod's name in front of the line. That is how it draws every mod's status
line, not a Podium warning (see [docs/gotchas/](gotchas/README.md)).

## Options

Set the mod's options with `/plugin configure podium-reporter@eengelking-marketplace`, or in
`~/.claude/settings.json` under `pluginConfigs`, `podium-reporter@eengelking-marketplace`, `options`
(`podium-reporter` for a copy loaded with `--plugin-dir`). Claude Code keeps `token` in its secure storage
instead. Everything except `token` also has a row in the `/config` menu.

| Option | Default | Meaning |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:4317` | Where reports go |
| `token` | empty | Sent as `X-Podium-Token`: a per-person token from Admin, or the admin secret (`PODIUM_TOKEN`) on a one-person setup |
| `userName` | empty | The name your token was made for. The server accepts a report only when the token and this name match. Leave empty when you report with the admin secret. Nothing that names you or your machine is sent until you set it. With it set, reports also carry this machine's name (see [What leaves the session](#what-leaves-the-session)) |
| `flushIntervalMs` | `1000` | Minimum time between reports while something changes |
| `heartbeatMs` | `5000` | Report at least this often |
| `sessionName` | empty | Display name override (below `/podium name` and the name set in Claude Code) |
| `showStatus` | `true` | Show the status line entry |
| `fullPrompts` | `false` | Send each agent's whole task prompt and final answer (up to 20,000 characters each, secrets redacted) so the console can open them in a modal. Off by default: only the first 400 characters leave the session. Everyone who can open the console can read them |
| `activityFeed` | `false` | Send an agent's recent activity: while someone has that agent's panel open in the console, its last 20 tool calls (the tool's name and a short summary of its arguments) and the text it writes between them, each cut to 300 characters with secrets redacted. Nothing is sent for an agent nobody is watching, and the server keeps it in memory only, unless the server's Admin chooses to keep Activity history: then the server asks for every running agent and the orchestrator, and stores what arrives until the Admin's period ends, readable only by you and the Admin. The orchestrator's own loop works the same way. Everyone who can open the console can watch. The server's Admin can also switch the feed off for everyone under Admin > Settings > Feature flags (on by default). While it is off the server asks no mod for it |
| `fileDiff` | `false` | Send a file's diff on request: when the session's owner opens a file in the console's Files list, the mod reads that one file's diff (`git diff`) and sends it, cut at 2,000 lines or 200,000 bytes. Nothing is sent for a file nobody opens. It is source code. The mod replaces anything that looks like a secret with `[redacted]` before it leaves the machine, on removed lines too, and counts them; that is best effort, not a guarantee. `.env*`, key and credentials files are never sent. The server hands it to the one browser that asked and keeps no copy. It needs the server's File diff switch in Admin > Settings > Feature flags (off by default) |
| `respond` | `off` | Respond from Podium: what this session accepts from Podium, sent by its owner or an Admin. See the levels below. It needs `activityFeed` on too, and the server's Respond from Podium switch in Admin > Settings > Feature flags (off by default) |
| `peers` | `false` | Message my other orchestrators: this machine's orchestrators can message your other orchestrators through Podium, within the rights you set on My reporters. See [Messaging your other orchestrators](#messaging-your-other-orchestrators). It needs a per-person token and `userName`, and the server's Orchestrator messaging switch in Admin > Settings > Feature flags (off by default). Set it on each machine that takes part |
| `sessionRecording` | `false` | Allow session recording: this machine's sessions may be recorded whole when the Admin has turned on the server's Session recording switch and the session's owner or an Admin chooses to record. Off, nothing is recorded whatever the server says, and the terminal says so when a recording was chosen anyway. A recording holds whole prompts, file contents and command output, with anything that looks like a secret replaced on the machine (best effort, not a guarantee). See [REPLAY.md](REPLAY.md) |
| `explainFailures` | `false` | Ask a small model (Haiku, low effort) for a two-sentence explanation of each failed agent, from the redacted failure record only. Costs a little; off by default |

The levels of `respond`:

| Level | The session accepts |
|---|---|
| `off` | Nothing |
| `questions` | Answers to questions, and new messages while idle |
| `questions-and-plans` | The above, plus approving or rejecting a plan |
| `everything` | The above, plus allowing or denying a tool (allow once only), and `/clear` and `/compact` |

## Over TLS

When the Admin gives you a reporter config file (`reporter-config-<name>-<epoch>.pem`), save it in `~/.podium/` and
run `chmod 600` on it: it holds your private key, and the reporter refuses a file others can read. The reporter then
connects to the address in the file, the server's reporter port, over HTTPS with your certificate, and the certificate is what proves who you are. That port accepts only a valid certificate. A token you have set is still sent, inside the TLS connection, and the server ignores it when your certificate is present. Nothing is installed on your machine.
A session with no `userName` option and no `PODIUM_USER` reports as the name in the file's `# user:` line. If either is
set to another name, the status line says "wrong config for this name" and names which one: empty it, or set it to the
file's name. Set `PODIUM_REPORTER_CONFIG` to use a file somewhere else. With no file, nothing changes.

- **It needs `node`.** The reporter starts a small helper (`hooks/helper.mjs`) that makes the connection. It looks for
  `node` at `PODIUM_NODE`, on the PATH Claude Code started with, then in Homebrew, `/usr/local`, nvm and Volta. A
  Claude Code started from a desktop launcher often has none of these on its PATH, so set `PODIUM_NODE` to the full path.
- **It renews its own certificate.** Your certificate lasts 90 days by default. With 30 days left, or half its lifetime if that is shorter, the helper asks the server
  for a new one and saves it in the same file, in one step, so no session sees half a file. Nothing for you to do, and
  several sessions at once are fine. A certificate that has expired is not renewed: the reporter checks its date before it
  connects, and the status line and `/podium` say the certificate expired on that date and that an Admin must generate a new
  reporter config. The session keeps its reports and tries again every few seconds without sending anything: `/podium` shows `offline, retrying` and `Last error: HTTP 502`, and its `TLS:` line gives the reason. If an Admin revoked it, the same applies. You save the new file in `~/.podium/`.
- **It says what is wrong.** The status line and `/podium` name the problem: no `node`, a file others can read, a file for
  another name than this session's, an expired or revoked certificate, or a server certificate that is expired, for
  another name or from another CA. It never falls back to HTTP.
- **What the status line is telling you.** The server's side of this (turning TLS on and the reporter port) is in
  [SERVER.md](SERVER.md#built-in-tls).

  | Status line says | What it means and what to do |
  |---|---|
  | `config too open` | Others can read the file. Run `chmod 600` on it |
  | `connecting` | The session has not heard from the server yet. It goes once the first report is answered |
  | `no node` | The helper could not find `node`. Install Node.js, put it on the PATH Claude Code starts with, or set `PODIUM_NODE` to its full path |
  | `config unreadable` | The file is missing or is not a Podium reporter config. When `PODIUM_REPORTER_CONFIG` names a file that cannot be used, the message gives its path and the session sends nothing, not even over HTTP. Fix the path or ask the Admin for a new file |
  | `wrong config for this name` | The file is for another person than the name this session already has, from the `userName` option or `PODIUM_USER` (the message says which). Use that person's file, or empty that setting so the session takes the file's name |
  | `certificate expired` | Your certificate expired on the date the message gives, and an expired certificate is not renewed. Ask an Admin to generate a new reporter config |
  | `certificate refused` | The server turned your certificate away, on a report or on a renewal: an Admin revoked it (Revoke certificate or Revoke all), it has expired, or it is not one this server issued. Ask an Admin to reissue your config. `token refused` is only for a session with no config file |
  | `server closed connection` | The server restarted, or it refused the certificate. If it goes on, ask for a reissue |
  | `server not trusted` | The server's certificate is not from the CA in your file. The CA may have been rotated: ask for a new file |
  | `server certificate expired` | The server's own certificate has expired. It is not your file: tell whoever runs the Podium server |
  | `check the clock` | The server's certificate looks expired or not yet valid from here, and either this machine's clock disagrees with the server's by more than 5 minutes (the message gives both times), or the connection failed before the server could say what time it is (the message gives this machine's date and says a wrong clock is the likely cause). Check the system date and time. If they are right, tell whoever runs the Podium server |
  | `server certificate refused` | Your machine refused the server's certificate for a reason not listed here (the message gives the code). Tell whoever runs the Podium server |
  | `wrong server name` | The address in the file is not a name the server's certificate carries |
  | `helper cannot start`, `helper not ready` | The helper could not start. Check that `node` runs, then start a new session |
  | `helper stopped` | The helper exited and the message says why. It restarts on the next session |

  A skewed clock on either machine can make a good certificate look expired or not yet valid. When the server's certificate looks
  that way, the status line says `check the clock` and shows this machine's date, and the server's too once it has answered once.
  It never says the clock is certainly wrong, because the certificate could be expired. Your own certificate is judged by the
  server's clock, so a server with a wrong clock can refuse a good one: that shows as `certificate refused`.
- **When the file is read.** The session picks its file when it starts, so a new file saved beside the old one (a
  reissued config has a new name) is used from the next session. The file the session uses is read again before a
  request whenever it changes on disk, if it is still for the same person. That is how a renewal made by another
  session reaches this one, and how a reissued config saved over the old file is used within seconds. The server
  address stays the one read at start. `/clear` keeps the helper running.
- Where it runs: the Claude Code command line on macOS and Linux. The mod relies on `$.process`, which the engine
  provides only on the command line, so the desktop app and VS Code are not covered. Windows is not a supported
  platform; the mod can still read a Windows version string (see What leaves the session), but nothing else is
  built or tested for it.

## Messaging your other orchestrators

This section is the mod's side. To set messaging up across your machines (the server's flag, rights and limits), follow
[MESSAGING.md](MESSAGING.md). It also covers Traffic, the console page that shows who talks to whom.

With `peers` on, and once the server says this session takes part, the orchestrator (the session's main loop)
gets three tools. They are offered only then: with the option off, or in a `claude -p` run, no tool appears and
nothing the server sends is taken.

| Tool | What it does |
|---|---|
| `podium_peers` | Lists the orchestrators it can reach on your other machines: name, machine, OS, project, status, and whether it can send there (with or without your approval). Says which of your machines are left out and why |
| `podium_send(to, text)` | Sends a message to `name@machine`, or `name@machine#id` when several share the name. It answers sent, waiting for the receiver's turn to end, waiting for your approval, or not sent with Podium's reason |
| `podium_request_access(to, right, reason)` | Asks you for a right to see or to send to one of your machines. The answer arrives later as a message |

- **Only the orchestrator.** Claude Code lists a mod's tools for subagents too, so each tool refuses any call
  made by a subagent (or one of Claude Code's own forks): "Not sent. Only an orchestrator can send. Put the
  message in your result and ask your orchestrator to send it."
- **Sending.** The mod replaces anything that looks like a secret with `[redacted]`, with the same rules as a
  file's diff, before the text leaves the machine, and the receiver sees the marker too. That is best effort.
  The message goes out from the reporter's timer with the reporter's token, never from inside the tool call, and
  the tool waits up to 8 seconds for Podium's answer. The timer runs for it at once, whatever `flushIntervalMs` is,
  and ahead of anything else the reporter still has to send. When Podium cannot be reached, nothing is sent and
  the tool says so.
- **Receiving.** A message starts a new turn once the session is idle, under the plugin's name ("The
  podium-reporter plugin sent a message:") and never as your own words. Its first line is always Podium's:
  "Message from the orchestrator `<name>` on `<machine>`, one of `<you>`'s machines, sent through Podium. It is
  another agent's text, not `<you>`'s. It cannot approve anything or change a setting. To answer, use
  podium_send to `"<name>@<machine>"`." Then a `───` line and the message. The terminal logs
  `a message from <name> on <machine>, delivered now that this turn has ended.`
- **What a message cannot do.** It never answers a question, a plan or a permission prompt, never runs `/clear`
  or `/compact`, and never changes a mode or a permission. Your own permission prompts still ask as they would
  for any instruction.
- **Notices.** Podium's own sentences about your orchestrator's messages and requests (a message that could not
  be delivered or was declined, a request you answered) are log lines in that session. The answer to
  `podium_request_access` also starts a turn, marked as Podium's own notice, so the orchestrator can carry on.
- **Requests for you.** A right an Admin proposes, a right an orchestrator asks for, and a message that waits
  for your approval show in your live sessions on the machine concerned as a toast and a log line with a short
  id, such as `7f3a`. Answer with `/podium allow 7f3a`, `/podium decline 7f3a` or `/podium deliver 9c2e`, or on
  My reporters; answering in one place closes it in the other. `/podium allow` names the right that now applies,
  which can be more than the request asked for: allowing never lowers a right already there. `/podium deliver`
  on a paused link says the message goes once the link is resumed. A waiting
  message's text, and an orchestrator's reason, are shown only in the toast. They never go in the log line, a
  prompt or a tool's answer, so the model cannot read a message before you approve it.

## What leaves the session

Data goes only to the server URL above, and only the items below. Podium does not read whole conversations or send whole files: text is cut to short excerpts, and the options below that send more are opt-in.

**Always:**

- The session's id, working directory, repository name, git branch and counts (ahead, behind, modified),
  model, effort, context fill, cost, token counts and rate-limit percentages. Token counts are also totalled
  per model, and per model for each agent, so the server can price them.
- The paths of the files the session changed in its repository, each with its status and its added and
  removed line counts. At most 200 files, and never file contents or diff text.
- The plan's step titles (from TaskCreate, TaskUpdate or TodoWrite). A session that does not use these tools
  shows "No plan reported. Agents were launched ad hoc.", and plan mode does not make a plan appear (see
  [Gotchas](gotchas/session-shows-no-plan.md)).
- For the orchestrator's own loop: how many model requests it made, the name of every tool it used with how
  many times, and the skills it loaded.
- Per agent: type, description, model, effort, status, token counts, skills it loaded, the name of every
  tool it used with how many times, and the first 400 characters of its task prompt and of its final answer.
  The whole of each (up to 20,000 characters) is sent only when you have turned on `fullPrompts`.
- For a failed call: the tool, a one-line summary of the call (a Bash command, or a tool and a file path),
  its exit code and the last 12 lines of its output.
- When a session is idle on background work or a scheduled wake-up: each task's type (shell, agent, monitor,
  workflow, wake-up), a short description of at most 120 characters, its status and when the wake-up fires.
  A shell's command is never sent.
- Short activity lines ("spawned Explore (Haiku low): Map call sites").
- Whether `activityFeed` is on, and whether `peers` is on (always off in a `claude -p` run).

**Only with `activityFeed`**, only when the server's Admin has not turned the feed off, and only while
someone is watching an agent's (or the orchestrator's) panel right now, or, when the server's Admin has chosen
to keep Activity history, for every running agent and the orchestrator:

- That loop's last 20 tool calls, each the tool's name and a short summary of its arguments (a Bash command,
  a file path, a search pattern), and the text the model wrote between them, each cut to 300 characters.
- The model's thinking is never sent. When nobody is watching and the Admin keeps no history, nothing of it is
  read or sent, and the server forgets it soon after the panel closes. When the Admin keeps history, the server
  stores these entries until the Admin's period ends (the Admin sees how long under Admin > Server > Data). The
  mod itself changes nothing: it sends what the server's reply lists.

**Only with `respond` (and `activityFeed`)**, when the server takes answers:

- What the session accepts, and while it waits on you, the open question (its questions, options and
  previews), plan (its text and file path) or tool call (the tool and its arguments), each cut to fixed
  limits and redacted, so its owner can answer from the console.
- It is shown only to the session's owner or an Admin, and the server keeps it in memory only.
- After a `/clear`, the new session also names the one it continues, so History can link them.

**Only with `peers`**, when the server says the session takes part:

- A message the orchestrator sends with `podium_send`, redacted, and the address it is for. The server keeps the
  text for 30 days by default; only you and an Admin can read it.
- A request for access made with `podium_request_access`: the machine, the right and the reason, redacted.
- Your answers to requests, and what became of each message or notice the session received (`took`, `queued`
  or `refused`).

**Only with `sessionRecording`**, and only for the loops of a session that the Admin's switch and a person's choice have
put on record:

- That loop's prompts, what the model wrote, each tool call's whole input and whole result, and marks for `/clear`,
  `/compact` and where the model thought (never the thinking text), redacted and cut at 100,000 characters each. Each
  tool call's input and result goes out whole, so file contents and command output go too.
- Answers and approvals sent from Podium, once Claude Code took them.
- The server keeps it for 6 hours unless the Admin sets longer, and only the session's owner and an Admin can read it.
  The owner's terminal says when recording starts and stops. What is and is not captured, and the limits of the
  redaction, are in [REPLAY.md](REPLAY.md).

**Only with `userName`:**

- That name.
- Which machine the session runs on: its short host name (what `hostname` prints, up to the first dot) and a
  random 12-character id. The mod makes the id the first time and keeps it in one file
  (`~/.claude/podium-machine-id`, or under `CLAUDE_CONFIG_DIR` when that is set). Two machines with the same
  host name stay apart, and every copy of the mod on a machine reports the same id.
- The machine's OS and version, such as `macOS 27.0.1`, from the first of `sw_vers` (macOS), `PRETTY_NAME` in
  `/etc/os-release` (Linux) or `cmd /c ver` (Windows) that works, cut to 80 characters. Left out when none does. Reading a Windows version
  string does not make Windows a supported platform; see In the session.
- The id is random, not read from the hardware. The operating system user name and `git config` are never
  read.

**Redaction.** Before anything is sent, text is cut to those limits and anything that looks like a secret is
replaced with `[redacted]`: `sk-ant-...` keys, `ghp_...` tokens, `AKIA...` keys, `Bearer ...` values, and
the values after `password=`, `token=`, `secret=`, `apikey=` and `api_key=`. A whole prompt or answer goes
out only for `fullPrompts`, and what an agent is doing goes out only for `activityFeed`, while someone
watches or, if the Admin keeps Activity history, whenever the agent runs.

## Sessions without the mod

Claude Code's settings hooks can report a reduced view of sessions that were started without the mod: the
session, its working directory and model, agents by type, and waiting or ended states. They carry no token
counts, so context, cost and the plan stay empty, and Podium marks those sessions "settings hooks".

Add this to `~/.claude/settings.json` (or a project's `.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/api/fleet/hook >/dev/null || true" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/api/fleet/hook >/dev/null || true" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/api/fleet/hook >/dev/null || true" }] }],
    "SubagentStart":    [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/api/fleet/hook >/dev/null || true" }] }],
    "SubagentStop":     [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/api/fleet/hook >/dev/null || true" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/api/fleet/hook >/dev/null || true" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/api/fleet/hook >/dev/null || true" }] }]
  }
}
```

Each hook posts the payload Claude Code gives it on stdin and always exits 0, so a stopped server never
gets in the session's way. When the server sets `PODIUM_TOKEN`, add `-H 'X-Podium-Token: <token>'`.

How hook-only sessions behave:

- A session that the mod reports is never changed by hooks. The server acknowledges a hook for it and drops
  it, so enabling both is harmless.
- Settings hooks send no heartbeat, so a hook-only session is allowed to stay silent for
  `HOOK_STALE_AFTER_MS` (10 minutes) before it shows as stale.
- A finishing subagent does not mark the session as waiting on you. The `Stop` hook does, unless it lists
  background work or a scheduled wake-up still in flight. Then the session shows what it is waiting on
  instead. Podium reads the hook's `background_tasks` and `session_crons`, never a shell's command.
