---
title: "5.4 Engine calls the reporter uses (Verified)"
description: "The engine calls the reporter makes, what each returns, and what the reporter uses it for."
group: "Reference"
section: "5.4"
order: 4
---

# 5.4 Engine calls the reporter uses (Verified)

All calls are async unless noted. Read each one's doc comment in the types file before first use.

| Call | Returns / does | Reporter's use |
|---|---|---|
| `$.session.id()` | session id (transcript file name) | Primary key. Re-read on every flush to detect a `/clear`. |
| `$.session.cwd()`, `$.session.root()` | absolute dirs | Name, project path. `root()` follows `/cd` and worktree moves. |
| `$.session.model()` | main loop model as `/model` shows it | Orchestrator model. |
| `$.session.repo()` | `{ root, remote, internal, name } \| null` | Repository name (`name` may be null; fall back to the remote's `owner/name` parsed from `remote`, else directory name). |
| `$.session.usage(args?)` | `{ startedAt, context: { tokens?, window, percent? }, rateLimits, cost?: { usd } }` | Main-loop context, **real session cost**, start time, rate limits. Plain call is free. Do **not** pass `breakdown`. |
| `$.session.surfaces()` | the clients attached to the session (`terminal`, `desktop`, `vscode`, `mobile`); empty in a plain `-p` run and for a background job nobody has attached to | `attached` is `surfaces().length > 0`. Read on every flush; a failed read leaves `attached` as it was (null at first). A non-interactive `-p` run therefore reads as nobody attached. |
| `$.session.turns()`, `$.session.version()`, `$.session.messages()` | counts, engine version, transcript | `version()` goes in the report for debugging. **Never call `messages()` for reporting** (privacy, cost). |
| `$.agent.list()` | `AgentInfo[]`: `{ id, teammateId?, description, type, status, parentId?, spawnedBy?, name? }`, `status` ∈ `pending` `running` `waiting` `idle` `completed` `failed` `killed` | Reconcile agent existence and status on every flush. Authority for "which agents exist now". |
| `$.process.run(argv, { cwd, timeoutMs, env, stdin })` | `{ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated }`, **no shell**, git runs with repo hooks off, default timeout 30 s | All git queries (section 5.7). CLI only. |
| `$.http.fetch(url, { method, headers, body })` | `{ status, ok, headers, text }`, goes through the host, `http` or `https`. Rejects on network failure. | POST reports. Always set `Content-Type: application/json`. |
| `$.clock.now()`, `$.clock.every(ms, fn)`, `$.clock.after(ms, fn)`, `$.clock.sleep(ms, { signal })` | `every`/`after` return a handle with `cancel()` | The flusher and git poller. Start timers from `session.start`; they run until cancelled or the module reloads. Cancel in `session.end` only when the whole process is ending (see 5.8). |
| `$.store.get/set/delete/keys` | JSON key-value, per plugin, survives sessions (4 MiB cap) | Offline buffer spill (optional), session display names, last-seen server URL. |
| `$.state` + `atom`, `read`, `update` (from `'claude-code'`) | Host-held session values with versions; redraw readers | Only if a pane is added later. The reporter needs none. If used, declare them in `types/index.d.ts` and name it in `plugin.json`. |
| `$.settings.read()`, `$.env.get(NAME)` | merged settings; env var (name must be a **string literal**) | Optional: read `CLAUDE_EFFORT`, `LANG`. |
| `$.command.register({ name, description, argumentHint? })` | Registers a slash command | `/podium`. Serve with `on('command.run', { command: 'podium' }, …)` returning `{ text }`. Call in `session.start`. |
| `$.tool.register({ name, description, inputSchema, isDeferred? })` | Registers `mcp__podium-reporter__<name>` | Optional `plan` tool so an orchestrator can name its plan (section 6.3). Serve with `on('tool.call', { tool: 'mcp__podium-reporter__plan' }, …)` returning `{ result }`. |
| `$.ui.status(text)`, `$.ui.toast(text)`, `$.ui.log(text, { to: 'debug' })` | Status-line entry, toast, transcript or debug-log line | Status line shows `podium vX.Y.Z ● 4 live` or `podium vX.Y.Z ○ offline` (the mod's own `VERSION` in every state); the host draws it as `⚠ podium-reporter: <text>`, which the mod does not control. `log` to `debug` only, except the terminal lines for responding (5.3), which go to the transcript. No toasts except on first successful connect and first failure. |
| `$.prompt.submit({ text })` | Submits a prompt as a turn of its own once the session is idle, under the plugin's name (Verified on 2.1.301, #206) | A message from Podium (5.3, "Responding"). Never awaited in the flush loop, never `asUser`. |
| `$.command.run({ command })` | Runs a slash command as if the person typed it, once the session is idle; rejects inside a hook a turn waits on (Verified on 2.1.301, #206) | `/clear` and `/compact` from Podium, from the flush timer, and no other command. |
| `$.model.complete({ model, prompt, effort? })` | `{ isAnswered, text?, usage, reason? }`, never rejects over provider errors | Optional failure explanation (Phase 5), default **off**. |
| `$.agent.register(spec)`, `$.agent.spawn(args)` | Define or start agent types | **Not used.** Listed so the implementer does not reach for them. |

`$.process`, `$.fs` and the UI nouns may be unavailable in some hosts (`-p`, SDK, desktop). Every call in the
reporter must be wrapped so that a missing capability degrades the report (null field) instead of failing it.

<!-- nav:start -->
---

Previous: [5.3 Events the reporter hooks](05-03-events-the-reporter-hooks.md) · Up: [5. The Claude Code mod API: everything the reporter needs](README.md) · Next: [5.5 Tool inputs the reporter reads (Verified)](05-05-tool-inputs-the-reporter-reads.md)
<!-- nav:end -->
