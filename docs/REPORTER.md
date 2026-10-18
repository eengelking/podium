# The reporter mod

`podium-reporter` is the Claude Code mod that sends a session's data to the Podium server. This page is for
anyone installing or configuring it. It covers installing the mod, its options, exactly what leaves a
session, and how to report sessions that were started without it. To run the server, see
[SERVER.md](SERVER.md).

Contents:

- [Install the mod](#install-the-mod)
- [In the session](#in-the-session)
- [Options](#options)
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
| `respond` | `off` | Respond from Podium: what this session accepts from Podium, sent by its owner or an Admin. See the levels below. It needs `activityFeed` on too, and the server's Respond from Podium switch in Admin > Settings > Feature flags (off by default) |
| `explainFailures` | `false` | Ask a small model (Haiku, low effort) for a two-sentence explanation of each failed agent, from the redacted failure record only. Costs a little; off by default |

The levels of `respond`:

| Level | The session accepts |
|---|---|
| `off` | Nothing |
| `questions` | Answers to questions, and new messages while idle |
| `questions-and-plans` | The above, plus approving or rejecting a plan |
| `everything` | The above, plus allowing or denying a tool (allow once only), and `/clear` and `/compact` |

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
- Whether `activityFeed` is on.

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

**Only with `userName`:**

- That name.
- Which machine the session runs on: its short host name (what `hostname` prints, up to the first dot) and a
  random 12-character id. The mod makes the id the first time and keeps it in one file
  (`~/.claude/podium-machine-id`, or under `CLAUDE_CONFIG_DIR` when that is set). Two machines with the same
  host name stay apart, and every copy of the mod on a machine reports the same id.
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
