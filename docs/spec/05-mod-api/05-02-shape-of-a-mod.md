---
title: "5.2 Shape of a mod (Verified)"
description: "The files a mod is made of: plugin manifest, hooks list and the register module."
group: "Reference"
section: "5.2"
order: 2
---

# 5.2 Shape of a mod (Verified)

A mod is three files plus optional extras:

- `.claude-plugin/plugin.json`: `{ "name": "podium-reporter", "version": "0.1.0", "description": "…" }`. Add `"userConfig"` for options (see 5.9) and `"types"` only if the mod keeps values in `$.state`.
- `hooks/hooks.json`: `{ "modules": ["./register.ts"] }`. Exactly one path, relative to that file.
- `hooks/register.ts`: `export const register: Register = (on, options) => { … }` with `import type { Register } from 'claude-code'`.

Rules the module must obey:

- Runs in its own sandbox: **no DOM, no Node, no `import()`**. Everything outside is reached through `$`.
- Every file the plugin imports must be `.ts`, `.tsx`, `.jsx`, `.js`, `.mjs`, `.cjs`, `.mts` or `.cts` and is an ES module. Import with `import` declarations only. **Assumption:** relative imports may need explicit extensions (`./state.ts`); try `validate` and keep whichever form it accepts.
- A hook is `($, e, next)`.
  - `next(e)` runs the plugins beneath and then the engine, resolving to the event's result.
  - Returning without `next` answers for yourself (never do this in the reporter except for the commands and
    tool it registers).
  - `next({ ...e, x })` rewrites.
  - The reporter only observes: it must always call `next(e)` and return what it resolves to unchanged. The
    one exception is answering for Podium ([5.3](05-03-events-the-reporter-hooks.md#responding-from-podium)): with the `respond` option on, the
    hooks for an open ask may return an answer from Podium while `next(e)` is still pending, and nothing
    else.
- A hook that throws or outlasts its budget is skipped. Wrap every reporter hook body in `try/catch`; on error, record it in a bounded in-memory error list and still `return next(e)`. For hooks where `next` may already have run, never call it twice.
- Module variables are lost on hot reload. That is fine for the reporter: rebuild state from `$.agent.list()`, `$.session.*` and `$.session.usage()` on `session.start` and on reload, and accept some lost event history.
- Reload: a reload runs `register` again and fires `session.start` again. `$.store` (across sessions) and `$.state` (the session's) survive.

Run during development:

```
claude plugin validate mod/podium-reporter          # manifest + source: lists every event hooked and every $ call made
tsc -p mod/podium-reporter                           # only once the engine has laid types in .claude-plugin/types/
claude plugin test mod/podium-reporter               # runs hooks/*.test.ts against the engine
claude --plugin-dir mod/podium-reporter              # a session with the mod loaded (hot-reloads on save)
claude --plugin-dir mod/podium-reporter -p "…"       # headless; always loads fresh
```

<!-- nav:start -->
---

Previous: [5.1 Where the truth is](05-01-where-the-truth-is.md) · Up: [5. The Claude Code mod API: everything the reporter needs](README.md) · Next: [5.3 Events the reporter hooks](05-03-events-the-reporter-hooks.md)
<!-- nav:end -->
