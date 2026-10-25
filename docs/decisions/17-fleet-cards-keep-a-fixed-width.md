---
title: "17. Fleet cards keep a fixed width"
description: "The wall grid used fixed 360 px cards so collapsing a pane never shrank them, leaving empty space in a short last row. Replaced by 27."
group: "Project internals"
number: 17
date: "2026-10-12"
status: "superseded"
superseded_by: 27
order: 17
---

# 17. Fleet cards keep a fixed width

**Superseded by 27 (#145).**

**Decision.** The wall grid is `repeat(auto-fill, min(360px, 100%))`, left-aligned. A card is 360 px wide
(narrower only when the area is) and extra room adds columns.

**Why.** With `minmax(300px, 1fr)` a new column made every card narrower, so collapsing a pane, which widens
the main area, shrank the cards (#65). Collapsing the 340 px right pane did it most. A steady size is what
an always-on wall display (#33) wants. One rule covers both panes, the top bar and Wall mode, since they only
change the main area's width.

**Cost.** A last row that is not full leaves empty space on its right, and the cards no longer stretch to
fill a wide row.

<!-- nav:start -->
---

Previous: [16. The host passes its home directory to a containerized server](16-the-host-passes-its-home-directory.md) · Up: [Decisions](README.md) · Next: [18. A supported range of reporter versions, not a protocol number](18-a-supported-range-of-reporter-versions-not.md)
<!-- nav:end -->
