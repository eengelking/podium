---
title: "One machine shows an extra row ending in # and a name"
description: "A machine gets one row per account that reports from it, so a second person or a changed setting adds a row; this is by design."
group: "Project internals"
area: "Reporters and machines"
date: "2026-10-15"
status: "open"
order: 9
---

# One machine shows an extra row ending in `#` and a name

**You see:** A row keyed like `<machine id>#<owner>` next to the machine's first row.

**Why:** Since #221 a machine gets one row for each account that reports from it, keyed `<machine id>#<owner>` for
every account after the first. Since #226 a session keeps the name and token it started with, so a machine can carry
two people at once (two terminals, or one before and one after a change of settings) and shows two rows.

**Do:** Nothing. This is by design. Whether a machine should collapse to one row across accounts would reverse part of
#221 and is not decided.

<!-- nav:start -->
---

Previous: [One machine showed as two rows with different machine ids (fixed in #267)](one-machine-two-rows-different-machine-ids.md) · Up: [Gotchas](README.md) · Next: [A reporter with no name has a row of its own, and another once it has one](unnamed-reporter-gets-its-own-row.md)
<!-- nav:end -->
