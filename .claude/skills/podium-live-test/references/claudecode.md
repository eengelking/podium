# Claude Code

Variables: `LIVE="$TMPDIR/live"`, `B=http://127.0.0.1:4380`, `SOCK=live`, `T=live:planner`. Needs `node`, `curl`, `git`, `tmux` and `claude` on `PATH`, and a built checkout. A run takes about ten minutes and uses one Haiku session (a few cents); plan mode may use a larger model.

## Start

```sh
export LIVE="$TMPDIR/live"
scripts/podium-peers-e2e.sh up --dir "$LIVE" --port 4380 --sessions 1 --tmux live
export SOCK=live; tmux() { command tmux -L "$SOCK" "$@"; }
```

`up` builds the server, UI and plugin (`dist-dev/claudecode`), seeds one person with answering, messaging and the activity feed on, and opens the session with `--plugin-dir`. Add `--no-build` only when nothing changed. `--activity-output`, `--session-recording` and `--file-diff` turn on that Admin flag in the seed and that reporter option in the window (C12 to C14). `fullPrompts` and `explainFailures` have no flag: add them under `pluginConfigs["podium-reporter"].options` in `$LIVE/settings.json`, then restart the session (C11). The restart is `claude --resume <id> --plugin-dir <absolute worktree path>/dist-dev/claudecode --settings $LIVE/settings.json --model haiku --allowedTools mcp__podium-reporter__podium_peers mcp__podium-reporter__podium_send mcp__podium-reporter__podium_request_access` in the same window, which still holds `HOME` and `PODIUM_USER`/`PODIUM_TOKEN`. Use the absolute path: a relative one that does not exist makes Claude Code load the installed plugin and say `token refused`.

**Isolation.** The window's scratch home (`$LIVE/home-claude`) links every entry of the real home except `.podium`, so Claude Code stays signed in and no reporter config can send it to the real server. The side effect: the person's `~/.claude` settings and other plugins' hooks still load. Consent and the respond level come from plugin options in the `--settings` JSON, never from `PODIUM_*` (`PODIUM_RESPOND` has no effect here).

**First-run prompt.** A trust prompt may or may not appear (the folder can already be trusted): read `screen` first. If it does, its highlighted choice is "No, exit", so move down first:

```sh
sleep 8; tmux send-keys -t live:planner Down; sleep 1; tmux send-keys -t live:planner C-m
```

**Manual mode.** The session starts in auto mode, where tools run without asking. The cycle is auto, manual, accept-edits, plan, auto: one Shift+Tab (`tmux send-keys -t live:planner BTab`, then `screen 3`) reaches `manual mode on`, and three overshoot into plan mode. The person's linked `~/.claude` default mode can change where it starts. In manual mode a read-only Bash command (`ls`, `echo`) runs with no ask, so use a command that writes. Plan mode switches the model to Sonnet.

## Wiring (C1)

```sh
tmux send-keys -t live:planner -l '/podium'; sleep 1; tmux send-keys -t live:planner C-m
sleep 4; tmux capture-pane -p -t live:planner | grep -E 'fleet console|Home folder|Reports sent'
```

`/podium` runs at once (no completion list). `Podium fleet console` reads `http://127.0.0.1:4380/#/`, `Home folder` is the scratch home, `Reports sent` is above 0 with `failed: 0`; `reporterName` is `podium-reporter-claudecode`. If the console line shows another address, `/exit`, shut down and fix the isolation. Then source the helpers and `live_signin`.

## Scenario notes

