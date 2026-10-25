---
title: "A message does not arrive while the other session waits at a permission prompt"
description: "A message is handed over only when the receiver is idle, so answer the permission prompt and it arrives after that turn."
group: "Project internals"
area: "Orchestrator messaging"
date: "2026-10-19"
status: "open"
order: 37
---

# A message does not arrive while the other session waits at a permission prompt

**You see:** `podium_send` answered "Waiting for … It is working, and gets the message when its turn ends", and the
receiving session sits at a permission prompt.

**Why:** Podium hands a message over only when the receiver reports itself idle. A session at a permission prompt is
waiting on its person, not idle, so the message waits with it (SPEC 7.7, "Delivery").

**Do:** Answer the prompt. The message arrives once that turn ends.

<!-- nav:start -->
---

Previous: [Two orchestrators on the same machine cannot message each other](two-orchestrators-on-one-machine-cannot-message.md) · Up: [Gotchas](README.md) · Next: [My reporters is missing after signing in with the admin secret](my-reporters-missing-after-admin-sign-in.md)
<!-- nav:end -->
