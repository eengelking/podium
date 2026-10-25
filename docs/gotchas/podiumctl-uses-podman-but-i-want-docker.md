---
title: "podiumctl uses Podman, but I want Docker (or the other way round)"
description: "Container mode prefers Podman and remembers the first engine; remove the container and start again with --engine."
group: "Project internals"
area: "Running the server"
date: "2026-10-20"
status: "open"
order: 17
---

# `podiumctl` uses Podman, but I want Docker (or the other way round)

**You see:** Both are installed, and the container runs under the one you did not want.

**Why:** Container mode prefers Podman when it is installed. The engine that first ran `build`, `start`, `restart` or
`enable` is saved as `PODIUMCTL_ENGINE`, so later commands keep using it.

**Do:** `podiumctl rm`, then `podiumctl start --engine docker` (or `podman`). The data volume belongs to one engine, so
the other one starts with an empty database.

<!-- nav:start -->
---

Previous: [On macOS the first podiumctl start takes a while](first-start-on-macos-takes-a-while.md) · Up: [Gotchas](README.md) · Next: [podiumctl disable stopped my standalone server](podiumctl-disable-stopped-my-server.md)
<!-- nav:end -->
