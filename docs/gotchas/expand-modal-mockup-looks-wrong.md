---
title: "A mockup of the Expand modal looks nothing like the real one, or its layout breaks"
description: "Expand opens two different modals and invented class names can collide with fleet.css; copy the real component and search the stylesheets first."
group: "Project internals"
area: "Developing"
date: "2026-10-21"
status: "open"
order: 43
---

# A mockup of the Expand modal looks nothing like the real one, or its layout breaks

**You see:** A mockup of the Activity modal is rejected as unlike production, or a new piece of it lays out wrong
as soon as it links `fleet.css`.

**Why:** Expand opens two different modals. An agent's Expand opens the plain Activity modal
(`ActivityFeed.tsx`). The orchestrator's Expand opens the Respond modal (`Respond.tsx`): the title "Activity" with
the sub "name · orchestrator · model", the refresh select in the header, the feed, the status row, the feed's footer
note, then the message box (`Compose`). A mockup drawn from `ActivityFeed.tsx` alone is the wrong modal for an
orchestrator. Separately, a class name you invent can already exist in `fleet.css`. A new `.out` and `.cmd` in the
#431 mockup collided with Respond's own `.out` and `.cmd` and broke its layout.

**Do:** Copy the component the screen really opens: `Respond.tsx` for an orchestrator, `ActivityFeed.tsx` for an
agent. Before you use a class name in a mockup, search `fleet.css` and `admin.css` for it, and pick another name if
it is taken.

<!-- nav:start -->
---

Previous: [An Admin style does nothing, or looks like the fleet page's](admin-style-does-nothing-or-looks-like-the-fleet-page.md) · Up: [Gotchas](README.md) · Next: [npm run test:mod and npm run typecheck:mod fail on a clean machine](test-mod-and-typecheck-mod-fail-on-a-clean-machine.md)
<!-- nav:end -->
