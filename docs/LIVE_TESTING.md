---
title: "Live testing with tmux and a throwaway server"
description: "Run a real Claude Code or OpenCode session in tmux against your own Podium server, answer it from the API, check each result and shut it all down."
group: Project internals
---

# Live testing with tmux and a throwaway server

Unit tests and the browser suite cannot tell you that a real Claude Code or OpenCode session still behaves when Podium answers it. This page shows how to find out. You start a server of your own, start a real session in tmux that reports to it, drive the session with a few prompts, answer what it asks from the API, and check what happened in both places.

It is for a contributor, or an agent working for one, who has built Podium from a checkout and changed something a session can be answered through: a reporter, the answering code, the answer routes. For the browser suite, see [End-to-end tests](e2e/COVERAGE.md). For several sessions that message each other, see [Messaging](MESSAGING.md#a-run-with-real-sessions).

Contents:

- [What you get](#what-you-get)
- [Rules that keep you safe](#rules-that-keep-you-safe)
- [The helpers](#the-helpers)
- [Claude Code](#claude-code)
- [OpenCode](#opencode)
- [Notes for agents](#notes-for-agents)
- [Troubleshooting](#troubleshooting)

## What you get

A Claude Code run takes about ten minutes and uses one Haiku session, which costs a few cents. An OpenCode run takes about twenty minutes and costs nothing with a local model or one of OpenCode's free hosted models, because it sends tiny prompts. At the end you know, with the real harness, that Podium can:

- allow and deny a tool,
- answer a question,
- approve a plan (Claude Code only),
- send a message and `/compact`, and `/clear` (Claude Code only),
- and that a session with answering off refuses all of it.

The OpenCode part also checks what the OpenCode reporter sends: the changed files, the activity feed, a file diff, a recording, full prompts, the effort, the context window and the tools it adds.

## Rules that keep you safe

- **Use your own server.** Never point a test at the server you work with, and never put demo data in your own database. Every command below uses a new database in a temporary folder and a port you pick. Pick a port nothing else uses (4380 below for Claude Code, 4382 for OpenCode, so both can run at once).
- **Keep the session off your real server.** A reporter config file in `~/.podium/` makes a session connect to the server it names and ignore the address in its settings. Your test session would then appear on your real console and never reach the throwaway server. `podium-peers-e2e.sh` gives every window a scratch home without `.podium`, and the wiring check proves it worked.
- **Stop what you start.** The last step of each part removes the server, the tmux server, the temporary folder and the scratch homes. Do it even when a step failed.

## The helpers

These shell functions wrap the answer routes and the tmux window. `podium-peers-e2e.sh` runs tmux on a private socket named like its session (`--tmux`), so a window never joins another tmux server's environment, and every tmux command below must use it: the first line of the file makes plain `tmux` do so. Save them in a file in the work folder and `source` it in the shell you run the tests from, after the part you follow has started its server and written `$LIVE/seed.out`. Set four variables first: `LIVE` (the work folder), `B` (the server address), `SOCK` (the `--tmux` name, such as `live` or `liveoc`) and `T` (the tmux target, such as `live:planner`). Each write sends the person's sign-in cookie, an `Origin` that matches the host and `X-Podium-Respond: 1`; without all three the server answers `403 cross-site request refused`.

```sh
tmux() { command tmux -L "${SOCK:?set SOCK to the --tmux name}" "$@"; }
NAME=$(sed -n 's/^name=//p' "$LIVE/seed.out"); TOKEN=$(sed -n 's/^token=//p' "$LIVE/seed.out")
_w() { curl -s -b "$LIVE/cookies" -H "Origin: $B" -H 'X-Podium-Respond: 1' -H 'Content-Type: application/json' -w ' [%{http_code}]\n' "$@"; }

# Sign in once. Expect {"ok":true,...}.
live_signin() { curl -s -c "$LIVE/cookies" -H "Origin: $B" -H 'X-Podium-Respond: 1' -H 'Content-Type: application/json' \
  -d "{\"name\":\"$NAME\",\"token\":\"$TOKEN\"}" "$B/api/fleet/respond/sign-in"; echo; }

# Print "<session> <ask> <kind>" for every open ask. Prints nothing while none is open.
live_asks() { curl -s "$B/api/fleet/state" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  for (const s of d.sessions) for (const a of s.asks ?? []) if (a.state === "open") console.log(s.id, a.id, a.kind)'; }

# live_answer <session> <ask> '<json body>'
live_answer() { _w -d "$3" "$B/api/fleet/respond/sessions/$1/asks/$2/answer"; }

# live_say <session> '<json body>': {"text":"..."} or {"command":"compact"|"clear"}
live_say() { _w -d "$2" "$B/api/fleet/respond/sessions/$1/messages"; }

# live_ask <session> <ask>: how the ask ended. Look for "state":"closed", "outcome":"podium", "result":"took".
live_ask() { curl -s -b "$LIVE/cookies" "$B/api/fleet/respond/sessions/$1/asks/$2"; echo; }

# live_json <session> [path.to.field]: the session's view, or one field of it. Works for a session that is done.
live_json() { curl -s "$B/api/fleet/sessions/$1" | node -e '
  const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const pick = process.argv[1] ? process.argv[1].split(".").reduce((o, k) => o?.[k], s) : s;
  console.log(JSON.stringify(pick, null, 1))' "$2"; }

# say '<text>': type a prompt into the session.
say() { tmux send-keys -t "$T" -l "$1"; sleep 1; tmux send-keys -t "$T" C-m; }

# screen [lines]: what the session shows now.
screen() { tmux capture-pane -p -t "$T" | grep -v '^$' | tail -"${1:-12}"; }
```

Poll for an ask with `live_asks` (give it up to 20 seconds, because a report reaches the server about a second after the session shows the ask) and read the session and ask ids from its line:

```sh
read SID AID KIND < <(live_asks)       # then use $SID and $AID
```

After each answer, `live_ask $SID $AID` should show `"state":"closed"`, `"outcome":"podium"` and the delivery's `"result":"took"`. It can instead answer `unknown ask` a few seconds after the answer, once the session has moved on; that is not a failure. Read the server log in `$LIVE/server.log` for the delivery's result then.

## Claude Code

Set `LIVE="$TMPDIR/live"`, `B=http://127.0.0.1:4380`, `SOCK=live` and `T=live:planner` before you source the helpers.

### 1. Start

You need `node`, `curl`, `git`, `tmux` and `claude` on your `PATH`, and a built checkout. Run everything from the root of the checkout or worktree you are testing, so the session loads that code.

1. Start the server and one session. `up` builds the server and UI from the checkout, starts the server on the port with a new database, seeds one person with answering, messaging and the activity feed turned on, and opens the session in tmux, on a private tmux socket, with `podium-reporter` loaded from the checkout. The window runs with its own scratch home (links to every entry of your home except `.podium`, so Claude Code stays signed in and no reporter config file can send it to your own server):

   ```sh
   export LIVE="$TMPDIR/live"                     # the work folder, new or empty
   scripts/podium-peers-e2e.sh up --dir "$LIVE" --port 4380 --sessions 1 --tmux live
   export SOCK=live; tmux() { command tmux -L "$SOCK" "$@"; }   # every tmux command below uses the private socket
   ```

   Add `--no-build` only when nothing has changed since the last build. A build from older code tests older code. `--activity-output`, `--session-recording` and `--file-diff` turn on that Admin flag in the seed and that reporter option in the window.

2. Accept the trust prompt. Claude Code asks once whether to trust the new folder, and the highlighted choice is **No, exit**, so move down first:

   ```sh
   sleep 8; tmux send-keys -t live:planner Down; sleep 1; tmux send-keys -t live:planner C-m
   ```

You can watch with `tmux -L live attach -t live` and detach with Ctrl+B then D. The console is at `http://127.0.0.1:4380/`.

### 2. Check the wiring

Stop here until this passes. Everything after it assumes the session reports to the throwaway server.

Type `/podium` into the session and read the output:

```sh
tmux send-keys -t live:planner -l '/podium'; sleep 1; tmux send-keys -t live:planner C-m
sleep 4; tmux capture-pane -p -t live:planner | grep -E 'fleet console|Home folder|Reports sent'
```

You should see:

| Line | Must say |
|---|---|
| `Podium fleet console` | `http://127.0.0.1:4380/#/` |
| `Home folder` | your scratch home, from `HOME` |
| `Reports sent` | a count above zero, with `failed: 0` |

If the console line shows another address, the session is reporting to the wrong server. Exit it with `/exit`, shut down as in step 5 and see [Troubleshooting](#troubleshooting).

Source the helpers and run `live_signin`.

### 3. Run the scenarios

Each scenario has the same shape: type a prompt, wait for the ask, answer it, check the result.

**Start in manual mode.** Press Shift+Tab until the status line says `manual mode on`: `tmux send-keys -t live:planner BTab`, then `screen 3`. The session starts in auto mode, where tools run without asking.

| # | Prompt to `say` | Ask kind | Answer | Check |
|---|---|---|---|---|
| 1 | `Use the Bash tool to run exactly: touch allow-me.txt` | `permission` | `live_answer $SID $AID '{"kind":"allow-once"}'` | `allow-me.txt` exists in `$LIVE/proj-planner`. |
| 2 | `Use the Bash tool to run exactly: touch deny-me.txt` | `permission` | `live_answer $SID $AID '{"kind":"deny"}'` | `deny-me.txt` does not exist, and the screen says `Denied from Podium`. |
| 3 | `Use the AskUserQuestion tool to ask me one question: "Favorite color?" with options Red and Blue. Then tell me which I chose.` | `question` | `live_answer $SID $AID '{"kind":"question","answers":[{"options":[1]}]}'` | The session says you chose Blue. |
| 4 | Press Shift+Tab until the status line says `plan mode on`, then `Plan a tiny change: create hello.txt containing the word hi. Keep the plan to two lines, then present it for approval.` | `plan` | `live_answer $SID $AID '{"kind":"plan-approve","mode":"default"}'` | The session leaves plan mode. It then asks to write the file (a `permission` ask): allow it as in scenario 1, and `hello.txt` contains `hi`. |
| 5 | Nothing. The session is idle. | none | `live_say $SID '{"text":"Reply with exactly the word PONG-FROM-PODIUM"}'` | The screen shows `Sent from Podium by <name>` and then `PONG-FROM-PODIUM`. |
| 6 | Nothing. | none | `live_say $SID '{"command":"compact"}'` | The context meter in the status line goes back to `100%`. It shows what is left, so it reads `96%` or so before. |
| 7 | Nothing. | none | `live_say $SID '{"command":"clear"}'` | The screen clears and the context meter is blank until the next turn. |

For scenarios 5 to 7 there is no ask, so check the server log in `$LIVE/server.log` for the delivery: a message and `/compact` say `came back took`, and `/clear` says `was dropped (session-ended)`, because the session that was cleared ends and a new one starts. Plan mode may use a larger model than Haiku, so scenario 4 can take a minute and cost a little more.

**Answering off.** Open a second session with answering off. It uses the same scratch home (`$LIVE/home-claude`) and person, and the settings file with `respond` set to `off`:

```sh
sed 's/"respond": "everything"/"respond": "off"/' "$LIVE/settings.json" > "$LIVE/settings-off.json"
tmux new-window -t live -n off -c "$LIVE/proj-planner"
tmux send-keys -t live:off "export HOME='$LIVE/home-claude' PODIUM_USER='$NAME' PODIUM_TOKEN='$TOKEN'; claude --plugin-dir '$PWD/dist-dev/claudecode' --settings '$LIVE/settings-off.json' --model haiku -n off" C-m
sleep 14; tmux send-keys -t live:off -l 'Say hello in one word.'; sleep 1; tmux send-keys -t live:off C-m
```

The folder is already trusted, so there is no prompt. Once the session shows in `GET /api/fleet/state`, send it something:

```sh
live_say <session id> '{"text":"hello"}'              # [422] {"ok":false,"error":"not accepted","kind":"message"}
live_say <session id> '{"command":"clear"}'           # [422] {"ok":false,"error":"not accepted","kind":"command"}
```

Both must be refused, and the session must not react.

### 4. Shut it down

Run all of this, even after a failure:

```sh
tmux send-keys -t live:planner -l '/exit'; sleep 1; tmux send-keys -t live:planner C-m; sleep 2
scripts/podium-peers-e2e.sh down --dir "$LIVE" --tmux live     # server, tmux server, the links of the scratch home, and the work folder
tmux ls; lsof -nP -iTCP:4380 -sTCP:LISTEN; ls -d "$LIVE"  # all three should show nothing of yours
```

`down` deletes the scratch home's links before it removes the folder, so nothing of your real home is in reach. It refuses a work folder `up` did not make, and a link. Add `--keep` to `down` to keep the database and the server log for reading. A session that is killed can write one last folder into the work folder after `down` ran, so check that the folder is gone.

## OpenCode

Set `LIVE="$TMPDIR/live-oc"`, `B=http://127.0.0.1:4382`, `SOCK=liveoc` and `T=liveoc:planner` before you source the helpers.

`podium-peers-e2e.sh up --harness opencode` starts the throwaway server, seeds it and opens the OpenCode sessions in tmux. The same command starts a Claude Code window next to an OpenCode one (see [Both at once](#both-at-once)).

### 1. Prerequisites and isolation

You need `node`, `curl`, `git`, `tmux` and `opencode` (2.x) on your `PATH`, and a built checkout (`npm run build`). Run everything from the root of the checkout or worktree you are testing.

**The model.** `--opencode-model PROVIDER/MODEL` is required and never defaulted. Use one that costs nothing: a local model in LM Studio, or one of OpenCode's free hosted models (`opencode models` lists them; those named `opencode/...-free` need no sign-in). A small model is enough but may not follow a tool prompt exactly, and it can call a tool you did not name. Check that it answers before you blame the reporter. Cost reads `0` for both, and that is not a failure.

**Isolation.** `up` does what a hand-made run needs to get right. Each OpenCode window gets a scratch home (`$LIVE/home-<window>`) holding the plugin built from the checkout, so nothing reaches your real `~/.podium` or your real OpenCode setup. It starts `opencode --standalone`, because without it OpenCode talks to its background service, which was started with your environment, not the one the window sets. A background service you already run is not touched. The window's environment file (`$LIVE/oc-env-<window>.sh`, mode 0600) holds the server, the person and every consent option; the reporter reads those only from `PODIUM_*` variables, never from `opencode.json`. The token is read from the seed file inside the window and never typed. The project's `opencode.json` sets the model and `ask` for shell and edit, so a tool call produces a permission ask.

### 2. Start

Pick a port and a work folder, then start one OpenCode session. The Admin flags and reporter options the parity checks need are one flag each:

```sh
export LIVE="$TMPDIR/live-oc"; export SOCK=liveoc; tmux() { command tmux -L "$SOCK" "$@"; }
scripts/podium-peers-e2e.sh up --dir "$LIVE" --port 4382 --tmux liveoc --sessions 1 \
  --harness opencode --opencode-model opencode/<name>-free \
  --activity-output --session-recording --file-diff
```

For a local model, name its provider block in a JSON file and pass it with `--opencode-config`; the model and the `ask` permissions of the script win over what the file says. This example is the LM Studio model `google/gemma-4-26b-a4b-qat`:

```json
{
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local LM Studio",
      "options": { "baseURL": "http://localhost:1234/v1", "apiKey": "not-needed" },
      "models": { "google/gemma-4-26b-a4b-qat": { "name": "gemma-4-26b-a4b-qat", "limit": { "context": 262144, "output": 8192 } } }
    }
  }
}
```

```sh
scripts/podium-peers-e2e.sh up ... --opencode-model lmstudio/google/gemma-4-26b-a4b-qat --opencode-config "$PWD/lmstudio.json"
```

`up` builds again every time (`--no-build` skips the server and UI build only; the plugin is always rebuilt and copied), so an old copy never tests old code. The seed also adds five made-up sessions that go stale; ignore them. The TUI shows the model name under the prompt when it is ready. There is no trust prompt. To run a single prompt without the TUI, `opencode run --standalone -m <provider/model>#<variant> "<prompt>"` also loads the plugin and reports, but only from a shell that sourced `$LIVE/oc-env-planner.sh`. Watch with `tmux -L liveoc attach -t liveoc`.

### 3. Check the wiring

Stop here until this passes. Source the helpers (with `LIVE`, `B` and `T` set) and run `live_signin`. Then type `/podium` (OpenCode shows a completion list first, so the first Enter accepts it and the second runs it) and read the toast within a few seconds:

```sh
say '/podium'; sleep 1; tmux send-keys -t "$T" C-m; sleep 1; tmux capture-pane -p -t "$T" | grep -E 'fleet console|Home folder|Connection|Reports sent'
```

| Line | Must say |
|---|---|
| `Podium fleet console` | `http://127.0.0.1:4382/#/` |
| `Home folder` | the window's scratch home, `$LIVE/home-planner` |
| `Connection` | `online` |
| `Reports sent` | a count above zero, with `failed: 0` |

Then send a tiny prompt and confirm the session is on the throwaway server and not on yours:

```sh
say 'Say hi in one word.'; sleep 15
curl -s $B/api/fleet/state | node -e 'for (const s of JSON.parse(require("fs").readFileSync(0,"utf8")).sessions) if (s.harness === "opencode") console.log(s.id, s.status, s.name, s.model)'
```

The session must show here, and must not show on your own console. A session that has been quiet for a minute is `done` and leaves the wall, but `live_json <session>` still reads it.

### 4. Run the scenarios

OpenCode asks for a shell call as a `permission` ask and for its question tool as a `question` ask. The session shows `Allow once  Always allow  Reject` while an ask is open. Poll as in [the helpers](#the-helpers). Answer promptly: while an ask is open the session is live, and when you have answered, the next ask can come a few seconds later (the model often runs one more command to check its work), so loop on `live_asks` until it stays empty.

| # | Prompt to `say` | Ask kind | Answer | Check |
|---|---|---|---|---|
| 1 | `Use the bash tool to run exactly: touch allow-me.txt` | `permission` | `live_answer $SID $AID '{"kind":"allow-once"}'` | `allow-me.txt` exists in `$LIVE/proj`. |
| 2 | `Use the bash tool to run exactly: touch deny-me.txt. Do not run anything else.` | `permission` | `live_answer $SID $AID '{"kind":"deny"}'` | `deny-me.txt` does not exist, and the model says Podium denied it. |
| 3 | `Use the question tool to ask me one question: "Favorite color?" with options Red and Blue. Then tell me which I chose.` | `question` | `live_answer $SID $AID '{"kind":"question","answers":[{"options":[1]}]}'` | The session says you chose Blue. |
| 4 | Nothing. The session is idle. | none | `live_say $SID '{"text":"Reply with exactly the word PONG-FROM-PODIUM"}'` | The session shows a message that starts with a line saying it came through Podium, and then `PONG-FROM-PODIUM`. The server log says `came back took` (or `queued` if the session was busy). |
| 5 | Nothing. | none | `live_say $SID '{"command":"compact"}'` | The session shows a `Compaction` block with a summary. The server log says `ran /compact ... came back took`. |
| 6 | Nothing. | none | `live_say $SID '{"command":"clear"}'` | `[422] ... "does not take /clear from Podium"`. OpenCode has no `/clear` to offer. |
| 7 | Nothing. | none | `live_answer $SID plan_x '{"kind":"plan-approve","mode":"default"}'` | Refused: `session.respond.accepts` has no `plan`, and OpenCode has no plan approval to answer. |

`live_say` and `live_answer` need the session to be live; for a `done` session they answer `unknown session`. Send a prompt first, and run scenarios 4 to 6 within a minute of the last turn.

**Respond levels.** `PODIUM_RESPOND` is a level. In a second window start OpenCode with `export PODIUM_RESPOND=questions` and run a shell prompt: no permission ask is offered (`live_asks` stays empty, and the card's `respond.accepts` is `["question","message"]`), and `live_say ... '{"command":"compact"}'` answers `[422] not accepted`. Answer the permission in the terminal.

**Answering off.** In a window with `export PODIUM_RESPOND=` (an empty value wins over the file and turns answering off for one run), start OpenCode and say hello. The session's `respond` is `null`, and:

```sh
live_say <session id> '{"text":"hello"}'              # [422] {"ok":false,"error":"not accepted","kind":"message"}
live_say <session id> '{"command":"clear"}'           # [422] {"ok":false,"error":"not accepted","kind":"command"}
live_say <session id> '{"command":"compact"}'         # [422] {"ok":false,"error":"not accepted","kind":"command"}
```

### 5. Check what the reporter sends

Read the fields from `live_json <session> <field>` while the session is live or after it, and the routes below while it is live. Make some changes first: ask the session to run `echo hello > note.txt && cat note.txt`, then `cat missing-file.txt`, and answer each ask.

| Item | How to check | Passes when |
|---|---|---|
| Effort | `opencode run --standalone -m <provider/model>#<variant> "Reply with one word."`, then `live_json <id> effort` | The variant name, such as `high`. A model run without a variant reports `default`. Not every model has variants; a free hosted model does. |
| Context window and percent | `live_json <id> context` | `tokens`, `window` (the model's context size) and `percent`. |
| Cost | `live_json <id> costUsd` | A number; `0` for a free or local model. |
| Changed files | `live_json <id> files` | The files the session changed (`added`, `removed`, a `status`), including `note.txt`. |
| Activity feed | `curl -s "$B/api/fleet/sessions/<id>/agents/@orchestrator/activity?every=5"` repeatedly while you prompt (the lease starts when the session is live) | `tool` entries for each call, `text` entries for the model's replies and a `podium` entry for each answer you sent. |
| Shell command and output | The same feed, on a shell call | A `tool` entry with `command`, `done`, `exitCode` and, with `PODIUM_ACTIVITY_OUTPUT`, `output`. |
| Full prompts | After a prompt that makes a subagent (`Use the task tool to launch one general subagent with the prompt "Reply with the single word AGENT-OK"`), `curl -s $B/api/fleet/sessions/<id>/agents/<agent id>/text` | The whole task prompt and the answer. |
| File diff on request | While an ask is open, `curl -s -b "$LIVE/cookies" "$B/api/fleet/respond/sessions/<id>/files/diff?path=note.txt"` | `"status":"ok"` and a unified diff. |
| Session recording | While the session is live, `_w -X PUT -d '{"loops":["@orchestrator"]}' "$B/api/fleet/respond/sessions/<id>/recording"`, run a shell call, then `curl -s -b "$LIVE/cookies" "$B/api/fleet/respond/sessions/<id>/recording"` | Rows of kind `tool`, `decision` (with `by`), `result` and `text`. |
| Failure detail | Deny a shell call, and ask for `read` on `/nonexistent/file.txt` | A `fail` event in `events` of `GET /api/fleet/state` with class `Blocked by permission` or `Tool error`. A shell command that exits non-zero is not a failure to OpenCode. |
| Skills | Put a `SKILL.md` in `$LIVE/proj-planner/.opencode/skills/<name>/`, ask the model to load it, then `live_json <id> loop.skills` | The skill's name. |
| Tools the reporter adds | Ask `Call the podium_peers tool and tell me what it returns` (needs `PODIUM_PEERS=true`), and `Call the plan tool with title "X"` | The model's answer shows the tool's reply. The session's `plan` field is meant to carry the title, but it stayed `null` after a title-only call in the run this was written from. |
| Usage per model | `usageByModel` is not stored for a session that reports its own cost (`costSource: harness`) | Not observable on the server. The reporter's unit tests cover it. |
| Explain failures | Needs a session or agent that ends with a failure, and `PODIUM_EXPLAIN_FAILURES=true` | The failure's `explanation`. |
| Flush, heartbeat and session name | Plugin options in `opencode.json`; a plugin dropped into `plugins/` takes none, so name it in the `plugin` list | Only the reporter's unit tests cover them today. |

Two things only a person sees: the toast the TUI shows when the connection changes, and the recording's toast when it starts or stops.

#### Contexts, a name across a restart, no TUI, and the messaging flag

These checks need a few steps the table above does not give. Run them in the same window, after the wiring check.

- **`/podium context`.** `add` refuses a file that is not a reporter config, so make two small ones in the window's scratch home (a v1 header, a `# user:` line, an `https` `# server:` line and an `# issued-at:` epoch, mode 0600, named `reporter-config-<name>-<epoch>.pem`), then run `add`, `list`, `use`, `show`, `rename` and `remove` as `/podium context <verb>`. Each answers in a dialog. Remove the contexts and the two files at the end: a file left in `home-planner/.podium/` is the newest config and sends the next start to its server.
- **A name across a restart.** Run `/podium name <text>`, leave OpenCode with Ctrl+C (not Ctrl+D, which closes the window's shell and ends the tmux server), start a new window with `new-session ... -c "$LIVE/proj-planner"`, source `$LIVE/oc-env-planner.sh` and run `opencode --standalone -s <session id>`. A session that has not had a turn since the restart is not on the server yet: send a prompt, then read `live_json <id> name`.
- **No TUI part.** `opencode run --standalone -m <provider/model> "<prompt>"` from a shell that sourced the env file reports the session with `attached: null`, and the card stays (it shows `done` once the run ends). For `serve`, source the env file and run `opencode serve --port 4390 --hostname 127.0.0.1`: it prints a one-time password, and every route takes basic auth as `opencode:<password>`. Create a session with `POST /api/session` (`{"model":{"providerID":"opencode","id":"<model>"},"location":{"directory":"$LIVE/proj-planner"}}`) and send `POST /api/session/<id>/prompt` (`{"text":"..."}`); the routes are in `/openapi.json`. `opencode web` takes no port or host, and the web client and the desktop app ask a person for a pairing link or the password, so an agent cannot drive them: say so in the report.
- **The messaging flag turned off mid-session.** Unlock Admin on the throwaway server with `POST /api/admin/unlock` (`{"name":"Admin","token":"<contents of $LIVE/admin-secret>"}`, with `Origin: $B` and `X-Podium-Admin: 1`, and a cookie jar), then `PUT /api/admin/settings` with `{"features":{"peer-messaging":false}}` and the same headers and cookies. Within about 20 seconds the model no longer has `podium_peers` or `podium_send` (it says the tool was removed), and `/podium` reads `Messaging: off, because Podium's messaging flag is off`. The footer has no messaging text and does not change.

### 6. Shut it down

Run all of this, even after a failure:

```sh
scripts/podium-peers-e2e.sh down --dir "$LIVE" --tmux liveoc   # server, tmux server, scratch homes and the work folder
tmux ls; lsof -nP -iTCP:4382 -sTCP:LISTEN; ls -d "$LIVE" # all three should show nothing of yours
```

`down` stops only what `up` started: its own tmux server and server process. An OpenCode background service you already run (`opencode serve --service`) is not yours to stop. Check that your real `~/.podium` and `~/.config/opencode` have no new file from the run.

## Both at once

One run can hold a Claude Code window and an OpenCode window reporting to the same throwaway server. `--harness` takes a list that is used window by window, so planner and notes are Claude Code and tester and docs are OpenCode:

```sh
export LIVE="$TMPDIR/live-both"; export SOCK=liveboth; tmux() { command tmux -L "$SOCK" "$@"; }
scripts/podium-peers-e2e.sh up --dir "$LIVE" --port 4384 --tmux liveboth --sessions 2 \
  --harness claudecode,opencode --opencode-model opencode/<name>-free
```

`--model` is the Claude Code model (default `haiku`). Accept Claude Code's trust prompt in its window (`tmux -L liveboth send-keys -t liveboth:planner Down Enter`), send each window a prompt, and both sessions show in `GET /api/fleet/state` with `reporterName` `podium-reporter-claudecode` and `podium-reporter-opencode`. Stop with `down` as above. Nothing is left running: the tmux server, the server, the port and the work folder with both scratch homes are gone.


## Notes for agents

- Send a prompt as the text, then a pause, then Enter on its own. A long prompt sent with its Enter in one `send-keys` is often left unsubmitted.
- Do not poll in a tight loop. Wait for the thing you need: after `say`, sleep about 8 seconds, then call `live_asks`.
- Read the screen with `tmux capture-pane -p`, not by attaching.
- Say that a live run uses model tokens before you start one for someone else, and say which model you use.
- A scenario that fails is a finding. Report the prompt, the ask, the answer you sent and the screen, and do not edit the helpers until it passes.
- A small local model sometimes runs a different command than you named, or calls a tool as a shell command. Say so in the finding so the model can be told apart from a reporter fault.

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| `/podium` shows another address, or the session never appears at the throwaway server | A reporter config in your `~/.podium` chose the server, or OpenCode used its background service | Redo the start with the scratch home, run OpenCode with `--standalone`, and check the wiring again |
| Claude Code says "Not logged in" | The scratch home is missing links to your Claude Code files | Link every entry of your home except `.podium` |
| A hook from another plugin blocks the prompt and asks you to sign in | It cannot find its sign-in under a scratch home that lacks your links | Same fix |
| The trust prompt ends the session | Enter picked the highlighted **No, exit** | Relaunch it and press Down first |
| `live_asks` prints nothing | The session is in auto mode (Claude Code) or `permission` is not `ask` (OpenCode), the tool is read-only, or the report has not arrived yet | Cycle to manual mode, set `ask` in `opencode.json`, use a command that writes, and wait a few seconds |
| `403 cross-site request refused` | The `Origin` or `X-Podium-Respond: 1` header is missing | Use the helpers, which send both |
| `422 not accepted` | The session's `respond` setting does not allow that kind of answer | Check the setting, or the session's `accepts` in the state |
| `unknown session` on `live_say` or `live_answer` | The session has been quiet for a minute and is `done` | Send it a prompt, then answer |
| `live_ask` answers `unknown ask` | The ask closed and the session moved on | Read the delivery's result in `$LIVE/server.log` |
| OpenCode: a message or `/compact` comes back `not-taken` and the session does nothing | OpenCode takes an idempotency `id` only if it starts with `msg_`, and the reporter passes Podium's delivery id (`dlv_...`); the call fails with `Expected a string starting with "msg_"`, and the reporter hides the error | A reporter fault to fix in `plugin/opencode/host.ts` and `answering.ts`; to see the error, call `ctx.session.prompt` from a throwaway plugin |
| OpenCode: the activity feed has `tool` rows with no command or output | This OpenCode (2.2.5) names its shell tool `shell`, and the reporter only knows `bash` (`plugin/opencode/activity.ts`) | A reporter fault; the other fields are unaffected |
| OpenCode: `/podium` shows nothing | The completion list took the first Enter | Press Enter a second time and read the toast within a few seconds |
| OpenCode: a session's name reads `[redacted]` | The session has no title yet (`opencode run`) | Look again after the title is set, or use the TUI |
| OpenCode: the model calls `plan` or `podium_peers` as a shell command | A small model confuses a tool name with a command | Say `call the plan tool` and answer the shell ask with a deny |

## Where to go next

- [Messaging](MESSAGING.md) has the multi-session version, with several machines and rights between them.
- [The OpenCode reporter](REPORTER.md#install-the-opencode-reporter) says how it is installed and what it trusts.
- [The server endpoints](spec/07-server/07-01-endpoints.md#browser-routes-for-responding) list every answer route, with its body and errors.
- [End-to-end tests](e2e/COVERAGE.md) is the browser suite that runs in containers.
