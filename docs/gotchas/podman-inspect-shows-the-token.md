---
title: "podman inspect podium shows the token"
description: "The token is part of the container's environment and inspect prints it; treat the account that runs the engine as trusted."
group: "Project internals"
area: "Running the server"
date: "2026-10-11"
status: "open"
order: 20
---

# `podman inspect podium` shows the token

**You see:** `podman inspect podium` (or `docker inspect podium`) prints the token.

**Why:** `podiumctl` keeps the token out of the command line, but it is part of the container's environment, and
`inspect` prints that. Anyone who can run Podman or Docker as you can read it.

**Do:** Treat the account that runs the container engine as trusted. See `.github/SECURITY.md`.

<!-- nav:start -->
---

Previous: [A restart shows every session as stale](restart-shows-every-session-as-stale.md) · Up: [Gotchas](README.md) · Next: [Anyone on localhost can read the console](anyone-on-localhost-can-read-the-console.md)
<!-- nav:end -->
