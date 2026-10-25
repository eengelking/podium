---
title: "5.10 Alternatives and extras the implementer may use"
description: "Other ways to feed Podium (settings hooks, environment variables, telemetry) that the implementer may use."
group: "Reference"
section: "5.10"
order: 10
---

# 5.10 Alternatives and extras the implementer may use

- **Settings command hooks** (`.claude/settings.json` `hooks`: `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Notification`, `PermissionRequest`, `TaskCreated`, `TaskCompleted`, `Stop`) can `curl` the server without a mod. Every payload has `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and inside a subagent `agent_id`, `agent_type`, and often `effort.level`. They lack per-step usage and context, so they can only drive a reduced display. `POST /api/fleet/hook` accepts them, for sessions started without the mod. The mod is the primary path.
- **`CLAUDE_EFFORT` env var** is set for hook commands and Bash children; useful only for settings-hook scripts.
- **`telemetry.*` hooks** can forward engine telemetry to a collector. Out of scope.
- **Status line command** (`statusLine` setting) can show Podium's URL in the terminal. Out of scope; the mod uses `$.ui.status`.
- **OpenTelemetry**: the engine can export OTel metrics natively. Out of scope; noted so nobody rebuilds it.
- **`$.model.complete`** with `model: "haiku"`, `effort: "low"` is the cheapest way to produce a one-paragraph failure explanation (Phase 5, opt-in).
- **`claude-api` skill** (invoke it) is the source for current model ids, context windows and prices when filling `models.ts`. Do not guess prices from memory.

<!-- nav:start -->
---

Previous: [5.9 Mod configuration (userConfig)](05-09-mod-configuration-userconfig.md) · Up: [5. The Claude Code mod API: everything the reporter needs](README.md) · Next: [5.11 Testing a mod (Verified in the reference)](05-11-testing-a-mod.md)
<!-- nav:end -->
