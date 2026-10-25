---
title: "Tooltips"
description: "How a note on a word or badge is built with the Tip component."
group: "Project internals"
order: 3
---

# Tooltips

File: `frontend/src/fleet/components/Tip.tsx`. Issue #275.

- A note on a word or badge is a `Tip`: a focusable `span.tip` holding a `role="tooltip"` child, which the trigger
  names with `aria-describedby`. A screen reader reads the text whether or not the box is open.
- React un-hides the box on mouse enter and on focus, and hides it on mouse leave (while the trigger is not
  focused), blur and Escape, so a test can drive it with `fireEvent`.
- A native `title` is not shown on keyboard focus, which is why `title` plus `tabIndex` is not used for these.
- The box is `position: fixed`, placed from the trigger's rectangle and kept inside the viewport, so the Reporters
  table's scroll container cannot clip it. It wraps and is at most 20 rem wide.
- Admin > Reporters (state, admin secret, "no name set") and the Kind row use it.

<!-- nav:start -->
---

Previous: [Admin page patterns](02-admin-page-patterns.md) · Up: [Components](README.md) · Next: [Fleet card](04-fleet-card.md)
<!-- nav:end -->
