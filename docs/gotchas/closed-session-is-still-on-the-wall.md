---
title: "A session I closed is still on the wall"
description: "Closing the window can move the conversation to the background; end it with claude stop and the card leaves."
group: "Project internals"
area: "What the console shows"
date: "2026-10-11"
status: "open"
order: 34
---

# A session I closed is still on the wall

**You see:** You closed the window and the card is still there.

**Why:** Closing the window can move the conversation to the background instead of ending it. It is a real session, so
its card stays.

**Do:** `claude agents` lists background sessions, and `claude attach <id|name>` opens one. End it with
`claude stop <id>`, and the card leaves. `claude rm <id>` also deletes the session's worktree. Use the id `claude agents`
shows, not the id on the card, which differs after `/clear`. The user guide has the full steps in
[Closing a background session](../user-guide/04-reading-the-console/09-closing-a-background-session.md).

<!-- nav:start -->
---

Previous: [A new session is not on the wall until I send a prompt](new-session-not-on-the-wall-until-a-prompt.md) · Up: [Gotchas](README.md) · Next: [A session started without the mod stays "live" for ten minutes after it goes quiet](hook-only-session-stays-live-for-ten-minutes.md)
<!-- nav:end -->
