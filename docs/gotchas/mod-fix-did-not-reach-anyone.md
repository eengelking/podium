---
title: "A mod fix did not reach anyone"
description: "Installed copies update only when the plugin.json version changes and a release publishes the built plugin; the bump happens in the release-prep PR."
group: "Project internals"
area: "Developing"
date: "2026-10-11"
status: "open"
order: 51
---

# A mod fix did not reach anyone

**You see:** You merged a mod change and installed copies behave as before.

**Why:** Installed copies only update when `version` in `plugin/claudecode/.claude-plugin/plugin.json` changes. A merge into `development`
reaches no installed copy either way: the marketplace serves the built plugin from the `plugin-dist` branch, and `plugin-dist.yml`
publishes there only on a merge to `main`, which is a release (DECISIONS 58). A change to the shared code in `plugin/core/` counts as a mod change, because
it ships inside the built plugin.

**Do:** The version is bumped in the release-prep PR, not in feature PRs. See the `podium-release` skill (`.claude/skills/podium-release/`) for the
files that change together, including `VERSION` in `plugin/claudecode/hooks/register.ts` (the number the mod reports;
a test checks the two match). CI (`mod-version-check`) checks the release PR into `main`.
If the release has merged and the fix still did not arrive, check that the `Plugin dist` run for the merge is green and that the new
commit is on `plugin-dist`; a failed run publishes nothing and the marketplace keeps serving the last good commit. How an installed copy picks up
a new commit on that branch is checked in #928, not here.

<!-- nav:start -->
---

Previous: [A turn.step hook that reads the stream loses the step's result](turn-step-hook-loses-the-step-result.md) · Up: [Gotchas](README.md) · Next: [A new color theme shows up in the dropdown but the page stays on Podium's colors](new-color-theme-has-no-effect.md)
<!-- nav:end -->
