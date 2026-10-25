---
title: "6.7 Reporting cadence"
description: "When the reporter sends: on change, on heartbeat, and how often it polls git."
group: "Reference"
section: "6.7"
order: 7
---

# 6.7 Reporting cadence

- State changes mark `dirty`. A `$.clock.every(flushIntervalMs)` timer flushes when dirty or when `heartbeatMs` has passed since the last report.
- Git is polled every 10 s, not per flush. `$.agent.list()` and `$.session.usage()` are read per flush (both cheap).
- The session's place (`cwd`, project root, repository name) is re-read on each git poll, because the desktop app moves a pre-warmed spare to the project the person picks without restarting the session (#382). The new folder is `$.session.cwd()` once its answer changes, or the `cwd` a `classic.SessionStart` or `classic.UserPromptSubmit` hook carries, which wins when `$.session` still answers the old folder. The project root and repository name come from `$.session.root()` and `$.session.repo()` while their folder holds the new `cwd`; otherwise from git run there (`rev-parse --path-format=absolute --git-common-dir`, `config --get remote.origin.url`), else the folder itself. The stored git base (`base:<id>`) is not reset by a move.
- Never `await` a network call inside a hook that sits on the tool path. Hooks only mutate in-memory state and set `dirty`. The one exception is an open ask while the mod responds (5.3): its hook announces the ask and waits on the server on purpose, and only while the dialog it races is on screen.
- Events: assigned an id at creation, queued; the queue holds at most 500; acknowledged by `ackedEvents` count (the server acks all events in a valid report; the mod then clears them). If the server is unreachable: keep the latest snapshot and the event queue (oldest dropped past 500), retry with backoff 1 s → 2 s → 5 s → 10 s max, and update the status line to `podium ○ offline`. On the first success after failures, send the full snapshot plus queued events.
- On `session.end`, flush synchronously (await the POST, 2 s timeout) before returning from the hook.

<!-- nav:start -->
---

Previous: [6.6 Session display name](06-06-session-display-name.md) · Up: [6. The reporter protocol](README.md) · Next: [6.8 Version compatibility](06-08-version-compatibility.md)
<!-- nav:end -->
