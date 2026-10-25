---
title: "Rows that read \"Not since restart\" and never go away"
description: "A container's address changes on each restart and leaves an addr row behind; remove the rows in Admin or turn on Forget old reporters."
group: "Project internals"
area: "Reporters and machines"
date: "2026-10-15"
status: "open"
order: 11
---

# Rows that read "Not since restart" and never go away

**You see:** `addr:` rows in the **Not since restart** state that stay after the server has been running a while.

**Why:** A reporter with no name is matched by its sessions, so a container that comes back on a new address stays one
row when a session it already reported turns up from the new address. A reporter that has not reported such a session
gets a row of its own. A container's address changes on every restart, so each restart can leave an `addr:` row
behind. Nothing removes them but you.

**Do:** Use one of these. A reporter that reports again comes back.

- Tick the rows on Admin > Reporters and choose **Remove N…**, or choose **Remove all Not since restart**.
- Turn on **Forget old reporters** under Admin > Settings.

<!-- nav:start -->
---

Previous: [A reporter with no name has a row of its own, and another once it has one](unnamed-reporter-gets-its-own-row.md) · Up: [Gotchas](README.md) · Next: [I changed my reporter settings and a running session did not change who it reports as](running-session-keeps-its-old-identity.md)
<!-- nav:end -->
