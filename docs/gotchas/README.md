---
title: "Gotchas"
description: "Sharp edges you can hit when you run or work on Podium: what you see, why it happens and what to do, one page each."
group: "Project internals"
entries: "by-area"
---

# Gotchas

Sharp edges that are easy to hit when you run Podium or work on it, and how to get past them. It is for anyone who runs Podium or works on it. If something looks wrong, find your symptom here first.

Every entry has the same three parts:

- **You see**: what shows up on screen or in a terminal.
- **Why**: the cause, so you can tell whether it applies to you.
- **Do**: what to do about it.

This is the short, practical list. The full list of known limitations is under "Known issues" in
[docs/architecture/](../architecture/README.md). For setup and day-to-day use, see the [user guide](../user-guide/README.md).

## Connecting the mod

## Reporters and machines

The Reporters page in Admin lists reporters, not sessions and not machines. The rules that decide what counts as one
reporter are in SPEC section 7.7 ("Which reporters the server knows"). Nothing here is a bug in the server.

**Check it yourself.**

- On Admin > Reporters, a row shows the machine, the person and the token (as `pdm_` and a key id). Select a row for
  its machine id, source address and refused reports.
- A session's card shows its owner.
- In the server log, `reporter.connected` says which owner and machine was heard, and `report.conflict` says a report
  was refused because its session belongs to someone else. See [Logs](../user-guide/07-logs.md) in the user guide.

## Orchestrator messaging

