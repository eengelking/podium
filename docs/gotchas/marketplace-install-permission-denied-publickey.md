---
title: "Installing the mod from the marketplace fails with \"Permission denied (publickey)\""
description: "The owner/repo shorthand makes Claude Code clone over SSH; use the full https URL for the marketplace entry."
group: "Project internals"
area: "Connecting the mod"
date: "2026-10-11"
status: "open"
order: 6
---

# Installing the mod from the marketplace fails with "Permission denied (publickey)"

**You see:** The install fails with `Permission denied (publickey)`.

**Why:** A marketplace entry that points at a subfolder of another repo with the `owner/repo` shorthand makes Claude
Code clone over SSH.

**Do:** Use the full `https://github.com/eengelking/podium.git` URL, as the `podium-reporter` entry does. If you add
your own entry for a public repo, do the same.

<!-- nav:start -->
---

Previous: [The effort shown is the old one after I run /effort](effort-shows-the-old-level-after-effort.md) · Up: [Gotchas](README.md) · Next: [The page shows more reporters than I have machines](more-reporters-than-machines.md)
<!-- nav:end -->
