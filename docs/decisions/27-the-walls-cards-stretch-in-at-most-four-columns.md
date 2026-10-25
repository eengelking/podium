---
title: "27. The wall's cards stretch, in at most four columns"
description: "The wall counts its own columns, at most four, and stretches 360 px minimum cards to fill the row, so card size is no longer steady. Replaces 17."
group: "Project internals"
number: 27
date: "2026-10-14"
status: "accepted"
order: 27
---

# 27. The wall's cards stretch, in at most four columns

**Decision.** The fleet wall counts columns instead of letting the browser fill them (`wallLayout.ts`,
`useWallColumns`, #145). This replaces 17, and applies to the fleet wall only.

- A card is never narrower than 360 px.
- The wall uses as many 360 px columns, 12 px apart, as its own measured width holds, at most four and never
  more than there are cards. The cards stretch to fill the row.
- A lone card is half the wall when two columns fit.
- Later rows keep the same column width, so a short last row is left-aligned.
- Bands in the People and Group views share one set of columns, from the total number of cards shown.
- A `ResizeObserver` on the wall keeps the count current.

**Why.**

- The maintainer asked for a wall that fills the screen with a steady, predictable shape: one wide card,
  then two, three or four across, never more.
- The 360 px minimum keeps today's card size as the floor.
- Measuring the wall itself, not the window, accounts for the panes, which can be dragged to any width.
- Taking the columns from the total, not each band's cards, keeps cards in different bands the same width,
  so the page does not look ragged.

**Cost.** A card is no longer a steady size: opening or closing a pane, or dragging one, changes the columns
and can resize every card, which is what 17 avoided (#65). The count needs JavaScript and a measurement, so
before the first measure the wall falls back to the old fixed 360 px cards.

<!-- nav:start -->
---

Previous: [26. The server logs events, and can push them to a central platform](26-the-server-logs-events-and-can-push-them.md) · Up: [Decisions](README.md) · Next: [28. Podium can answer a waiting session, through the reporter, not through a terminal](28-podium-can-answer-a-waiting-session-through.md)
<!-- nav:end -->
