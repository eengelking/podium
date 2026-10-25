---
title: "A mod fix did not reach anyone"
description: "Installed copies update only when the plugin.json version changes, and that bump happens in the release-prep PR."
group: "Project internals"
area: "Developing"
date: "2026-10-11"
status: "open"
order: 51
---

# A mod fix did not reach anyone

**You see:** You merged a mod change and installed copies behave as before.

**Why:** Installed copies only update when `version` in `mod/podium-reporter/.claude-plugin/plugin.json` changes.

**Do:** The version is bumped in the release-prep PR, not in feature PRs. See "Releases" in `.claude/CLAUDE.md` for the
files that change together, including `VERSION` in `mod/podium-reporter/hooks/register.ts` (the number the mod reports;
a test checks the two match). CI (`mod-version-check`) checks the release PR into `main`.

<!-- nav:start -->
---

Previous: [A turn.step hook that reads the stream loses the step's result](turn-step-hook-loses-the-step-result.md) · Up: [Gotchas](README.md) · Next: [A new color theme shows up in the dropdown but the page stays on Podium's colors](new-color-theme-has-no-effect.md)
<!-- nav:end -->
