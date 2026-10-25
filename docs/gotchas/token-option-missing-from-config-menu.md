---
title: "The token option has no row in the /config menu"
description: "The token option is marked sensitive so /config skips it; set it with /plugin configure instead."
group: "Project internals"
area: "Connecting the mod"
date: "2026-10-11"
status: "open"
order: 3
---

# The token option has no row in the `/config` menu

**You see:** The mod's other options are in the `/config` menu, but `token` is not.

**Why:** The option is marked `sensitive`, and Claude Code only draws menu rows for options that are not secret.

**Do:** Use `/plugin configure`. For a copy loaded with `--plugin-dir`, putting the token in
`~/.claude/settings.json` under `pluginConfigs`, `podium-reporter`, `options`, `token` also worked when we tried it.

<!-- nav:start -->
---

Previous: [The status line says "update mod", "update available" or "upgrade server"](status-line-update-mod-or-upgrade-server.md) · Up: [Gotchas](README.md) · Next: [The status line has a warning sign in front of podium v0.11.1 ● 1 live](warning-sign-before-the-status-line.md)
<!-- nav:end -->
