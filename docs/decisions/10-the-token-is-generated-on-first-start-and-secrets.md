---
title: "10. The token is generated on first start, and secrets stay out of argv"
description: "podiumctl generates a random token on first start, saves it at mode 0600 and keeps secrets out of argv, though docker inspect still shows it."
group: "Project internals"
number: 10
date: "2026-10-11"
status: "accepted"
order: 10
---

# 10. The token is generated on first start, and secrets stay out of argv

**Decision.** The first `podiumctl start` generates a random `PODIUM_TOKEN` and saves it to
`~/.podium/config.env` (mode 0600). `podiumctl token` shows it. An empty token is the deliberate "auth off"
setting. Secrets reach the server through the process environment (`podman run -e NAME` with no value),
never the command line.

**Why.** This follows how RKE2 handles its join token: generated once, saved in a known place, and easy to
find again. The maintainer likes that approach. A secret on a command line is visible in the process list.

**Cost.** The token is still part of the container's environment, so `podman inspect podium` shows it. See
`docs/gotchas/`.

<!-- nav:start -->
---

Previous: [9. podiumctl has two modes and no dependencies](09-podiumctl-has-two-modes-and-no-dependencies.md) · Up: [Decisions](README.md) · Next: [11. Start on boot through launchd and systemd user units](11-start-on-boot-through-launchd-and-systemd-user-units.md)
<!-- nav:end -->
