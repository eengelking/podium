# The reporter mod

`podium-reporter` is the Claude Code mod that sends a session's data to the Podium server. This page is for
anyone installing or configuring it. It covers installing the mod, its options, exactly what leaves a
session, and how to report sessions that were started without it. To run the server, see
[SERVER.md](SERVER.md).

Contents:

- [Install the mod](#install-the-mod)
- [In the session](#in-the-session)
- [Options](#options)
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

Without a token the server accepts, or with a token that does not belong to your name, the reporter gets
HTTP 401, logs it once, and tries again about once a minute. `/podium` and the status line say so.

To work on the mod itself, load it from a checkout for one session instead:

```sh
claude --plugin-dir /path/to/podium/mod/podium-reporter
```

To update an installed mod, run this in a shell and then `/reload-plugins` in the session (see "Updating
the mod" in [USER_GUIDE.md](USER_GUIDE.md)):

```sh
claude plugin marketplace update eengelking-marketplace && claude plugin update podium-reporter@eengelking-marketplace
```

## In the session

The session appears in Podium once you send its first prompt. A session that has done nothing yet is kept
off the wall, because Claude Code's background daemon also runs idle twins and spares that report too (see
"Sessions that have not done anything yet" in [USER_GUIDE.md](USER_GUIDE.md)).

- `/podium` prints the dashboard link, the connection state and report counts.
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
line, not a Podium warning (see [GOTCHAS.md](GOTCHAS.md)).

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
| `activityFeed` | `false` | Send an agent's recent activity: while someone has that agent's panel open in the console, its last 20 tool calls (the tool's name and a short summary of its arguments) and the text it writes between them, each cut to 300 characters with secrets redacted. Nothing is sent for an agent nobody is watching, and the server keeps it in memory only. The orchestrator's own loop works the same way. Everyone who can open the console can watch. The server's Admin can also switch the feed off for everyone under Admin > Settings > Feature flags (on by default). While it is off the server asks no mod for it |
| `fileDiff` | `false` | Send a file's diff on request: when the session's owner opens a file in the console's Files list, the mod reads that one file's diff (`git diff`) and sends it, cut at 2,000 lines or 200,000 bytes. Nothing is sent for a file nobody opens. It is source code. The mod replaces anything that looks like a secret with `[redacted]` before it leaves the machine, on removed lines too, and counts them; that is best effort, not a guarantee. `.env*`, key and credentials files are never sent. The server hands it to the one browser that asked and keeps no copy. It needs the server's File diff switch in Admin > Settings > Feature flags (off by default) |
| `respond` | `off` | Respond from Podium: what this session accepts from Podium, sent by its owner or an Admin. See the levels below. It needs `activityFeed` on too, and the server's Respond from Podium switch in Admin > Settings > Feature flags (off by default) |
| `peers` | `false` | Message my other orchestrators: this machine's orchestrators can message your other orchestrators through Podium, within the rights you set on My reporters. See [Messaging your other orchestrators](#messaging-your-other-orchestrators). It needs a per-person token and `userName`, and the server's Orchestrator messaging switch in Admin > Settings > Feature flags (off by default). Set it on each machine that takes part |
| `explainFailures` | `false` | Ask a small model (Haiku, low effort) for a two-sentence explanation of each failed agent, from the redacted failure record only. Costs a little; off by default |

The levels of `respond`:

| Level | The session accepts |
|---|---|
| `off` | Nothing |
| `questions` | Answers to questions, and new messages while idle |
| `questions-and-plans` | The above, plus approving or rejecting a plan |
| `everything` | The above, plus allowing or denying a tool (allow once only), and `/clear` and `/compact` |

## Messaging your other orchestrators

This section is the mod's side. To set messaging up across your machines, with the server's flag, rights, limits and
Traffic, follow [MESSAGING.md](MESSAGING.md).

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

Data goes only to the server URL above, and only the items below. Podium never reads transcripts or files.

**Always:**

- The session's id, working directory, repository name, git branch and counts (ahead, behind, modified),
  model, effort, context fill, cost, token counts and rate-limit percentages. Token counts are also totalled
  per model, and per model for each agent, so the server can price them.
- The paths of the files the session changed in its repository, each with its status and its added and
  removed line counts. At most 200 files, and never file contents or diff text.
- The plan's step titles (from TaskCreate, TaskUpdate or TodoWrite). A session that does not use these tools
  shows "No plan reported. Agents were launched ad hoc.", and plan mode does not make a plan appear (see
  [Gotchas](GOTCHAS.md#a-session-shows-no-plan)).
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
someone is watching an agent's (or the orchestrator's) panel right now:

- That loop's last 20 tool calls, each the tool's name and a short summary of its arguments (a Bash command,
  a file path, a search pattern), and the text the model wrote between them, each cut to 300 characters.
- The model's thinking is never sent. When nobody is watching, nothing of it is read or sent, and the server
  forgets it soon after the panel closes.

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

**Only with `userName`:**

- That name.
- Which machine the session runs on: its short host name (what `hostname` prints, up to the first dot) and a
  random 12-character id. The mod makes the id the first time and keeps it in one file
  (`~/.claude/podium-machine-id`, or under `CLAUDE_CONFIG_DIR` when that is set). Two machines with the same
  host name stay apart, and every copy of the mod on a machine reports the same id.
- The machine's OS and version, such as `macOS 27.0.1`, from the first of `sw_vers` (macOS), `PRETTY_NAME` in
  `/etc/os-release` (Linux) or `cmd /c ver` (Windows) that works, cut to 80 characters. Left out when none does.
- The id is random, not read from the hardware. The operating system user name and `git config` are never
  read.

**Redaction.** Before anything is sent, text is cut to those limits and anything that looks like a secret is
replaced with `[redacted]`: `sk-ant-...` keys, `ghp_...` tokens, `AKIA...` keys, `Bearer ...` values, and
the values after `password=`, `token=`, `secret=`, `apikey=` and `api_key=`. A whole prompt or answer goes
out only for `fullPrompts`, and what an agent is doing goes out only for `activityFeed`, while someone
watches.

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
