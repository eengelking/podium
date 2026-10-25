---
title: "A group change shows a few seconds late"
description: "Groups are read when a session's view is built, so the wall changes with the next report; wait a few seconds."
group: "Project internals"
area: "Running the server"
date: "2026-10-12"
status: "open"
order: 23
---

# A group change shows a few seconds late

**You see:** You moved someone to another group in Admin, and the wall has not changed yet.

**Why:** Admin's groups are read when a session's view is built, so the change shows on the wall with each session's next
report (the heartbeat is five seconds), not at once. The Spend page in Admin updates on the next tick.

**Do:** Wait a few seconds.

<!-- nav:start -->
---

Previous: [A name set with the shared secret, or with no token, shows no person](name-without-a-person-token-shows-no-person.md) · Up: [Gotchas](README.md) · Next: [systemctl --user start podium.service does nothing after podiumctl stop (container mode)](systemctl-start-does-nothing-after-podiumctl-stop.md)
<!-- nav:end -->
