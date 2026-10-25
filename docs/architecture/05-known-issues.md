---
title: "Known issues"
description: "The numbered known issues in the build, with their reasons; the short version is GOTCHAS."
group: "Project internals"
order: 5
---

# Known issues

The short, practical version is [docs/gotchas/](../gotchas/README.md). Other documents cite these numbers, so they stay
fixed.

1. **`explainFailures` was not tried against the real model.** It is tested in the kit with a stand-in
   for `$.model.complete`; all three allowed `claude -p` runs were spent before it was built.
2. **No agent-scoped tool calls in the mod's end-to-end test.** The test kit mints `tool.call`'s
   `agentId`, so a Skill or failing Bash inside an agent is covered by the pure `state.ts` tests and the
   real runs, not by `register.test.ts`.
3. **Not seen for real:** a subagent's own `session.compact`, a teammate, `classic.Notification` and
   `/clear` in an interactive session (the earlier real runs were headless `-p`). Each is covered by
   tests against the types. The status line and `/podium` have since been seen in an interactive session
   (October 2026), reporting to the container through the marketplace-installed mod.
4. **Plan owner matching is literal.** A step "Count .ts files under server" and an agent "Count .ts
   files in server" do not match (6.3's normalized contains rule); run 3 showed it. Steps then show no
   owner.
5. **Elapsed times and the stale countdown pause in a background tab.** Browsers throttle timers in
   hidden tabs; the numbers catch up when the tab is visible. The console also adds a `paused` class
   while the tab is hidden (`usePageVisible`), which pauses every CSS animation, and the heartbeat
   (`useHeartbeat`, which drives the running-dot pulse and the blinks through `data-beat`) stops too.
6. **Memory grows slowly under load.** The 5-minute soak (10 sessions x 20 extra agents, 3 SSE clients)
   went from 121.6 MB to 131.7 MB RSS, with growth slowing (+7.7 MB in the first 2 minutes, +2.4 MB in
   the last 2.5). Likely V8 warm-up and the SQLite page cache; a longer soak would tell.
7. **Cost estimates undershoot the ledger a little.** Run 1: main loop plus agent estimates $0.01237
   against a ledger of $0.01445. The orchestrator's figure is the ledger; agent figures are estimates and
   labeled so (DECISIONS 7).

8a. **What Claude Code reports for a non-Claude model (Ollama), partly observed.** On 2026-10-12 Claude Code
    2.1.296 was launched with `ANTHROPIC_BASE_URL=http://localhost:11434` and `--model gemma4:12b-pinned`
    (Ollama 0.34.4) with the 0.5.0 reporter. The session registered and appeared on the wall. Observed: the
    model string is the Ollama tag as given (`gemma4:12b-pinned`), the engine's `context.window` is 200,000
    (a default, not the model's real window, so the percentage computed from it would be a guess), effort
    is null, and no plan. The model never answered (the run hung), so the ledger cost, token usage, context
    percent and stop reasons for such a model are unobserved. The mod sends `costUsd` and `costUsdEst` as
    `null` for it, and the dashboard shows the model's own name in an "other" chip, cost "n/a", and "not
    counting 1 unpriced session" under Est. cost today.
8. **A session that starts at the prompt shows as waiting.** An idle interactive session is honestly
   "waiting on you"; with many idle sessions the wall fills with waiting callouts.
9. **The production build also compiles the server's test files into `server/dist`** (as the existing
   app already did). Harmless; not changed.
10. **A change of effort shows after the next model request.** The mod reads the effort the session sends
    on each `turn.step`; the API has no event for the setting changing. A level picked with `/effort`
    appears in Podium after the session's next prompt, not when it is picked. A probe of `$.config.list()`
    and `$.settings.read()` to catch it sooner has been proposed and not tried.
11. **Claude Code draws a warning sign before the status line entry.** The mod sets plain text with
    `$.ui.status`, which takes no severity. Claude Code's mods API docs say the host starts every mod's
    status line with `⚠` and the mod's name, so it is not a trust state and the mod cannot remove it (#29).
    `podium ● N live` is the normal state.
12. **The `systemd` boot unit has not run on a Linux host.** Its generated text is unit-tested only.
13. *(Removed with the usage dashboard, #30. The number is kept so other references stay valid.)*

<!-- nav:start -->
---

Previous: [Deviations from the spec](04-deviations-from-the-spec.md) · Up: [Architecture](README.md) · Next: [Browser checklist (T4.2)](06-browser-checklist.md)
<!-- nav:end -->