| # | Claude Code specifics |
|---|---|
| C2, C3 | Prompt `Use the Bash tool to run exactly: touch allow-me.txt`. Files are in `$LIVE/proj-planner`. A deny with no text shows `Denied from Podium` on the screen. |
| C4 | `Use the AskUserQuestion tool to ask me one question: "Favorite color?" with options Red and Blue. Then tell me which I chose.` |
| C5 | The screen shows `Sent from Podium by <name>` then `PONG-FROM-PODIUM`. |
| C6 | Result is `queued`, then `took` when the turn ends. |
| C7 | The status-line meter goes back to about `100%` but it is Claude Code's own. The event is `kind:"compact"` with `data:{tokensBefore,tokensAfter}` and no `trigger` key. `context.tokens` falls only after the next prompt. |
| C8 | Set `"respond":"questions"` in a copy of the settings file and start a second window the way the answering-off window below does. `accepts` is `[question, message]`. |
| C9 | Open a second window with `"respond": "off"` in the settings (below). The card sends `respond:{level:"off",accepts:[],limits}`, so the console says "Responding … is turned off". |
| C10 | Cost is estimated: no `costSource`, and `null` for a model family the reporter does not know. `usageByModel` is stored. Rate limits are reported. |
| C11 | Full prompts need `fullPrompts` in the settings and a restart (see Start). Subagent kinds are subagent, fork and teammate. A subagent's own permission ask carries `agentId`. |
| C15 | A main-loop tool failure makes no `fail` event, and a subagent whose Bash you denied still ends `done`. A `fail` needs a stop-failure or API error or an exhausted context, which was not provoked cheaply: report NOT RUN unless you can. |
| C16 | A title-only call gives `plan.title` X with `source` `podium_plan` and no steps, as on OpenCode (#1012); before any call `plan` is `null`. |
| C17 | Resume with `claude --resume <id>` in a new tmux window in the same folder, with the same `--plugin-dir` and `--settings`. |
| C19 | The messaging tools (`podium_peers`, `podium_send`, `podium_request_access`) are not withdrawn; once registered they stay and refuse their calls. Assert the refusal. |
| C20 | Answer the permission prompt in the terminal (`1` then Enter). Observed: the ask is unknown within a second (`live_ask` and `live_answer` answer `404 unknown ask`), and `410 closed` with `outcome:"terminal"` was not seen on a live session, only on a session that ended. Report what you see; this is SPEC 7.1's rule that a closed ask is forgotten once a report shows the session running again (#829), and Claude Code runs again as soon as the terminal answer is taken. OpenCode reads `410` while its session is still on that turn, so the two differ in timing and not in rule (#1011). |
| C21 | Restart the server as in the core row. The reporter announces the open ask again within a few seconds. `/podium` cannot be typed while an ask dialog is open, so check the connection after answering. |
| C22 | Ctrl+C and Ctrl+D do nothing in a permission dialog: `kill -TERM` the `claude` child of the pane. Observed `status:"done"`, `endReason:"other"`, and the open ask closed as `terminal` (`denied`). A clean `/exit` gives `prompt_input_exit`. |

Answering-off window (also the C8 and C17 pattern): same scratch home and person, a settings copy with `respond` changed:

```sh
sed 's/"respond": "everything"/"respond": "off"/' "$LIVE/settings.json" > "$LIVE/settings-off.json"
tmux new-window -t live -n off -c "$LIVE/proj-planner"
tmux send-keys -t live:off "export HOME='$LIVE/home-claude' PODIUM_USER='$NAME' PODIUM_TOKEN='$TOKEN'; claude --plugin-dir '$PWD/dist-dev/claudecode' --settings '$LIVE/settings-off.json' --model haiku -n off" C-m
sleep 14; tmux send-keys -t live:off -l 'Say hello in one word.'; sleep 1; tmux send-keys -t live:off C-m
```

The folder is already trusted, so there is no prompt.

## Exclusions and what to assert instead

None of the core is excluded on Claude Code: it is the harness the core was written from. These are the places it differs, and the run asserts them.

| Capability | Why | Assert |
|---|---|---|
| Plan approve and plan feedback (extra, not in the core table) | Claude Code only. Run them: `Plan a tiny change: create hello.txt containing the word hi...` in plan mode, answer `{"kind":"plan-approve","mode":"default"}` (also `auto`, `acceptEdits`) or plan feedback; the session leaves plan mode, then asks to write the file (a `permission` ask). | `accepts` has `plan-approve` and `plan-feedback` at `questions-and-plans` and `everything`. |
| `/clear` (extra) | Claude Code only. `live_say $SID '{"command":"clear"}'` | The session ends with reason `clear` and the new id has `clearedFrom`; the log says `was dropped (session-ended)`. The new session is not on the server until its next turn, and its name reverts to the window's (a name set with `/podium name` is not kept, and the host's old `context.tokens` figure is held back, not reported under the new id, until the host answers with another one: #1014. A live run only sees the new session's first report, after its first turn, so it reads the fresh figure either way and cannot tell the hold from its absence; the unit test covers it). |
| Typed `reply` in place of a question's answer | Claude Code only | `{"kind":"reply","text":...}` on a question returns 202. |
| Question with more than 4 options | Not offered by design, on every harness (`tooManyOptions` in `plugin/core/protocol.ts`, #1012) | The ask is absent from `asks[]`. |
| Headless (`claude -p`) | `not-interactive` | `respond.limits` has `not-interactive`, `accepts` is empty, messaging is off. |
| No PermissionRequest hooks (managed setups) | `no-permission-hooks` limit | Not reproducible with `up`; skip and say so. |

## Shut down

```sh
tmux send-keys -t live:planner -l '/exit'; sleep 1; tmux send-keys -t live:planner C-m; sleep 2
scripts/podium-peers-e2e.sh down --dir "$LIVE" --tmux live
tmux ls; lsof -nP -iTCP:4380 -sTCP:LISTEN; ls -d "$LIVE"      # all three show nothing of yours
```

## Troubleshooting

| What you see | Why | Do |
|---|---|---|
| `/podium` shows another address | A reporter config in the real `~/.podium` chose the server | Redo the start with the scratch home |
| "Not logged in", or another plugin's hook asks you to sign in | The scratch home lacks links to your Claude Code files | Link every entry of the home except `.podium` |
| The trust prompt ends the session | Enter picked **No, exit** | Relaunch and press Down first |
| `live_asks` prints nothing | Auto mode, a read-only tool, or the report has not arrived | Shift+Tab to manual mode, use a command that writes, wait |
