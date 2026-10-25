---
title: "The status line has a warning sign in front of podium v0.11.1 ● 1 live"
description: "Claude Code puts the warning sign and the mod's name on every pinned mod line; it is not a Podium warning and nothing removes it."
group: "Project internals"
area: "Connecting the mod"
date: "2026-10-13"
status: "open"
order: 4
---

# The status line has a warning sign in front of `podium v0.11.1 ● 1 live`

**You see:** The line reads `⚠ podium-reporter: podium v0.11.1 ● 1 live`.

**Why:** Claude Code adds the `⚠` and the mod's name to every line a mod pins with `$.ui.status`. Its
[mods API docs](https://code.claude.com/docs/en/plugins/mods/api.md) give the format as `⚠ my-mod: checks: 3 passing`.
It is not a Podium warning and not a trust marker. The docs describe no approval, signing or marketplace step that
clears it, and the mod passes only `podium v0.11.1 ● 1 live`. We have not checked it against a mod loaded with
`--plugin-dir`, but the docs do not say the icon depends on where the mod came from.

**Do:** Nothing removes it. `podium v0.11.1 ○ offline` is the real warning.

<!-- nav:start -->
---

Previous: [The token option has no row in the /config menu](token-option-missing-from-config-menu.md) · Up: [Gotchas](README.md) · Next: [The effort shown is the old one after I run /effort](effort-shows-the-old-level-after-effort.md)
<!-- nav:end -->
