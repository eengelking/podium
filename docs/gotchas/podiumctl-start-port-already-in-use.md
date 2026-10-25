---
title: "podiumctl start fails with \"port N ... is already in use\""
description: "Something else listens on the port, often a leftover run; check with podiumctl status, stop it or pick another port with --port."
group: "Project internals"
area: "Running the server"
date: "2026-10-11"
status: "open"
order: 14
---

# `podiumctl start` fails with "port N ... is already in use"

**You see:** `podiumctl start` stops with `port N ... is already in use`.

**Why:** Something else already listens on the bind address and port. Often it is a leftover `podiumctl run` or
`npm run dev`, or a Podium started another way.

**Do:** Run `podiumctl status` to see whether it is Podium, and stop it if it is. Or choose another port with `--port`.

How `start` behaves:

- In standalone mode `start` checks before it spawns anything, so nothing is left running and no pid file is written.
- Container mode needs no check. `podman run` or `docker run` fails with `address already in use` and `start` exits
  non-zero (tested with Podman 6.1.2 and Docker 29.8.1).
- If the server exits right after `start` spawns it (a bind error, a bad setting), `start` says so, prints the tail of
  `~/.podium/podium.log` and removes the pid file, instead of reporting success.

<!-- nav:start -->
---

Previous: [The status line says "refused: session belongs to someone else"](refused-session-belongs-to-someone-else.md) · Up: [Gotchas](README.md) · Next: [I changed a setting and nothing happened](changed-a-setting-and-nothing-happened.md)
<!-- nav:end -->
