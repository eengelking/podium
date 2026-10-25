---
title: "Mod API findings"
description: "What the engine's mod API was checked to do against SPEC's assumptions, with the evidence for each."
group: "Project internals"
order: 7
---

# Mod API findings

Checked against the engine 2.1.296 type declarations, `claude plugin validate`, `claude plugin test`, and two real
`claude -p` runs (haiku) on 2026-10-10. The rows marked #206 were checked on 2.1.301 on 2026-10-15 with a
throwaway mod that recorded every hook's input and timing in an interactive session (SPEC 5.3). The rows marked
#411 were checked the same way on 2.1.303 on 2026-10-18, for orchestrator messaging (#347); the full record is
the findings comment on #411.

| Assumption (SPEC 5 and 12) | Result | Evidence |
|---|---|---|
| Relative imports may need explicit extensions | Both forms load. `./util.ts` and `./util` pass `validate` and run under `claude plugin test`; the mod uses `.ts` (also accepted by `tsc` with `allowImportingTsExtensions`) and loaded in both real runs. | a throwaway probe mod; run 1 `system/init` lists `podium-reporter@inline` |
| `userConfig` field syntax | `{ type, title, description, default }`, `type` one of `string`, `number`, `boolean`, `directory`, `file`; `title` and `description` are required. `sensitive: true` is accepted. | `validate` errors for a bad type and a missing title/description |
| `classic.PermissionRequest` hookable, fires headless | **Yes, both.** It is listed by `validate`, and in run 1 it fired for the model's Bash call under `-p` (a `wait` event "waiting on you: Bash(...)"). | run 1 events |
| `classic.Notification` hookable | Hookable (listed by `validate`, raised in tests). Not observed in a headless run. | `validate` |
| `session.compact` fires with `agentId` for a subagent's own compaction | Declared (`SessionCompactInput.agentId`: "for a subagent's or a fork's own transcript"). Not observed for real: neither run compacted. The reporter also counts `model_context_window_exceeded` stops, deduplicated within 2 s. | types |
| Effort visible on spawn | Not on `agent.spawn` (no field). Visible on the `Agent` tool call's input, and observed per step on `turn.step.effort`. | run 2: spawn event "Haiku low" before any step |
| `tool.call` (Agent) before or after `agent.spawn` | **Before.** The spawn event in run 2 already carried the requested effort, which only the tool call's input supplies. The reducer accepts both orders anyway. | run 2 |
| `$.session.usage().cost.usd` includes subagent spend | **Yes.** Run 1: ledger $0.014450 equals the CLI's `total_cost_usd` ($0.014450345); the main loop's own token estimate is $0.006628 and the agent's $0.005742 (sum $0.01237, the rest is pricing detail the estimate does not model). | run 1, database |
| Windows: 200,000 for haiku, 1,000,000 for others | **Wrong for the current Haiku.** Haiku 5.5 has a 1M window; only Haiku 4.5 (and older) has 200K. `windowOf` uses 200K only for `haiku-4`, `haiku-3`, `claude-3` ids. | `claude-api` skill, model table cached 2026-10-06 |
| Bash exit code in an error result | No field: `tool.call` error results carry `text` ("Exit code 1 ..."); the reporter parses it. | `BuiltinToolResults.Bash` has no exit code |
| #206: plan text and path on ExitPlanMode's `tool.call` | **Yes.** The input carries `plan` and `planFilePath`, though the declared type lists only `allowedPrompts`; `classic.PermissionRequest`'s `tool_input` has the same two. | recorded hook inputs |
| #206: Esc told apart from plan feedback | **Yes, by the text.** Both are `isError`; feedback reads "... To tell you how to proceed, the user said:\n`<feedback>`", Esc "... STOP what you are doing ...". | recorded results |
| #206: the engine ends a waiting PermissionRequest hook when the terminal answers first | **No.** `next.signal` never aborted; the hook held on for 60 s, past the command's end. The only signal is the call's `tool.call` resolving, so a tool ask stays open while a terminal-allowed command runs. | two Bash prompts answered "Yes" in the terminal |
| #206: `$.http.fetch` time limit | **30 s**: "no complete answer within 30000ms". Held requests wait 20 s at most. | recorded rejection |
| #206: `tool.check` before a prompt | Carries `tool_use_id`; resolves to `ask` 3 to 11 ms before `classic.PermissionRequest` fires (Bash and ExitPlanMode). The managed-setup case, where no PermissionRequest fires, is **unverified**. | recorded timings |
| #411: a `$.tool.register` tool can be kept from subagents | **No.** A foreground agent, a background agent and a fork all list it and call it. `tool.call` carries `agentId` on each of their calls and none of the main loop's, so the tool refuses a call that has one. The prompt-suggestion fork calls tools under an id no `agent.spawn` announced. Every Agent call ran in the background on this build, even one asked for in the foreground. | recorded `tool.call` and `agent.spawn` |
| #411: `$.prompt.submit` waits for the turn, with background agents running | **Yes, and they don't hold it.** Submitted 10 s into a 40 s Bash call, it resolved 17 ms after `turn.complete`. With a background agent 90 s into a build and the main loop idle, it started a turn within 11 ms. With a permission dialog open, it waited until the dialog was answered. The submitting mod's own `prompt.submit` hook does not fire for it. | recorded timings |
| #411: what the model reads from a plugin's prompt, and its authority | "The `<plugin>` plugin sent a message:", the text, then a line saying the turn starts "in the user's place"; a user row with `origin: { kind: 'plugin' }` and `promptSource: 'system'`. With that frame alone the model tried a `CLAUDE.md` edit the message asked for, and the auto-mode classifier denied it as `[Instruction Poisoning]`, where the person's typed request was allowed. With Podium's own opening line it refused that, a settings change, a force-push and approving a permission, without trying. | transcript; classifier results |
| #411: `$.ui.toast`, `$.ui.log` and a command during a turn | Toast in the footer, `⏺ <plugin>: <text>` in the transcript, neither starts a turn. A command without `immediate` waits for the turn to end; with `immediate: true` it runs at once. The transcript echoes the command without its arguments. | recorded `command.run` times |
| #411: the OS | No call for it. `$.process.run(['sw_vers'])` answers `macOS` and `27.0.1`; a missing executable (`cmd` on macOS) rejects. `/etc/os-release` holds `PRETTY_NAME` on Debian 12 (read in a container, not through the mod). Windows not checked. The `env_info_simple` prompt section does not carry the platform. | live mod; podman container |
| #411: Claude Code's cross-session messages beside a plugin's prompt | `session.receive` fires for a `SendMessage` from another session (`origin.kind: 'peer'`, a `<cross-session-message>` wrapper) and never for `$.prompt.submit`. Each starts its own turn, in order. A subagent's hand-back reaches `prompt.submit` as `origin.kind: 'peer'`, `isMeta: true`. | recorded events |
| Worktree detection when started inside a worktree | **Works.** Run 2 in a scratch worktree: `isWorktree: true`, `worktreePath` the worktree, branch `feat/wt-check`, `dirty: 1`, name `wt-check`, project the main checkout. | run 2 |
| Teammates | Reported as `kind: 'teammate'` from `agent.spawn.isTeammate`; not observed for real. | types |
| `$.session.version()` | Returns `{ version, base?, builtAt? }`, not a string. | types |
| `turn.step.effort` | May be a number as well as a level name; numbers are ignored. | types |

