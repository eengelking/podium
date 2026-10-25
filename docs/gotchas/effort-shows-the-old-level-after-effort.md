---
title: "The effort shown is the old one after I run /effort"
description: "The mod reads effort from each model request and has no event for the change; send your next prompt and the new level shows."
group: "Project internals"
area: "Connecting the mod"
date: "2026-10-11"
status: "open"
order: 5
---

# The effort shown is the old one after I run `/effort`

**You see:** The effort bars on the console still show the previous level.

**Why:** The mod reads the effort the session sends with each model request, and the plugin API has no event for the
setting changing.

**Do:** Send your next prompt. The new level shows after it. This is expected.

<!-- nav:start -->
---

Previous: [The status line has a warning sign in front of podium v0.11.1 ● 1 live](warning-sign-before-the-status-line.md) · Up: [Gotchas](README.md) · Next: [Installing the mod from the marketplace fails with "Permission denied (publickey)"](marketplace-install-permission-denied-publickey.md)
<!-- nav:end -->
