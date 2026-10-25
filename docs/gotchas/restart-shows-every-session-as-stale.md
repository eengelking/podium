---
title: "A restart shows every session as stale"
description: "Sessions come back from SQLite as stale and recover when their reporters next send, within about five seconds."
group: "Project internals"
area: "Running the server"
date: "2026-10-11"
status: "open"
order: 19
---

# A restart shows every session as stale

**You see:** After a server restart, every card is stale.

**Why:** Sessions come back from SQLite as stale and recover when their reporters next send, within about five seconds.
A session whose reporter never comes back is dropped about a minute after the server's own start.

**Do:** Wait a few seconds. A card counts down to the time it will be dropped, and **Remove** clears it sooner.

<!-- nav:start -->
---

Previous: [podiumctl disable stopped my standalone server](podiumctl-disable-stopped-my-server.md) · Up: [Gotchas](README.md) · Next: [podman inspect podium shows the token](podman-inspect-shows-the-token.md)
<!-- nav:end -->
