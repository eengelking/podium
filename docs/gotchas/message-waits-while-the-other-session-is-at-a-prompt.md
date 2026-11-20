---
title: "A message does not arrive while the other session waits at a permission prompt"
description: "A message is held while the receiver has a permission prompt open, so answer the prompt and it is handed over at once."
group: "Project internals"
area: "Orchestrator messaging"
date: "2026-10-19"
status: "open"
order: 37
---

# A message does not arrive while the other session waits at a permission prompt

**You see:** `podium_send` answered "Waiting for … It is at a permission prompt, and gets the message once that is
answered", and the receiving session sits at a permission prompt.

**Why:** Podium holds a message while the receiver has a permission prompt open, because the message would answer the
prompt. Any other state, running or idle, gets it in the next report (SPEC 7.7, "Delivery").

**Do:** Answer the prompt. The message is handed over within seconds.

<!-- nav:start -->
---

Previous: [Two orchestrators on the same machine cannot message each other](two-orchestrators-on-one-machine-cannot-message.md) · Up: [Gotchas](README.md) · Next: [My reporters is missing after signing in with the admin secret](my-reporters-missing-after-admin-sign-in.md)
<!-- nav:end -->
