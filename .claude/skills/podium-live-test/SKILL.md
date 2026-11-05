---
name: podium-live-test
description: Run Podium's live test - a throwaway Podium server plus a real harness session (Claude Code, OpenCode, any later harness) in tmux, answered from the API and checked on both sides. Load this when a change touches the harness contract (plugin/core/, any plugin/<harness>/, ask kinds, respond.accepts, the answer, message or command routes, the reporter's consent options or Admin flags, what the reporter sends), before the PR for it is opened, when a harness is added, and when asked to test with a real session. A subagent running the test loads this plus the reference for the harness it drives. Costs model tokens, so say so first.
---

# Podium live test

Unit tests and the browser suite cannot tell you that a real session still behaves when Podium answers it. This test can: you start a server of your own, start a real session in tmux that reports to it, drive it with a few prompts, answer what it asks from the API, check both sides and shut it all down.

**One core, per-harness exclusions.** The scenarios below are the core. Every harness runs every one. A harness that cannot do something is not skipped: its reference lists it as an *exclusion* with what the run asserts instead (a refusal, an absent `accepts` kind), so a limit is itself tested. A new harness adds one reference and its exclusions, never a new walkthrough (`references/new-harness.md`).

Read `references/<harness>.md` for each harness you drive: `claudecode.md`, `opencode.md`. Read the part of it that says how to start, how to check the wiring, and its exclusions, before the first scenario.

## When it runs

Whenever a change touches the harness contract: `plugin/core/`, `plugin/<harness>/`, ask kinds, `respond.accepts` and its limits, the answer, message and command routes, consent options and Admin flags, or what a reporter sends. A change in `plugin/core/` or the server runs every harness; a change in one `plugin/<harness>/` runs that harness. A change that touches nothing here says so in the PR. Unit tests still run first (`podium-pr-workflow`).

The orchestrator may run it itself or hand it to a fresh, non-fork subagent. State the agent's authority in its prompt: it runs the test and reports; it edits nothing in the repo, commits, pushes and merges nothing, and stops what it started. Say which model drives the session and that the run spends tokens before starting one for someone else.

## Rules that keep you safe

- **Use your own server.** Never point a test at the server the maintainer works with, and never put demo data in their database. `scripts/podium-peers-e2e.sh up` makes a new database in a temporary folder on a port you pick (4380 Claude Code, 4382 OpenCode, 4384 both, so runs can overlap).
- **Keep the session off the real server.** A reporter config file in `~/.podium/` makes a session ignore the server it was told to use. `up` gives every window a scratch home; the wiring check proves it worked. Do not go on until it passes.
- **Run from the checkout under test**, and let `up` rebuild: a build from older code tests older code.
- **Stop what you start.** The last step removes the server, the tmux server, the work folder and the scratch homes. Do it even after a failure, and check nothing is left (`tmux ls`, `lsof -nP -iTCP:<port> -sTCP:LISTEN`, `ls -d "$LIVE"`).
- **Do not poll in a tight loop.** After sending a prompt wait about 8 seconds, then call `live_asks`. A report reaches the server about a second after the session shows an ask; allow up to 20 seconds.
- **Do not type into the terminal while an ask is open, except to answer it.** A `/podium` plus Enter typed into a permission dialog picks "Yes" and approves the tool. Read the screen with `capture-pane` instead.
- **Send a prompt as text, a pause, then Enter on its own.** A long prompt with its Enter in one `send-keys` is often left unsubmitted. Read the screen with `tmux capture-pane -p`, never by attaching.
- **A scenario that fails is a finding.** Report the prompt, the ask, the answer you sent and the screen, and do not edit the helpers until it passes. A small or local model may run a different command than you named or call a tool as a shell command; say so, so the model can be told from a reporter fault.

## Helpers

`up` runs tmux on a private socket named by `--tmux`, and every tmux command must use it. **Each Bash call is a fresh shell**, so nothing persists: put the exports and the `source` of this file in one `$LIVE/pre.sh` and `source` it at the top of every call. Save this in a file in the work folder and `source` it after `up`, with four variables set: `LIVE` (work folder), `B` (server address), `SOCK` (the `--tmux` name) and `T` (the tmux target, such as `live:planner`). Each write sends the sign-in cookie, a matching `Origin` and `X-Podium-Respond: 1`; without all three the server answers `403 cross-site request refused`.

