---
title: "A session in the Claude desktop app stays on the wall until I delete it"
description: "The desktop app keeps every sidebar session open, so each card stays until you delete the session from the sidebar."
group: "Project internals"
area: "What the console shows"
date: "2026-10-27"
status: "open"
order: 36
---

# A session in the Claude desktop app stays on the wall until I delete it

**You see:** Cards for sessions you started in the Claude desktop app stay on the wall when you switch to another
session, and they stay after you close their view. They never get the "nobody attached" chip.

**Why:** The desktop app keeps every session in its sidebar open, but it attaches a window only to the session on
screen. A terminal session with no window on it is a background session, and the wall hides it after a minute. A
desktop session is not that, so the mod counts it as attached once the desktop app has been on it, and it stays that way
until the session ends. Switching away and closing the view do not end it. Deleting the session from the sidebar does.

**Do:** Delete the session from the app's sidebar, and its card leaves the wall. Quitting the desktop app also clears
them: the sessions stop reporting, so each card shows as stale after 15 seconds and leaves the wall about a minute later
as "heartbeat lost" (the timers are in [SPEC 7.5](../spec/07-server/07-05-lifecycle-timers.md)). This needs a mod with the fix for #594.
Older mods read every desktop session you are not looking at as "nobody attached" and hide it after a minute. For a
terminal session that is still on the wall, see
[A session I closed is still on the wall](closed-session-is-still-on-the-wall.md).

<!-- nav:start -->
---

Previous: [A session started without the mod stays "live" for ten minutes after it goes quiet](hook-only-session-stays-live-for-ten-minutes.md) · Up: [Gotchas](README.md) · Next: [Two orchestrators on the same machine cannot message each other](two-orchestrators-on-one-machine-cannot-message.md)
<!-- nav:end -->
