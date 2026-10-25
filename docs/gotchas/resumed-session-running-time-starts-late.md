---
title: "A resumed session's running time starts when Podium first saw it"
description: "Podium keeps a reported start time only if it is within 2 minutes of first hearing of the session; this is how the start is kept."
group: "Project internals"
area: "What the console shows"
date: "2026-10-11"
status: "open"
order: 31
---

# A resumed session's running time starts when Podium first saw it

**You see:** A session you resumed shows a running time that is shorter than its real age.

**Why:** Podium keeps the start time a session reports only if it is within 2 minutes of the moment the server first
heard of it. If the mod reports an earlier start (a resumed session, or one already running when you installed the
mod), the card counts from the first report instead. The engine's start time is not always the session's own: under
Claude Code's background daemon, sessions that began minutes apart reported the same one. Once stored, a session's
start never changes.

**Do:** Nothing. This is how the start time is kept.

<!-- nav:start -->
---

Previous: [The console's GPU use goes up after adding an animation](gpu-use-goes-up-after-adding-an-animation.md) · Up: [Gotchas](README.md) · Next: [A session sitting at the prompt shows as waiting](idle-session-shows-as-waiting.md)
<!-- nav:end -->
