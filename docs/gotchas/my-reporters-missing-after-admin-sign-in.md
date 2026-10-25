---
title: "My reporters is missing after signing in with the admin secret"
description: "The admin secret belongs to no one and has no reporters; sign in with your own name and token."
group: "Project internals"
area: "Orchestrator messaging"
date: "2026-10-19"
status: "open"
order: 38
---

# My reporters is missing after signing in with the admin secret

**You see:** You signed in with the name `Admin` and the admin secret, and the top bar has no **My reporters**.

**Why:** Messaging is only between one person's own reporters, and the admin secret belongs to no one, so it has no
reporters to show and cannot take part.

**Do:** Sign in with your own name and token, the ones your reporters use.

<!-- nav:start -->
---

Previous: [A message does not arrive while the other session waits at a permission prompt](message-waits-while-the-other-session-is-at-a-prompt.md) · Up: [Gotchas](README.md) · Next: [Record says "This session's reporter does not allow recording"](record-says-the-reporter-does-not-allow-recording.md)
<!-- nav:end -->