```sh
tmux() { command tmux -L "${SOCK:?set SOCK to the --tmux name}" "$@"; }
NAME=$(sed -n 's/^name=//p' "$LIVE/seed.out"); TOKEN=$(sed -n 's/^token=//p' "$LIVE/seed.out")
_w() { curl -s -b "$LIVE/cookies" -H "Origin: $B" -H 'X-Podium-Respond: 1' -H 'Content-Type: application/json' -w ' [%{http_code}]\n' "$@"; }

# Sign in once. Expect {"ok":true,...}.
live_signin() { curl -s -c "$LIVE/cookies" -H "Origin: $B" -H 'X-Podium-Respond: 1' -H 'Content-Type: application/json' \
  -d "{\"name\":\"$NAME\",\"token\":\"$TOKEN\"}" "$B/api/fleet/respond/sign-in"; echo; }

# "<session> <ask> <kind>" for every open ask; nothing while none is open.
live_asks() { curl -s "$B/api/fleet/state" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  for (const s of d.sessions) for (const a of s.asks ?? []) if (a.state === "open") console.log(s.id, a.id, a.kind)'; }

live_answer() { _w -d "$3" "$B/api/fleet/respond/sessions/$1/asks/$2/answer"; }   # <session> <ask> '<json>'
live_say()    { _w -d "$2" "$B/api/fleet/respond/sessions/$1/messages"; }          # <session> '{"text":..}' or '{"command":..}'
live_ask()    { curl -s -b "$LIVE/cookies" "$B/api/fleet/respond/sessions/$1/asks/$2"; echo; }  # how the ask ended

# live_json <session-id> [path.to.field]: the session's view, or one field. The id comes first. Works for a session that is done.
live_json() { curl -s "$B/api/fleet/sessions/$1" | node -e '
  const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const pick = process.argv[1] ? process.argv[1].split(".").reduce((o, k) => o?.[k], s) : s;
  console.log(JSON.stringify(pick, null, 1))' "$2"; }

say()    { tmux send-keys -t "$T" -l "$1"; sleep 1; tmux send-keys -t "$T" C-m; }       # type a prompt
screen() { tmux capture-pane -p -t "$T" | grep -v '^$' | tail -"${1:-12}"; }            # what the session shows
```

