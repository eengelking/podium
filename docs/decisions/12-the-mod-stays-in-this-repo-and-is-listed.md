---
title: "12. The mod stays in this repo and is listed from the skills marketplace"
description: "podium-reporter lives in this repo and the skills marketplace lists it by a git-subdir source, so a mod fix needs a version bump to reach users."
group: "Project internals"
number: 12
date: "2026-10-11"
status: "accepted"
order: 12
---

# 12. The mod stays in this repo and is listed from the skills marketplace

**Decision.** `podium-reporter` lives in `mod/podium-reporter/` here. `eengelking-marketplace` (in
`eengelking/skills`) lists it with a `git-subdir` source, using a full `https://` URL (2026-10-11,
`eengelking/skills` PRs #32 and #33).

**Why.**

- A marketplace is only a listing, so one `eengelking-marketplace` can point at plugins that live in other
  repos.
- The mod has to sit beside the server because of entry 6.
- The `eengelking/skills` repo is for project-agnostic skills, and this mod is tied to one project.
- The `owner/repo` shorthand makes Claude Code clone over SSH, which fails for anyone without a GitHub SSH
  key.

**Cost.** A mod fix needs a `plugin.json` version bump or installed copies never update. CI checks it
(`mod-version-check`).

<!-- nav:start -->
---

Previous: [11. Start on boot through launchd and systemd user units](11-start-on-boot-through-launchd-and-systemd-user-units.md) · Up: [Decisions](README.md) · Next: [13. The token option is sensitive](13-the-token-option-is-sensitive.md)
<!-- nav:end -->
