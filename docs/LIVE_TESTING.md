---
title: "Live testing with tmux and a throwaway server"
description: "Run real Claude Code sessions in tmux against your own Podium server, answer them from the API, and shut it all down without touching your real console."
group: Project internals
---

# Live testing with tmux and a throwaway server

This page covers how to check a change to the reporter, or to anything a session can be answered through, with real Claude Code sessions. It is for a contributor who has built Podium from a checkout and has `tmux` and `claude` installed. For the browser suite, see [End-to-end tests](e2e/COVERAGE.md). For the messaging steps in particular, see [Messaging](MESSAGING.md#a-run-with-real-sessions).

Contents:

- [Before you start](#before-you-start)
- [Start the server and a session](#start-the-server-and-a-session)
- [Keep the session off your real server](#keep-the-session-off-your-real-server)
- [Drive the session](#drive-the-session)
- [Answer from Podium](#answer-from-podium)
- [Shut it down](#shut-it-down)
- [Troubleshooting](#troubleshooting)

## Before you start

You need `node`, `curl`, `git`, `tmux` and `claude` on your `PATH`. A live run uses the model, so use the smallest one that shows the behavior (`--model haiku`) and say so before you start one for someone else.

Never point a test at the server you work with, and never seed demo data into your own database. Everything below uses a server on its own port with a database in a temporary folder.

## Start the server and a session

`scripts/podium-peers-e2e.sh` does the setup. It builds the server and UI from the checkout, starts the server on a port you choose with a fresh database, seeds one person with responding, messaging and the activity feed turned on, and starts the sessions in tmux, loading `podium-reporter` from the checkout with `--plugin-dir`.

1. From the checkout or worktree you are testing, run it with one session:

   ```sh
   scripts/podium-peers-e2e.sh up --dir "$TMPDIR/live" --port 4380 --sessions 1 --tmux live
   ```

   Add `--no-build` to reuse an earlier build. A build from older code tests older code, so leave it off after you change anything.

2. Attach with `tmux attach -t live`, or drive the window from outside (below). Each new folder asks once whether to trust it. The highlighted choice is **No, exit**, so move down to **Yes, I trust this folder** before you press Enter:

   ```sh
   tmux send-keys -t live:planner Down
   tmux send-keys -t live:planner C-m
   ```

3. Open `http://127.0.0.1:4380/`. The script prints the person's name and where the token and admin secret are kept. It never prints the secrets.

## Keep the session off your real server

If you have a reporter config file in `~/.podium/`, the session connects over TLS to the server it names and ignores the `serverUrl` in the settings the script wrote. A test session then shows up on your real console and never reaches the throwaway server. `/podium` in the session shows which one it uses: the "Podium fleet console" line must read `http://127.0.0.1:<port>/`.

To keep it off, start Claude Code with a `HOME` that has no `.podium` folder. Claude Code needs the rest of your home folder to stay signed in, so link every entry except `.podium` into a scratch folder:

```sh
FH="$TMPDIR/fakehome"; mkdir -p "$FH"
for f in ~/.[!.]* ~/Library; do
  [ "$(basename "$f")" = ".podium" ] || ln -s "$f" "$FH/$(basename "$f")"
done
```

Then start the session in its tmux window with `HOME="$FH"` exported, and the same `--plugin-dir` and `--settings` the script used. The `up` output shows both.

Tools run in that session create real folders under the scratch home, such as `.podium`. When you finish, delete the links with `find "$FH" -maxdepth 1 -type l -delete`, check nothing in it is a link with `find "$FH" -type l`, and only then remove the folder.

## Drive the session

Type into a window by sending the text, pausing, then sending Enter on its own. A long prompt sent with its Enter in one `send-keys` is often left unsubmitted:

```sh
tmux send-keys -t live:planner -l 'Use the Bash tool to run exactly: touch allow-me.txt'
sleep 1; tmux send-keys -t live:planner C-m
tmux capture-pane -p -t live:planner | tail -15
```

Things that change what Podium sees:

- **The permission mode.** `BTab` (Shift+Tab) cycles auto, manual, accept edits and plan. Podium only sees a tool permission in manual mode. A read-only command such as `echo` is allowed without asking, so use one that writes, such as `touch`.
- **A plan.** Cycle to plan mode, then ask for a short plan. The ask opens when Claude presents it.
- **A question.** Ask Claude to use the AskUserQuestion tool with two options.
- **Respond off.** Set `respond` to `off` in a copy of the settings file and start a second session with it. Podium should refuse everything sent to it.

## Answer from Podium

The browser does this from the answer modal. A script can do it with `curl`. The routes are in [the server endpoints](spec/07-server/07-01-endpoints.md#browser-routes-for-responding). Every write needs the person's sign-in cookie, an `Origin` that matches the host, and `X-Podium-Respond: 1`, or the server answers `403 cross-site request refused`.

1. Sign in with the name and token from the seed file:

   ```sh
   B=http://127.0.0.1:4380
   curl -s -c cookies -H "Origin: $B" -H 'X-Podium-Respond: 1' -H 'Content-Type: application/json' \
     -d '{"name":"Ed","token":"<token>"}' "$B/api/fleet/respond/sign-in"
   ```

2. Find the session and its open ask. They are in `GET /api/fleet/state`, under `sessions[].asks` with `state: "open"`. A session that has not had a turn yet is not listed.

3. Answer the ask. The body is a delivery without its id, ask, sender or time:

   | To do this | Body |
   |---|---|
   | Allow a tool once | `{"kind":"allow-once"}` |
   | Deny a tool | `{"kind":"deny"}` |
   | Answer a question with its second option | `{"kind":"question","answers":[{"options":[1]}]}` |
   | Approve a plan | `{"kind":"plan-approve","mode":"default"}` |

   ```sh
   curl -s -b cookies -H "Origin: $B" -H 'X-Podium-Respond: 1' -H 'Content-Type: application/json' \
     -d '{"kind":"allow-once"}' "$B/api/fleet/respond/sessions/<session>/asks/<ask>/answer"
   ```

   `202` means the answer waits for the session. Read the ask back at `GET /api/fleet/respond/sessions/<session>/asks/<ask>`. A good run ends with `state: "closed"`, `closed.outcome: "podium"` and the delivery's `result: "took"`.

4. Send a message or a command to the session with `POST /api/fleet/respond/sessions/<session>/messages`, with `{"text":"..."}`, `{"command":"compact"}` or `{"command":"clear"}`. A session with respond off answers `422 not accepted`.

Check the effect in the terminal too. A tool that was allowed ran, a tool that was denied left no file, and `/clear` empties the transcript.

## Shut it down

Stop everything you started, and check that it is gone:

1. Exit the session with `/exit`, or let `down` kill the tmux session.
2. Run `scripts/podium-peers-e2e.sh down --dir "$TMPDIR/live" --tmux live`. It stops the server, kills the tmux session and removes the work folder. Add `--keep` to keep the database and the server log.
3. Remove the scratch home as described above.
4. Check `tmux ls` shows no session of yours and `lsof -nP -iTCP:4380 -sTCP:LISTEN` prints nothing.

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| The session never appears on the throwaway server | It is reporting to the server in your `~/.podium` reporter config | Run it with the scratch `HOME` above and check `/podium` |
| Claude Code says "Not logged in" | The scratch `HOME` is missing the links to your Claude Code files | Link every entry of your home except `.podium` |
| A hook blocks the prompt and asks for `sonar auth login` | Another plugin's hook cannot find its sign-in under the scratch `HOME` | Link the entry that holds it, or run the check with that plugin off |
| `403 cross-site request refused` | The `Origin` or `X-Podium-Respond: 1` header is missing | Send both on every write |
| `422 not accepted` | The session's `respond` setting does not allow that kind of answer | Check the setting, or the session's `accepts` in the state |
| The trust prompt ends the session | Enter picked the highlighted **No, exit** | Press Down first |

## Where to go next

- [Messaging](MESSAGING.md) has the multi-session version, with several machines and rights between them.
- [End-to-end tests](e2e/COVERAGE.md) is the browser suite that runs in containers.