The setup is in [MESSAGING.md](../MESSAGING.md), and its [Troubleshooting](../MESSAGING.md#troubleshooting) table covers
each answer the tools give. These are the ones that surprise people.

## Session recording

The feature is in [REPLAY.md](../REPLAY.md).

## All gotchas

<!-- entries:start -->
**Connecting the mod**

- [/podium says "offline" and "Last error: HTTP 401"](podium-offline-http-401.md): The server wants a token and the mod sends none or a wrong one; get yours with podiumctl token and enter it in the plugin settings.
- [The status line says "update mod", "update available" or "upgrade server"](status-line-update-mod-or-upgrade-server.md): The mod and server versions are out of step; update the mod and run /reload-plugins, or upgrade the server.
- [The token option has no row in the /config menu](token-option-missing-from-config-menu.md): The token option is marked sensitive so /config skips it; set it with /plugin configure instead.
- [The status line has a warning sign in front of podium v0.11.1 ● 1 live](warning-sign-before-the-status-line.md): Claude Code puts the warning sign and the mod's name on every pinned mod line; it is not a Podium warning and nothing removes it.
- [The effort shown is the old one after I run /effort](effort-shows-the-old-level-after-effort.md): The mod reads effort from each model request and has no event for the change; send your next prompt and the new level shows.
- [Installing the mod from the marketplace fails with "Permission denied (publickey)"](marketplace-install-permission-denied-publickey.md): The owner/repo shorthand makes Claude Code clone over SSH; use the full https URL for the marketplace entry.
- [My session's name is the folder, and background tasks, notifications and permission answers are missing](session-name-is-the-folder-and-classic-hooks-are-skipped.md): On a Team or Enterprise login Claude Code skips the mod's classic hooks; the name now comes from claude agents, the rest still does not report.
- [The Activity section says to turn on activityFeed, but the option is on](activity-feed-says-turn-on-the-option-but-it-is-on.md): A session reads its podium-reporter options once, when it starts; run /reload-plugins in it after turning an option on.

**Reporters and machines**

- [The page shows more reporters than I have machines](more-reporters-than-machines.md): Admin counts reporters, and one machine can run several sessions; count cards for sessions and machine ids for machines.
- [One machine showed as two rows with different machine ids (fixed in #267)](one-machine-two-rows-different-machine-ids.md): Before #267 each load of the mod kept its own machine id; update the mod and the machine settles on one shared id.
- [One machine shows an extra row ending in # and a name](extra-machine-row-ending-in-hash-and-name.md): A machine gets one row per account that reports from it, so a second person or a changed setting adds a row; this is by design.
- [A reporter with no name has a row of its own, and another once it has one](unnamed-reporter-gets-its-own-row.md): A reporter without a name is keyed by address, so naming it adds a second row; set userName and a token everywhere, then remove the old row.
- [Rows that read "Not since restart" and never go away](not-since-restart-rows-never-go-away.md): A container's address changes on each restart and leaves an addr row behind; remove the rows in Admin or turn on Forget old reporters.
- [I changed my reporter settings and a running session did not change who it reports as](running-session-keeps-its-old-identity.md): A session takes its name and token once, when it starts; quit Claude Code and start a new session, or set PODIUM_USER and PODIUM_TOKEN.
- [The status line says "refused: session belongs to someone else"](refused-session-belongs-to-someone-else.md): The server refuses reports for a session owned by another person; quit Claude Code and start a new session.
- [A refused client certificate shows as "socket hang up", not a TLS alert](refused-client-certificate-looks-like-a-reset.md): Under TLS 1.3 the reporter port refuses a bad client certificate after the handshake, so it reads as a reset; check the certificate, not the network.

**Running the server**

- [podiumctl start fails with "port N ... is already in use"](podiumctl-start-port-already-in-use.md): Something else listens on the port, often a leftover run; check with podiumctl status, stop it or pick another port with --port.
- [I changed a setting and nothing happened](changed-a-setting-and-nothing-happened.md): podiumctl config set only edits config.env; run podiumctl restart to apply it.
- [On macOS the first podiumctl start takes a while](first-start-on-macos-takes-a-while.md): Podman starts its VM and builds the image on the first start; wait, and later starts are quick.
- [podiumctl uses Podman, but I want Docker (or the other way round)](podiumctl-uses-podman-but-i-want-docker.md): Container mode prefers Podman and remembers the first engine; remove the container and start again with --engine.
- [podiumctl disable stopped my standalone server](podiumctl-disable-stopped-my-server.md): Removing the launchd or systemd service stops the standalone server it ran; start it again with podiumctl start.
- [A restart shows every session as stale](restart-shows-every-session-as-stale.md): Sessions come back from SQLite as stale and recover when their reporters next send, within about five seconds.
- [podman inspect podium shows the token](podman-inspect-shows-the-token.md): The token is part of the container's environment and inspect prints it; treat the account that runs the engine as trusted.
- [Anyone on localhost can read the console](anyone-on-localhost-can-read-the-console.md): Reads are open on localhost by design; keep the default bind unless you want others to see the console.
- [A name set with the shared secret, or with no token, shows no person](name-without-a-person-token-shows-no-person.md): The people view follows the token, not the name; give each person a token in Admin and put it in their reporter with their name.
- [A group change shows a few seconds late](group-change-shows-a-few-seconds-late.md): Groups are read when a session's view is built, so the wall changes with the next report; wait a few seconds.
- [systemctl --user start podium.service does nothing after podiumctl stop (container mode)](systemctl-start-does-nothing-after-podiumctl-stop.md): The container unit stays active after podiumctl stop; use podiumctl start, or stop the unit and then start it.

**What the console shows**

- [A session shows no plan](session-shows-no-plan.md): Podium builds the plan from the session's task list only; turn on the task tools and ask Claude to track the work as a task list.
- [A plan step has no owner](plan-step-has-no-owner.md): An agent links to a step only when its description matches the step's title literally; matching wording helps.
- [An agent's cost does not add up to the session's](agent-costs-do-not-add-up-to-the-session.md): An agent's row shows its own estimate while the card shows the session's figure; update the mod for exact sums.
- [Every agent sits under the orchestrator in a session started without the mod](flat-agent-tree-without-the-mod.md): Settings hooks do not say which agent launched which, so a hook-only session cannot nest; install the mod for the nested tree.
- [Elapsed times freeze when the tab is in the background](elapsed-times-freeze-in-a-background-tab.md): Browsers throttle timers in hidden tabs; the numbers catch up when you look at the tab again.
- [The console's GPU use goes up after adding an animation](gpu-use-goes-up-after-adding-an-animation.md): An endless smooth CSS animation redraws on every display refresh; drive repeating motion from the shared heartbeat instead.
- [A resumed session's running time starts when Podium first saw it](resumed-session-running-time-starts-late.md): Podium keeps a reported start time only if it is within 2 minutes of first hearing of the session; this is how the start is kept.
- [A session sitting at the prompt shows as waiting](idle-session-shows-as-waiting.md): A session at the prompt is waiting on you, so the callout is correct; use the status filter to focus.
- [A new session is not on the wall until I send a prompt](new-session-not-on-the-wall-until-a-prompt.md): Podium keeps a session off the wall until it has done something; send a prompt and the card appears.
- [A session I closed is still on the wall](closed-session-is-still-on-the-wall.md): Closing the window can move the conversation to the background; end it with claude stop and the card leaves.
- [A session started without the mod stays "live" for ten minutes after it goes quiet](hook-only-session-stays-live-for-ten-minutes.md): Settings hooks send no heartbeat, so a hook-only session goes stale after 10 minutes; install the mod for faster detection.
- [A session in the Claude desktop app stays on the wall until I delete it](desktop-session-stays-on-the-wall-until-deleted.md): The desktop app keeps every sidebar session open, so each card stays until you delete the session from the sidebar.
- [Blowouts 1x on a card that is nowhere near full](blowout-on-a-card-nowhere-near-full.md): An automatic compaction after a quiet stretch is the likely cause; it is not a usage reset or an overflow.

**Orchestrator messaging**

- [Two orchestrators on the same machine cannot message each other](two-orchestrators-on-one-machine-cannot-message.md): Sessions on one machine share a reporter that has no right to itself; set the diagonal cell on My reporters or trust your own reporters.
- [A message does not arrive while the other session waits at a permission prompt](message-waits-while-the-other-session-is-at-a-prompt.md): A message is handed over only when the receiver is idle, so answer the permission prompt and it arrives after that turn.
- [My reporters is missing after signing in with the admin secret](my-reporters-missing-after-admin-sign-in.md): The admin secret belongs to no one and has no reporters; sign in with your own name and token.

**Session recording**

- [Record says "This session's reporter does not allow recording"](record-says-the-reporter-does-not-allow-recording.md): The reporter's sessionRecording option is off by default; turn on Allow session recording on that machine.
- [A permission prompt or question I answered in the terminal is not in the replay](terminal-answers-missing-from-the-replay.md): The replay marks only answers sent from Podium; read the tool's result to see what ran.
- [After /clear the recording is on a different session](recording-moves-to-a-new-session-after-clear.md): /clear gives the session a new id and the recording carries over; replay the first part from the old page and the rest from the new one.

**Developing**

- [An Admin style does nothing, or looks like the fleet page's](admin-style-does-nothing-or-looks-like-the-fleet-page.md): fleet.css styles bare class names with higher specificity than admin.css; search it before adding a class and prefix any that collide.
- [A mockup of the Expand modal looks nothing like the real one, or its layout breaks](expand-modal-mockup-looks-wrong.md): Expand opens two different modals and invented class names can collide with fleet.css; copy the real component and search the stylesheets first.
- [npm run test:mod and npm run typecheck:mod fail on a clean machine](test-mod-and-typecheck-mod-fail-on-a-clean-machine.md): Both commands need Claude Code installed and CI cannot run them; install it and run them locally when you change the mod.
- [A test run with claude -p cannot launch a fork](claude-p-test-run-cannot-launch-a-fork.md): Forks are off in a non-interactive run; set CLAUDE_CODE_FORK_SUBAGENT=1 for the run.
- [A prompt sent to Claude Code with tmux send-keys stays in the box unsent](tmux-send-keys-prompt-stays-unsent.md): Keys sent in one burst read as a paste and Enter does not submit it; send the text, pause, then send Enter on its own.
- [A server test fails now and then with a 404, a 401 or a body of {}, and passes on the next run](server-test-fails-now-and-then-then-passes.md): supertest can reach another process on 127.0.0.1; keep testSetup.ts in the vitest setup files and bind test servers to 127.0.0.1.
- [The frontend build says Property 'toBeInTheDocument' does not exist on type 'Assertion'](frontend-build-tobeinthedocument-type-error.md): vitest 5 and jest-dom declare Assertion with different type parameters; frontend/src/jest-dom.d.ts redeclares the matchers.
- [Finished nested agents are missing from $.agent.list()](finished-nested-agents-missing-from-agent-list.md): The engine's list drops finished agents once their parent finishes; do not rely on $.agent.list() for history.
- [A turn.step hook that reads the stream loses the step's result](turn-step-hook-loses-the-step-result.md): A for await loop throws away the stream's return value; read the result from await stream.result after the loop.
- [A mod fix did not reach anyone](mod-fix-did-not-reach-anyone.md): Installed copies update only when the plugin.json version changes, and that bump happens in the release-prep PR.
- [A new color theme shows up in the dropdown but the page stays on Podium's colors](new-color-theme-has-no-effect.md): A theme lives in themes.ts, tokens.css and the inline script in index.html; update all three.
- [npm run test:mod fails with 'Permission to use AskUserQuestion has been denied'](test-mod-fails-where-the-engine-denies-an-ask.md): A fake tool.check that answers ask is denied by Claude Code 2.1.310's test engine; the mod's tests answer allow and set ask only where a test needs it.
- [A store call without await compiles and answers wrongly](a-store-call-without-await-compiles-and-answers-wrongly.md): Every storage call returns a promise; a missing await passes the type checker. Await it, and keep Storage.tx free of other waits.
<!-- entries:end -->
