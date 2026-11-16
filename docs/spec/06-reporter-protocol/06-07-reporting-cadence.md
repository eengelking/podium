---
title: "6.7 Reporting cadence"
description: "When the reporter sends: on change, on heartbeat, and how often it polls git."
group: "Reference"
section: "6.7"
order: 7
---

# 6.7 Reporting cadence

- State changes mark `dirty`. A `$.clock.every(flushIntervalMs)` timer flushes when dirty or when `heartbeatMs` has passed since the last report.
- **A large report that only counted waits (#752).** Every report is the whole session, so one with many agents is large (about 145 KB at 200 agents). When a report is over 32 KB and differs from the last one the server took only in counters (tokens, cost, context, the last tool, call and step counts, and the `signals` counts) and in events, the reporter holds it until `min(heartbeatMs, ⌈last report size ÷ 32 KB⌉ s)` has passed since that one: 2 s for a report just over 32 KB, 5 s from about 130 KB. Nothing else is held: a status, a wait, an ask, a failure, a plan, a git or place change, a new or ended agent, an activity feed a viewer watches, and any field the rule does not list go at the next flush, as does a report once the event queue holds a full batch (100) and the report of a session that is ending. The held report is built again at the next flush, so nothing is lost and the events stay queued, and the first report, and the first after a failure, are never held. A report of 32 KB or less is sent at every flush as before. The rule is in `Transport` (`plugin/core/pacing.ts`), which both reporters send through. The report format does not change, so there is no protocol change and no version range moves ([6.8](06-08-version-compatibility.md)). The cost is that a counter on the wall can be up to 5 s old for a session of about 130 KB or more.
- Git is polled every 10 s, not per flush. `$.agent.list()` and `$.session.usage()` are read per flush (both cheap).
- The session's place (`cwd`, project root, repository name) is re-read on each git poll, because the desktop app moves a pre-warmed spare to the project the person picks without restarting the session (#382). The new folder is `$.session.cwd()` once its answer changes, or the `cwd` a `classic.SessionStart` or `classic.UserPromptSubmit` hook carries, which wins when `$.session` still answers the old folder. The project root and repository name come from `$.session.root()` and `$.session.repo()` while their folder holds the new `cwd`; otherwise from git run there (`rev-parse --path-format=absolute --git-common-dir`, `config --get remote.origin.url`), else the folder itself. The stored git base (`base:<id>`) is not reset by a move.
- Never `await` a network call inside a hook that sits on the tool path. Hooks only mutate in-memory state and set `dirty`. The one exception is an open ask while the mod responds (5.3): its hook announces the ask and waits on the server on purpose, and only while the dialog it races is on screen.
- Events: assigned an id at creation, queued; the queue holds at most 500; acknowledged by `ackedEvents` count (the server acks all events in a valid report; the mod then clears them). If the server is unreachable: keep the latest snapshot and the event queue (oldest dropped past 500), retry with backoff 1 s → 2 s → 5 s → 10 s max, and update the status line to `podium ○ offline`. On the first success after failures, send the full snapshot plus queued events.
- A harness announces itself at launch (#1112). Claude Code's first report goes out as its session starts. A harness that makes no session until the first prompt (OpenCode) reports a placeholder under an id that starts `launch-`, named for the folder it started in, and ends it (`endReason` `launched`) when its first real session starts. It is never ended for being quiet, only by that or by shutdown. Either way the report is of a session that has done nothing, which the server keeps off the wall while the chat lists it (#42). `plugin/core/launch.ts` holds the id rule.
- On `session.end`, flush synchronously (await the POST, within a bound of about 1 s for Claude Code and 1.5 s for OpenCode) before returning from the hook.

<!-- nav:start -->
---

Previous: [6.6 Session display name](06-06-session-display-name.md) · Up: [6. The reporter protocol](README.md) · Next: [6.8 Version compatibility](06-08-version-compatibility.md)
<!-- nav:end -->
