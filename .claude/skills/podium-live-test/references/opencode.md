# OpenCode

Variables: `LIVE="$TMPDIR/live-oc"`, `B=http://127.0.0.1:4382`, `SOCK=liveoc`, `T=liveoc:planner`. Needs `node`, `curl`, `git`, `tmux` and `opencode` (2.x) on `PATH`, and a built checkout. A run takes about twenty minutes and costs nothing with a local model or an OpenCode free hosted model.

**The model.** `--opencode-model PROVIDER/MODEL` is required and never defaulted. Use a free one: a local model in LM Studio, or an `opencode/...-free` model (`opencode models` lists them; those need no sign-in). A small model may not follow a tool prompt exactly, and may call a tool you did not name: check that it answers before you blame the reporter. Cost reads `0`; that is not a failure.

## Start

```sh
export LIVE="$TMPDIR/live-oc"; export SOCK=liveoc; tmux() { command tmux -L "$SOCK" "$@"; }
scripts/podium-peers-e2e.sh up --dir "$LIVE" --port 4382 --tmux liveoc --sessions 1 \
  --harness opencode --opencode-model opencode/<name>-free \
  --activity-output --session-recording --file-diff
```

For a local model, name its provider block in a JSON file and pass `--opencode-config "$PWD/lmstudio.json"` with `--opencode-model lmstudio/<model>`; the script's model and `ask` permissions win over the file. `up` rebuilds every time (`--no-build` skips only the server and UI build; the plugin is always rebuilt and copied). The seed adds five made-up sessions that go stale; ignore them. The TUI shows the model name under the prompt when ready. There is no trust prompt.

**Isolation.** Each window gets a scratch home (`$LIVE/home-<window>`) holding the plugin built from the checkout, so nothing reaches the real `~/.podium` or `~/.config/opencode`. It runs `opencode --standalone`, because otherwise OpenCode talks to a background service started with another environment (a service you already run is not touched, and `down` does not stop it). Consent and the respond level come only from `PODIUM_*` variables, in the window's env file `$LIVE/oc-env-<window>.sh` (mode 0600), never from `opencode.json`. `PODIUM_FULL_PROMPTS` and `PODIUM_EXPLAIN_FAILURES` have no `up` flag: add them to that file right after `up`, then restart OpenCode in the window (Ctrl+C, then `. $LIVE/oc-env-planner.sh; opencode --standalone`), because the reporter reads them at start. The project's `opencode.json` sets `ask` for shell (the key is `bash`) and edit, so a tool call raises a permission ask.

## Wiring (C1)

Source the helpers (`LIVE`, `B`, `T` set) and `live_signin`. OpenCode shows a completion list first. For a bare `/podium` the first Enter accepts the completion and the second runs it; for `/podium config` typed in full the first Enter runs it, and a second Enter picks the first row of the window. Read the toast within a few seconds:

```sh
say '/podium'; sleep 1; tmux send-keys -t "$T" C-m; sleep 1; tmux capture-pane -p -t "$T" | grep -E 'fleet console|Home folder|Connection|Reports sent'
```

`Podium fleet console` reads `http://127.0.0.1:4382/#/`, `Home folder` is `$LIVE/home-planner` (the toast wraps at the pane width, so match on the wrapped lines), `Connection` is `online`, `Reports sent` is above 0 with `failed: 0`; `reporterName` is `podium-reporter-opencode`. Then `say 'Say hi in one word.'; sleep 15` and confirm the session shows on the throwaway server and not on the real one.

## Scenario notes

