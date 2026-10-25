---
title: "The page shows more reporters than I have machines"
description: "Admin counts reporters, and one machine can run several sessions; count cards for sessions and machine ids for machines."
group: "Project internals"
area: "Reporters and machines"
date: "2026-10-15"
status: "open"
order: 7
---

# The page shows more reporters than I have machines

**You see:** Admin > Reporters lists more rows than you have computers.

**Why:** Each running Claude Code session is its own card, and a machine can run several. The page counts reporters,
so three sessions on one Mac can look like extra reporters when they show as separate rows (the next entries say why
they do).

**Do:** Count the cards on the wall for sessions and the machine ids on the page for machines.

<!-- nav:start -->
---

Previous: [Installing the mod from the marketplace fails with "Permission denied (publickey)"](marketplace-install-permission-denied-publickey.md) · Up: [Gotchas](README.md) · Next: [One machine showed as two rows with different machine ids (fixed in #267)](one-machine-two-rows-different-machine-ids.md)
<!-- nav:end -->
