---
title: "16. The host passes its home directory to a containerized server"
description: "podiumctl passes PODIUM_HOST_HOME so a containerized server shortens the host's home to ~, at the cost of one more variable to set by hand."
group: "Project internals"
number: 16
date: "2026-10-11"
status: "accepted"
order: 16
---

# 16. The host passes its home directory to a containerized server

**Decision.** `podiumctl` sets `PODIUM_HOST_HOME` to the host's home directory when it starts the container,
and `configFromEnv` uses it in place of the server's own `os.homedir()` when it is an absolute path.
Standalone mode and `npm run dev` do not set it and behave as before. The name avoids `PODIUMCTL_HOME`,
which is where `podiumctl` keeps its own files.

**Why.** In a container the server runs as `node`, so its home is `/home/node` and a session's
`/Users/<name>/...` never shortened to `~/...` (#20). Nothing in the report carries the reporter's home. The
other options were worse:

- Having the mod report its home changes the report format and SPEC 6.2 for a display detail.
- Guessing `/Users/<name>` or `/home/<name>` can show a wrong `~`.

The value is not a secret and needs no change on the wire.

**Cost.** One more variable for `podiumctl` to set. A server started in a container by hand, without
`podiumctl`, must set it itself or paths stay long.

<!-- nav:start -->
---

Previous: [15. The usage dashboard is removed](15-the-usage-dashboard-is-removed.md) · Up: [Decisions](README.md) · Next: [17. Fleet cards keep a fixed width](17-fleet-cards-keep-a-fixed-width.md)
<!-- nav:end -->
