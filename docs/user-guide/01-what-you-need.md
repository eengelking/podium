---
title: "What you need"
description: "Check that your machine has the software Podium needs before you set it up."
group: "Getting started"
order: 1
---

# What you need

- Claude Code, to run the sessions you want to watch.
- Node 24 and npm, to get the server and `podiumctl`.
- Podman or Docker, if you want the server in a container (recommended). `podiumctl` uses Podman when both are installed;
  `--engine docker` picks Docker instead, and the choice is saved. Without either, `podiumctl` runs the server as a plain
  Node process.

<!-- nav:start -->
---

Up: [User guide](README.md) · Next: [Set it up](02-set-it-up.md)
<!-- nav:end -->