`read SID AID KIND < <(live_asks)` gives the ids (`live_asks` prints only open asks; the ask's tool is in `GET /respond/sessions/<id>/asks/<ask>`, not in `/api/fleet/state`). A server restart wipes the sign-in cookie, so run `live_signin` again after one. After an answer, `live_ask $SID $AID` should show `"state":"closed"`, `"outcome":"podium"` and the delivery's `"result":"took"`. It can instead say `unknown ask` within a second or a few seconds, once the session moved on; read the delivery's result in `$LIVE/server.log` then. Once a session is `done`, `live_json` still reads it but `live_ask` and `live_answer` answer `unknown session`. For a message, `/compact` or `/clear` there is no ask: the server log carries the delivery result.

## The core scenarios

Run them in order after the wiring check. The prompt wording, the key to press and the screen text differ per harness and are in its reference; the **Check** column is what every harness must show. `live_answer`/`live_say` need a live session: one quiet for a minute may be `done` and answer `unknown session`, so send it a prompt first.

| # | Scenario | Ask kind | Answer or action | Check (every harness) |
|---|---|---|---|---|
| C1 | **Wiring.** `/podium` | none | Read the console line, home folder, connection and report counts | Console URL is the throwaway server, home is the scratch home, `Reports sent` above 0 with `failed: 0`. Then send one tiny prompt (`/podium` is not a turn, so the session is not on the server before its first one) and confirm the session is in `GET /api/fleet/state` with this harness's `reporterName`, and not on the maintainer's server. Stop here until it passes. |
| C2 | **Allow once.** Prompt a shell `touch allow-me.txt` | `permission` | `{"kind":"allow-once"}` | The file exists; `live_ask` shows `took`. |
| C3 | **Deny.** Prompt `touch deny-me.txt`, then once more with a reason | `permission` | `{"kind":"deny"}`, then `{"kind":"deny","text":"use X instead"}` | The file does not exist; the model reports the denial, and quotes the reason the second time. A model may refuse to retry a denied command and raise no second ask: reword the prompt ("Try again now: ..."). |
| C4 | **Question.** Prompt the question tool: "Favorite color?" Red or Blue | `question` | `{"kind":"question","answers":[{"options":[1]}]}` | The model says you chose Blue. |
| C5 | **Message, idle session** | none | `{"text":"Reply with exactly the word PONG-FROM-PODIUM"}` | `PONG-FROM-PODIUM` appears; log says `came back took`. |
| C6 | **Message, busy session.** Prompt `Write out the integers 1 to 400, one per line, no other text.`, wait 2 seconds, then send | none | same body | Result is `queued`, and a later `took` (an exclusion if the harness cannot). Do not build a long turn with `sleep`: a harness may block a standalone foreground sleep. |
| C7 | **`/compact`** | none | `{"command":"compact"}` | A `compact` event (`kind:"compact"`, `data` with `tokensBefore` and `tokensAfter`) in `GET /api/fleet/state` events, and `context.tokens` falls (on some harnesses only after the next turn). Rely on the event, not on a harness status line or a block in the pane. |
| C8 | **Respond level `questions`** | none | Run a shell prompt and `{"command":"compact"}` | `respond.accepts` is `["question","message"]`, no permission ask is announced, and the command answers `422 not accepted`. |
| C9 | **Answering off** | none | `{"text":"hello"}` and `{"command":"compact"}` | Both `422 not accepted` (kind `message`, then `command`), and the session does not react. |
| C10 | **Reporter fields** | none | `live_json <id>` after a few turns | `model`, `effort`, `context.{tokens,window,percent}`, `costUsd`, `files`, `git.branch`, `loop.toolCounts`, `loop.skills`, `name` are present and correct for this harness. `up` gives the project folder one empty commit so a branch exists. `loop.skills` needs a prompt that loads a skill. |
| C11 | **Subagent.** Prompt one subagent: "Reply with the single word AGENT-OK" | none | With full prompts on, `GET /sessions/<id>/agents/<aid>/text` | An `agents[]` row `done`, a `spawn` event, and the whole prompt at `/text`. Full prompts need `fullPrompts` / `PODIUM_FULL_PROMPTS`, which `up` does not set: add it to the window's consent source (reference) **and restart the session**, because the reporter reads it at start. |
| C12 | **Activity feed** | none | `GET /sessions/<id>/agents/@orchestrator/activity?every=5` once to take the lease, then prompt, and keep fetching at least every 5 seconds (the lease lapses 20 seconds after the last fetch; the first fetch is empty and is not a failure) | `tool`, `text` and `podium` entries (`podium` only after you answered an ask); a shell call has `command`, `done` and, with `--activity-output`, `output`, and `exitCode` with `failed:true` only on a non-zero exit. Use a command that writes: a harness may run a read-only one with no ask. |
| C13 | **File diff** | none | While an ask is open: `GET /respond/sessions/<id>/files/diff?path=note.txt` | `"status":"ok"` and a unified diff. Needs `--file-diff`. |
| C14 | **Recording** | none | `_w -X PUT -d '{"loops":["@orchestrator"]}' "$B/api/fleet/respond/sessions/<id>/recording"`, run a shell call, then GET it | Rows of kind `tool`, `decision` (with `by`), `result`, `text`. Needs `--session-recording`. |
| C15 | **Subagent failure.** Make a subagent fail (the reference says how, or that it is hard to provoke) | none | `events` of `GET /api/fleet/state` | A `fail` event on the agent with a `class`. Do not use a main-loop tool failure: harnesses differ there. A harness where no cheap failure exists reports NOT RUN, not PASS. |
| C16 | **Plan tool.** "Call the plan tool with title X" | none | `live_json <id> plan` | The harness's reference says what `plan.title` reads; the model's answer shows the tool's reply. |
| C17 | **Name across a restart.** `/podium name T`, exit, resume, send a prompt | none | `live_json <id> name` | Reads `T`. A session with no turn since the restart is not on the server yet. |
| C18 | **`/podium context`.** add, list, use, show, rename, remove with two fake config files (they must look real: `# podium-reporter-config v1`, `# user: X`, `# server: https://127.0.0.1:9`, `# issued-at: x 1700000000`, `# expires: ...`, `# fingerprint: AA`, mode 0600, absolute paths inside `$LIVE`; the format is in `plugin/core/tls/reporterConfig.test.ts`) | none | The dialog or toast of each verb | Each verb answers. Remove the contexts and both files after: a leftover file in the scratch `.podium/` is the newest config and sends the next start to its server. |
| C19 | **Messaging flag off mid-session.** Unlock Admin (`POST /api/admin/unlock` with `Origin: $B`, `X-Podium-Admin: 1`, `{"name":"Admin","token":"<$LIVE/admin-secret>"}` and a cookie jar), then `PUT /api/admin/settings` `{"features":{"peer-messaging":false}}` | none | Wait about 20 seconds | `/podium` reads `Messaging: off, because Podium's messaging flag is off`. Whether the tools are withdrawn is in the reference. |
| C20 | **Answered in the terminal.** With an ask open, answer it in the terminal | any | Then `live_answer` the same ask | The ask is closed and the later answer is refused: `410 closed` with `outcome:"terminal"` where the harness reports it so, otherwise `404 unknown ask` (the reference says which). A different result is a finding. |
| C21 | **Server restart.** With an ask open, kill the server (`kill $(cat $LIVE/server.pid)`) and start it again on the same database: `PODIUM_TOKEN=$(cat $LIVE/admin-secret) PORT=<port> HOST=127.0.0.1 PODIUM_DB=$LIVE/podium.sqlite PODIUM_DATA_DIR=$LIVE nohup node server/dist/index.js >>$LIVE/server.log 2>&1 &`, then write the new pid to `$LIVE/server.pid` so `down` stops it | any | `live_signin`, then `live_asks`; check the connection only after answering (see the rule on typing) | The same ask is listed again within seconds, answering it closes it with `outcome:"podium"`, `/podium` reads `online`, and `Reports sent` shows `failed` above 0 for the outage. The footer or toast of some harnesses shows `offline` then `live`. |
| C22 | **Session end.** Exit the session (the reference says how: a permission dialog may ignore Ctrl+C and Ctrl+D) | none | `live_json <id>` | `status` `done` with an `endReason` (the value differs per harness). An ask left open is closed, and which outcome it gets is per harness; do not assert `ended`. |

**Exclusions.** If the harness's reference lists a scenario as an exclusion, run what it says instead and report it as "exclusion held". An exclusion that no longer holds (the harness now can) is a finding: the reference is out of date, or the reporter gained a capability that is not yet tested.

**Not yet in the core, worth adding when a change touches it:** discarding a waiting delivery (`DELETE /respond/deliveries/:id`) and the 20-delivery limit (429); the Admin `respond` flag off (403) and a non-owner (403); a subagent's own permission ask (`agentId` set); recording chosen while consent is off; a background wait on the card; an auto-compaction counted as a blowout.

## Both harnesses at once

One run can hold windows of several harnesses reporting to one throwaway server. `--harness` takes a list used window by window (`--harness claudecode,opencode`), and the windows are named in order: planner, tester, notes, docs, so with `--sessions 2` planner is the first harness and tester the second, and `notes` and `docs` exist only from four sessions. Give each harness its flags (`--opencode-model`) and accept each harness's first-run prompt. Use it for C1 and for the divergence check in the report: the same action should read the same on the wall. Run each harness's own scenarios in its own window with that harness's reference.

## Shut down

Run this even after a failure. Each reference gives its exact `down` line; it removes the server, the tmux server, the scratch-home links and the work folder, and refuses a folder `up` did not make. Add `--keep` to read the database and `server.log` first. A killed session can write one last folder into the work folder after `down`, so check it is gone, and check the maintainer's real `~/.podium` and each harness's config folder have no new file from the run.

## Report

Say which harness and model, which scenarios passed, which exclusions held, and each failure with its prompt, ask, answer and screen. Name any divergence you saw between harnesses on something the wall shows: that is a finding even when every scenario passed (PROJECT.md, "A reporter change considers every harness").
