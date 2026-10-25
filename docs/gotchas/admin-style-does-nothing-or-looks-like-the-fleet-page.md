---
title: "An Admin style does nothing, or looks like the fleet page's"
description: "fleet.css styles bare class names with higher specificity than admin.css; search it before adding a class and prefix any that collide."
group: "Project internals"
area: "Developing"
date: "2026-10-14"
status: "open"
order: 42
---

# An Admin style does nothing, or looks like the fleet page's

**You see:** A CSS rule in `admin.css` has no effect, or the element takes on the fleet page's look.

**Why:** Admin's CSS is scoped under `.adminv`, but `fleet.css` styles bare class names under `.podium` (`.sec`,
`.main`, `.code`, `.back`, `.field`, `.btn` and more) with higher specificity, so a class of the same name in Admin
picks up its rules.

**Do:** Before you add a class to `admin.css`, search `fleet.css` for it. Prefix a layout class that collides (Admin
uses `asec` and `apage` for this reason).

<!-- nav:start -->
---

Previous: [After /clear the recording is on a different session](recording-moves-to-a-new-session-after-clear.md) · Up: [Gotchas](README.md) · Next: [A mockup of the Expand modal looks nothing like the real one, or its layout breaks](expand-modal-mockup-looks-wrong.md)
<!-- nav:end -->