Further findings that shaped the code:

- **`$` is checked statically.** `validate` refuses a module that passes `$` to anything but a function
  declared at the top of the file, or that reads it as anything but `$.noun.event(...)` (so
  `runtime.$.session.id()` is refused). All `$` helpers are top-level functions taking `$`; the runtime
  lives in module variables that `register` resets.
- **No `setTimeout` in the sandbox.** Deadlines use `$.clock.sleep`; scheduling uses `$.clock.now()` (in
  tests that clock is mocked; a backoff computed from `Date.now()` never came due there, which a test
  caught).
- **`session.end` has one ~1.5 s bound** for all hooks and core; the final report waits at most 1 s.
- **Gating hooks.** `validate` names every hook at a site that can refuse (tool calls, spawns,
  compaction, classic events). Each reporter hook has a `.catch` that calls `next(e)` (it replays what
  `next` settled to when it was already called), so a reporter failure never changes an outcome.
- **Testing kit.** `claude plugin test` needs the test to answer the bottom of every event the plugin
  raises (`on('session.start', () => ({ cwd }))`) and every `$` call (`on('http.fetch', () => ({ value
  }))`). `tool.call`'s `agentId` and `tool_use_id` cannot be set from a test (the engine mints them), so
  agent-scoped tool results are covered by the pure `state.ts` tests. A compaction result must keep at
  least one message.
- **Hook cost.** With the server down, the reporter's own work measured 0.00-0.01 ms average and 0.03 ms
  at most per hook over 300 tool calls and steps (`register.test.ts`, via `/podium`). Target was under 5 ms.

`claude plugin validate mod/podium-reporter` output (T3.3.1):

```
Validating plugin manifest: mod/podium-reporter/.claude-plugin/plugin.json

Validating hooks: mod/podium-reporter/hooks/hooks.json

  ❯ ./register.ts hooks: session.start, session.end, turn.start, turn.step, turn.complete, session.compact, session.measure, session.attach, session.detach, agent.spawn, tool.call, tool.call{tool=mcp__podium-reporter__plan}, skill.prompt, classic.PermissionRequest, classic.Notification, command.run{command=podium}
  ❯ ./register.ts answers its own command: command.run{command=podium}
  ❯ ./register.ts gating hook with .catch: session.compact
  ❯ ./register.ts gating hook with .catch: agent.spawn
  ❯ ./register.ts gating hook with .catch: tool.call
  ❯ ./register.ts gating hook with .catch: tool.call{tool=mcp__podium-reporter__plan}
  ❯ ./register.ts gating hook with .catch: classic.PermissionRequest
  ❯ ./register.ts gating hook with .catch: classic.Notification
  ❯ ./register.ts calls: $.agent.list (via readAgents), $.clock.every (via start), $.clock.now (via engineNow), $.clock.sleep (via end), $.command.register (via start), $.http.fetch (via start), $.process.run (via pollGit), $.session.id (via flush, start), $.session.model (via start), $.session.repo (via start), $.session.root (via start), $.session.usage (via readUsage, start, switchSession), $.session.version (via start), $.store.get (via loadName), $.store.set (via podiumCommand), $.tool.register (via start), $.ui.log (via record), $.ui.status (via showStatus), $.ui.toast (via toastOnce)

✔ Validation passed
```

<!-- nav:start -->
---

Previous: [Browser checklist (T4.2)](06-browser-checklist.md) · Up: [Architecture](README.md) · Next: [Dependencies added](08-dependencies-added.md)
<!-- nav:end -->
