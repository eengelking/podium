---
title: "A session started without the mod stays \"live\" for ten minutes after it goes quiet"
description: "Settings hooks send no heartbeat, so a hook-only session goes stale after 10 minutes; install the mod for faster detection."
group: "Project internals"
area: "What the console shows"
date: "2026-10-11"
status: "open"
order: 35
---

# A session started without the mod stays "live" for ten minutes after it goes quiet

**You see:** A hook-only session still looks live well after it stopped.

**Why:** Settings hooks send no heartbeat, so a hook-only session gets `HOOK_STALE_AFTER_MS` (10 minutes) before it
shows as stale. A session the mod reports uses the 15-second default.

**Do:** Install the mod for faster stale detection.

<!-- nav:start -->
---

Previous: [A session I closed is still on the wall](closed-session-is-still-on-the-wall.md) · Up: [Gotchas](README.md) · Next: [A session in the Claude desktop app stays on the wall until I delete it](desktop-session-stays-on-the-wall-until-deleted.md)
<!-- nav:end -->
