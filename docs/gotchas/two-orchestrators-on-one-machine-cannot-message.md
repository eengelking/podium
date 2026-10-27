---
title: "Two orchestrators on the same machine cannot message each other"
description: "Sessions on one machine share a reporter that has no right to itself; set the diagonal cell on My reporters or trust your own reporters."
group: "Project internals"
area: "Orchestrator messaging"
date: "2026-10-19"
status: "open"
order: 36
---

# Two orchestrators on the same machine cannot message each other

**You see:** `podium_peers` does not list the other orchestrators on this machine, and says nothing about them under
`Not listed:` either. `podium_send` to one of them says "You cannot see an orchestrator called …".

**Why:** Rights belong to reporters, and a reporter is one machine plus one person's token. Two sessions on one
machine share a reporter, so they need that reporter's right to itself, which no one has given yet.

**Do:** On My reporters, set the cell on the Grid's diagonal for that machine, or turn on **Trust my own reporters**.

<!-- nav:start -->
---

Previous: [A session in the Claude desktop app stays on the wall until I delete it](desktop-session-stays-on-the-wall-until-deleted.md) · Up: [Gotchas](README.md) · Next: [A message does not arrive while the other session waits at a permission prompt](message-waits-while-the-other-session-is-at-a-prompt.md)
<!-- nav:end -->