| # | OpenCode specifics |
|---|---|
| C2, C3 | Prompt `Use the bash tool to run exactly: touch allow-me.txt` (add `Do not run anything else.` for deny). Files are in `$LIVE/proj-planner`. An open ask shows `Allow once  Always allow  Reject`; answer promptly, because the model often runs one more command and a next ask follows a few seconds later: loop on `live_asks` until it stays empty. |
| C4 | `Use the question tool to ask me one question: "Favorite color?" with options Red and Blue. Then tell me which I chose.` Only offered with a TUI attached or a background service (see exclusions). |
| C5 | The session shows a message that starts with a line saying it came through Podium (`[Message from X via Podium, not typed at this terminal]`), then `PONG-FROM-PODIUM`. |
| C6 | The server log says `came back queued`, then `came back took` (#1011). |
| C7 | The log says `ran /compact ... came back took`, and the `compact` event has `trigger:"manual"` and a token drop. A `Compaction` block was not seen in the pane: rely on the event. |
| C8 | `export PODIUM_RESPOND=questions` in a second window before starting OpenCode. `accepts` is `[question, message]`. |
| C9 | A window with `export PODIUM_RESPOND=` (empty wins over the file). `live_json <id> respond` reads `{"level":"off","accepts":[],"limits":[]}` (#1011). Claude Code's `limits` can differ at `off` and `questions`: it reports `no-permission-hooks` when a prompt shows with no PermissionRequest hook within 2 seconds, which OpenCode, with no such hook, never says (#1167). It removes no kind those levels allow, and the wall does not read it, so `accepts` is what to compare. |
| C10 | `costSource` is `harness` and cost is `0` for a free model. Effort is the model variant (`opencode run -m <provider/model>#<variant> "..."`) and reads `default` with no variant. `usageByModel` is sent but not stored. There is no `rateLimits` key at all. Context window comes from `ctx.model.list` on a later report, so check after a second turn. `loop.toolCounts` can hold an `execute` key, which Claude Code never has: `execute` is OpenCode's own Code Mode tool (the name is reserved), and a script run through it can call only `opencode.*`, `plan` and `podium_*` tools, never `shell` or `question`. A count such as `{ execute: 4, Bash: 3, AskUserQuestion: 1 }` is eight separate calls, not a double count (#1045, closed as not a bug after a live run), so do not file it. |
| C11 | `Use the task tool to launch one general subagent with the prompt "Reply with the single word AGENT-OK"`. Subagents are child sessions; the permission ask's `agentId` is the child session id. Needs `PODIUM_FULL_PROMPTS`. |
| C12 | Tool names are mapped (`shell` is shown as Bash); `output` needs `--activity-output`. |
| C15 | A subagent that reads `/nonexistent/file.txt` and then finishes normally ends `done` with `failure: null` (as on Claude Code, #1021), and no `fail` event: the event comes only when the child's run fails (`session.execution.failed`) or a step fails, which was not provoked cheaply, so report NOT RUN for the `fail` event unless you can. A failed main-loop tool call, a non-zero shell exit included, makes no `fail` event either, as on Claude Code (#1012); assert that none appears. |
| C16 | `Call the plan tool with title "X"`. A title-only call gives `plan.title` X with no steps. A small model may call `plan` as a shell command: say `call the plan tool` and deny the shell ask. |
| C17 | Ctrl+C prints `Continue  opencode -s <id>`, a handy way to get the id. Killing the only tmux window ends the session, so open a second one first. Leave with Ctrl+C (not Ctrl+D, which closes the shell and the tmux server), start a new window with `new-session ... -c "$LIVE/proj-planner"`, source `$LIVE/oc-env-planner.sh`, run `opencode --standalone -s <session id>`. |
| C18 | `add` refuses a file that is not a reporter config: make two small ones in the scratch home (v1 header, a `# user:` line, an `https` `# server:` line, an `# issued-at:` epoch, mode 0600, named `reporter-config-<name>-<epoch>.pem`). |
| C19 | The tools `podium_peers` and `podium_send` are removed (the model says the tool was removed), and the footer has no messaging text. |
| C20 | Choose in the TUI. The later `live_answer` returns `{"error":"closed","outcome":"terminal"} [410]` while the session is still on that turn, and `404 unknown ask` once a report shows it running again (SPEC 7.1, #829). |
| C21 | Restart the server as in the core row and `live_signin` again. The footer goes `offline` then `live` and the ask is listed again. `Reports sent` `failed` can read `0` after an outage of about 9 seconds (seen live; Claude Code read 2). Both reporters use the same core transport and heartbeat, and a report only fails when one is attempted during the outage, so do not assert `failed` above 0 on OpenCode (#1167, cause not found in the code). |
| C22 | The first Ctrl+C with an ask open rejects the ask (outcome `terminal`) and does not exit; a second one ends the session with `status:"done"` and an `endReason` of `detached` or `shutdown`, whichever the host does first: the TUI leaving reports `detached` (#1029; seen live on a clean exit of `--standalone`), the plugin cleaning up with the TUI still counted reports `shutdown`, and a killed process gives `shutdown` (#1167). `attached` stays true for a done session. A session quiet for `idleSeconds` with no TUI attached goes `done`; with a TUI it stays `waiting`. Closing the TUI of a session served by OpenCode's background service (no `--standalone`) reports `done` with `endReason:"detached"` within a few seconds when the session is quiet, and the card is gone about 10 s after the close (#1029). That run needs a scratch service on its own port: `opencode service set port <free port>` with the window's scratch `HOME`, never your own service. |

**Extra checks the OpenCode reporter offers** (run when the change touches them): skills (`SKILL.md` in `$LIVE/proj-planner/.opencode/skills/<name>/`, then `live_json <id> loop.skills`); failure detail (deny a shell call, and `read` on `/nonexistent/file.txt`, expect class `Blocked by permission` or `Tool error`); explain failures (a failed agent's failure, as on Claude Code, needs `PODIUM_EXPLAIN_FAILURES`; the root session's own failure is not explained, #1012); `podium_peers` (needs `PODIUM_PEERS=true`); a no-TUI run (`opencode run --standalone -m <provider/model> "<prompt>"` from a shell that sourced the env file reports with `attached: null`, and `opencode serve --port 4390 --hostname 127.0.0.1` takes basic auth `opencode:<password>`; `opencode web` and the desktop app need a person for the pairing link, so say an agent cannot drive them).

## Exclusions and what to assert instead

| Capability | Why | Assert |
|---|---|---|
| Plan approve, plan feedback | Harness limit: no plan step (`UNSUPPORTED` in `plugin/opencode/answering.ts`) | `accepts` lacks both at every level. Do not answer a made-up ask id: that is `404 unknown ask`, not a refusal. |
| `/clear` | Harness limit: `capabilities.commands` is `['compact']` | `{"command":"clear"}` returns `422` with a message that the reporter does not take `/clear`. |
| Typed `reply` in place of a question | Reporter limit (`no-reply-in-place`) | `respond.limits` has `no-reply-in-place`; `{"kind":"reply"}` on a question returns `422 not accepted`. |
| Question with no TUI and no service | No channel for the form | The question is absent from `asks[]` and `accepts` lacks `question`. |
| Question with more than 4 options | Not offered by design, on every harness (`tooManyOptions` in `plugin/core/protocol.ts`, #1012) | The ask is absent from `asks[]`. |
| `attached: false`, fork command | Harness | `attached` is never false (true even for a done session); fork reads "not available"; resume is `opencode <cwd> --session <id>`. |
| A `podium` activity entry names the command (`allowed once: sh -c '...'`) | Harness: OpenCode's `permission.asked` names an action (`shell`) and resource patterns, not the call's input, so the ask's tool is `shell` and the server's feed text reads `allowed once: shell` (#1167) | Assert `allowed once: <action>`. |
| A shell call's `output` is empty when it printed nothing | Harness: the shell tool's result is one text that holds its own `(no output)` and `Exited with code N` lines, kept as OpenCode gives it | Assert `output` holds that text, and `exitCode` and `failed` from the exit line. |
| `spawn` event text `spawned <type> (<model>): <description>` | Harness: a child session is first seen on the bus with no type, model or description | Assert a `spawn` event whose text reads `launched a subagent`. |
| The message from Podium reads as typed text | Harness: a plugin prompt is an ordinary user message with no marker, so the reporter puts `[Message from <name> via Podium, not typed at this terminal]` in front (`framedMessage`); the recording and the card keep the text sent | Assert the model is told who wrote it. |
| Rate limits | Not on the event bus | There is no `rateLimits` key. |
| Terminal confirmation lines ("Answered from Podium by…") | Harness: no transcript to write to; intended (#1012) | A framed message text instead; no line is asserted. |
| Admin callout as a scroll-back line ("Admin reads in silence", #1051) | Harness: no transcript a plugin can write to without the model reading it | With a TUI attached, assert a toast (about 60 s, shown again after the status toast) and the line above the prompt (`session.composer.top`), and that no `session_message` row (OpenCode's own database) holds the Admin's text. With no TUI part (`opencode run`, `serve`) nothing is shown: assert the notice is still handed again by the server for the 5-minute window and shows when a TUI attaches within it. A re-read of the same thread inside 30 minutes keeps its id and shows once. |
| Plugin options `flushIntervalMs`, `heartbeatMs`, `sessionName` | An auto-discovered plugin may not receive options; unconfirmed | Skip and say so. |
| Idle `done` | Harness | With no TUI attached, `done` with `endReason:"idle"` after `idleSeconds`. |

**Expected, not a gap:** a run with no TUI (`opencode run --standalone`) is not kept on the board: it is `done` when its process ends and leaves the wall (DECISIONS 59), so its absence from `/api/fleet/state` is not a failure. The no-TUI checks (idle `done`, a question with no channel) need a session that stays up, so they were NOT RUN; do not count them as a fail.

**Known reporter gaps** (current behavior the run reports, each tracked in an issue; delete its wording when the issue is fixed). #1013: `git` for a repo with no commit. A shell permission ask carries `tool = {name:"shell", input:{resources:["touch x"]}}`, so `input` is the resources and not a `command`; the waiting note is built from the string resources only (#1012). A repo with no commit gives the session `git: null` although the footer shows the branch; `up` now makes one commit, so a run does not hit it.

## Shut down

```sh
scripts/podium-peers-e2e.sh down --dir "$LIVE" --tmux liveoc
tmux ls; lsof -nP -iTCP:4382 -sTCP:LISTEN; ls -d "$LIVE"      # all three show nothing of yours
```

Check the real `~/.podium` and `~/.config/opencode` have no new file from the run. A run that records its event stream may write it under `docs/fixtures/opencode/` (ignored by git): compare `git status --ignored --short` with the copy taken before `up`, remove what the run added, and list it in the report (SKILL.md, "Shut down").

## Troubleshooting

| What you see | Why | Do |
|---|---|---|
| `/podium` shows nothing | The completion list took the first Enter | Press Enter again and read the toast within a few seconds |
| The session never appears on the throwaway server | A reporter config in the real `~/.podium`, or the background service | Redo with the scratch home and `--standalone`, check the wiring |
| A session's name reads `[redacted]` | No title yet (`opencode run`) | Look again after the title is set, or use the TUI |
| `unknown session` on `live_say` | `done` after `idleSeconds` with no TUI attached | Send a prompt first; a TUI-attached session stays `waiting` |
| `live_asks` prints nothing | `permission` is not `ask`, the tool is read-only, or the report has not arrived | Check `opencode.json`, use a command that writes, wait |
| The model calls `plan` or `podium_peers` as a shell command | A small model confuses a tool name with a command | Say `call the plan tool` and deny the shell ask |
