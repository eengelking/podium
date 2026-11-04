---
title: "Live testing with tmux and a throwaway server"
description: "Run a real Claude Code session in tmux against your own Podium server, answer it from the API, check each result and shut it all down."
group: Project internals
---

# Live testing with tmux and a throwaway server

Unit tests and the browser suite cannot tell you that a real Claude Code session still behaves when Podium answers it. This page shows how to find out. You start a server of your own, start a real session in tmux that reports to it, drive the session with a few prompts, answer what it asks from the API, and check what happened in both places.

It is for a contributor, or an agent working for one, who has built Podium from a checkout and changed something a session can be answered through: the reporter, the answering code, the answer routes. For the browser suite, see [End-to-end tests](e2e/COVERAGE.md). For several sessions that message each other, see [Messaging](MESSAGING.md#a-run-with-real-sessions).

Contents:

- [What you get](#what-you-get)
- [Rules that keep you safe](#rules-that-keep-you-safe)
- [1. Start](#1-start)
- [2. Check the wiring](#2-check-the-wiring)
- [3. Load the helpers](#3-load-the-helpers)
- [4. Run the scenarios](#4-run-the-scenarios)
- [5. Shut it down](#5-shut-it-down)
- [Notes for agents](#notes-for-agents)
- [Troubleshooting](#troubleshooting)

## What you get

A run takes about ten minutes and uses one Haiku session, which costs a few cents. At the end you know, with the real Claude Code, that Podium can:

- allow and deny a tool,
- answer a question,
- approve a plan,
- send a message, `/compact` and `/clear`,
- and that a session with answering off refuses all of it.

## Rules that keep you safe

- **Use your own server.** Never point a test at the server you work with, and never put demo data in your own database. The script below uses a new database in a temporary folder and a port you pick.
- **Keep the session off your real server.** A reporter config file in `~/.podium/` makes a session connect to the server it names and ignore the address in its settings. Your test session would then appear on your real console and never reach the throwaway server. Step 1 avoids this, and step 2 proves it did.
- **Stop what you start.** Step 5 removes the server, the tmux session, the temporary folder and the scratch home. Do it even when a step failed.

## 1. Start

You need `node`, `curl`, `git`, `tmux` and `claude` on your `PATH`, and a built checkout. Run everything from the root of the checkout or worktree you are testing, so the session loads that code.

1. Make a scratch home folder. Claude Code needs your home folder to stay signed in, so link every entry of it except `.podium`:

   ```sh
   export LIVE="$TMPDIR/live"                     # the work folder, new or empty
   export FH="$TMPDIR/live-home"                  # the scratch home
   mkdir -p "$FH"
   for f in ~/.[!.]* ~/Library; do
     [ "$(basename "$f")" = ".podium" ] || ln -s "$f" "$FH/$(basename "$f")"
   done
   ```

2. Start the server and one session with the scratch home. `up` builds the server and UI from the checkout, starts the server on the port with a new database, seeds one person with answering, messaging and the activity feed turned on, and opens the session in tmux with `podium-reporter` loaded from the checkout:

   ```sh
   HOME="$FH" scripts/podium-peers-e2e.sh up --dir "$LIVE" --port 4380 --sessions 1 --tmux live
   ```

   Add `--no-build` only when nothing has changed since the last build. A build from older code tests older code.

3. Accept the trust prompt. Claude Code asks once whether to trust the new folder, and the highlighted choice is **No, exit**, so move down first:

   ```sh
   sleep 8; tmux send-keys -t live:planner Down; sleep 1; tmux send-keys -t live:planner C-m
   ```

You can watch with `tmux attach -t live` and detach with Ctrl+B then D. The console is at `http://127.0.0.1:4380/`.

## 2. Check the wiring

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

If the console line shows another address, the session is reporting to the wrong server. Exit it with `/exit`, stop at step 5 and see [Troubleshooting](#troubleshooting).

## 3. Load the helpers

These shell functions wrap the answer routes. Paste them into the shell you run the tests from. Each write sends the person's sign-in cookie, an `Origin` that matches the host and `X-Podium-Respond: 1`; without all three the server answers `403 cross-site request refused`.

```sh
B=http://127.0.0.1:4380
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

# say '<text>': type a prompt into the session.
say() { tmux send-keys -t live:planner -l "$1"; sleep 1; tmux send-keys -t live:planner C-m; }

# screen: what the session shows now.
screen() { tmux capture-pane -p -t live:planner | grep -v '^$' | tail -"${1:-12}"; }

live_signin
```

## 4. Run the scenarios

Each scenario has the same shape: type a prompt, wait for the ask, answer it, check the result. Poll with `live_asks` until it prints a line (give it up to 20 seconds), and read that line for the session and ask ids:

```sh
read SID AID KIND < <(live_asks)       # then use $SID and $AID below
```

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

After each answer, `live_ask $SID $AID` should show `"state":"closed"`, `"outcome":"podium"` and the delivery's `"result":"took"`. For scenarios 5 to 7 there is no ask, so check the server log in `$LIVE/server.log` for `came back took`.

**Answering off.** Open a second session with answering off. It uses the same scratch home and person, and the settings file with `respond` set to `off`:

```sh
sed 's/"respond": "everything"/"respond": "off"/' "$LIVE/settings.json" > "$LIVE/settings-off.json"
tmux new-window -t live -n off -c "$LIVE/proj-planner"
tmux send-keys -t live:off "export HOME='$FH' PODIUM_USER='$NAME' PODIUM_TOKEN='$TOKEN'; claude --plugin-dir '$PWD/dist/claudecode' --settings '$LIVE/settings-off.json' --model haiku -n off" C-m
sleep 14; tmux send-keys -t live:off -l 'Say hello in one word.'; sleep 1; tmux send-keys -t live:off C-m
```

The folder is already trusted, so there is no prompt. Once the session shows in `GET /api/fleet/state`, send it something:

```sh
live_say <session id> '{"text":"hello"}'              # [422] {"ok":false,"error":"not accepted","kind":"message"}
live_say <session id> '{"command":"clear"}'           # [422] {"ok":false,"error":"not accepted","kind":"command"}
```

Both must be refused, and the session must not react.

## 5. Shut it down

Run all of this, even after a failure:

```sh
tmux send-keys -t live:planner -l '/exit'; sleep 1; tmux send-keys -t live:planner C-m; sleep 2
scripts/podium-peers-e2e.sh down --dir "$LIVE" --tmux live     # server, tmux session and work folder
find "$FH" -maxdepth 1 -type l -delete                          # your links first
rm -rf "$FH"                                                    # then the rest of the scratch home
tmux ls; lsof -nP -iTCP:4380 -sTCP:LISTEN                       # both should show nothing of yours
```

Delete the links before `rm -rf`. The scratch home also holds real folders that programs created, such as `.podium`, and `rm -rf` removes a link without following it, but a mistake while your links are still there can reach your real home folder. Add `--keep` to `down` to keep the database and the server log for reading. A session that is killed can write one last folder into the scratch home after `rm -rf` ran, so check that the folder is gone, and run `rm -rf "$FH"` again if it is not.

## Notes for agents

- Send a prompt as the text, then a pause, then Enter on its own. A long prompt sent with its Enter in one `send-keys` is often left unsubmitted.
- Do not poll in a tight loop. Wait for the thing you need: after `say`, sleep about 8 seconds, then call `live_asks`.
- Read the screen with `tmux capture-pane -p`, not by attaching.
- Say that a live run uses model tokens before you start one for someone else.
- A scenario that fails is a finding. Report the prompt, the ask, the answer you sent and the screen, and do not edit the helpers until it passes.

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| `/podium` shows another address, or the session never appears at `127.0.0.1:4380` | A reporter config in your `~/.podium` chose the server | Redo step 1 with the scratch home, and check step 2 again |
| Claude Code says "Not logged in" | The scratch home is missing links to your Claude Code files | Link every entry of your home except `.podium` |
| A hook from another plugin blocks the prompt and asks you to sign in | It cannot find its sign-in under a scratch home that lacks your links | Same fix |
| The trust prompt ends the session | Enter picked the highlighted **No, exit** | Relaunch it and press Down first |
| `live_asks` prints nothing | The session is in auto mode, or the tool is read-only and was allowed without asking | Cycle to manual mode, and use a command that writes |
| `403 cross-site request refused` | The `Origin` or `X-Podium-Respond: 1` header is missing | Use the helpers, which send both |
| `422 not accepted` | The session's `respond` setting does not allow that kind of answer | Check the setting, or the session's `accepts` in the state |

## Where to go next

- [Messaging](MESSAGING.md) has the multi-session version, with several machines and rights between them.
- [The server endpoints](spec/07-server/07-01-endpoints.md#browser-routes-for-responding) list every answer route, with its body and errors.
- [End-to-end tests](e2e/COVERAGE.md) is the browser suite that runs in containers.
