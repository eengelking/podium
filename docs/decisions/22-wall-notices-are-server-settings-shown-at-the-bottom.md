---
title: "22. Wall notices are server settings, shown at the bottom, with one switch each in Admin"
description: "Wall notices sit at the bottom with an X and one Admin switch each, kept as server settings, so anyone who reaches the dashboard can close one for everyone."
group: "Project internals"
number: 22
date: "2026-10-13"
status: "accepted"
order: 22
---

# 22. Wall notices are server settings, shown at the bottom, with one switch each in Admin

**Decision.** Informational notes about the wall (today, the background-sessions note) sit in one stack at
the bottom of the wall.

- Each has an X. Closing one turns it off for every browser and tells the user where to turn it back on,
  Admin > Settings, which has one switch per notice.
- The switches, and whether background sessions are shown, are rows in the `settings` table. They are sent in
  the state body and pushed to open tabs as a `wall` stream event.
- Closing a notice and the Show them / Hide them link are open routes like Remove, not Admin calls.

**Why.**

- A note above the cards pushes the work down, and a note that cannot be closed gets in the way every time.
- The wall has no Admin session, so what it shows has to come in the state it already receives.
- One setting per server matches how the rest of Admin works, and keeps "show background sessions" from
  resetting on every reload, as the old per-tab state did.

**Cost.**

- Anyone who can reach the dashboard can close a notice or show background sessions for everyone, the same
  trust Remove already has.
- A notice closed by mistake is easy to restore but affects every viewer until it is.
- The list of notices lives in two places, the server's `NOTICES` and the wall's stack, so a new notice
  touches both.

<!-- nav:start -->
---

Previous: [21. People are shown from the token's owner, grouped in the browser, and machines carry a random id](21-people-are-shown-from-the-tokens-owner-grouped.md) · Up: [Decisions](README.md) · Next: [23. The server prices tokens, with prices the Admin can change](23-the-server-prices-tokens-with-prices-the-admin.md)
<!-- nav:end -->
