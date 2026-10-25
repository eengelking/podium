---
title: "podiumctl disable stopped my standalone server"
description: "Removing the launchd or systemd service stops the standalone server it ran; start it again with podiumctl start."
group: "Project internals"
area: "Running the server"
date: "2026-10-11"
status: "open"
order: 18
---

# `podiumctl disable` stopped my standalone server

**You see:** After `podiumctl disable`, a standalone server is no longer running.

**Why:** Under the launchd or systemd service the server is the service's child, so removing the service stops it. In
container mode the container keeps running.

**Do:** Check with `podiumctl status`, then `podiumctl start` if you want it back.

<!-- nav:start -->
---

Previous: [podiumctl uses Podman, but I want Docker (or the other way round)](podiumctl-uses-podman-but-i-want-docker.md) · Up: [Gotchas](README.md) · Next: [A restart shows every session as stale](restart-shows-every-session-as-stale.md)
<!-- nav:end -->
