---
title: "On macOS the first podiumctl start takes a while"
description: "Podman starts its VM and builds the image on the first start; wait, and later starts are quick."
group: "Project internals"
area: "Running the server"
date: "2026-10-11"
status: "open"
order: 16
---

# On macOS the first `podiumctl start` takes a while

**You see:** The first start pauses for a while.

**Why:** Podman runs in a VM. If it is not running, `podiumctl` starts it, and the first start also builds the image
(about 20 seconds on a warm cache).

**Do:** Wait. Later starts are quick. Docker Desktop is not started for you: if it is not running, `podiumctl` says so
and stops. Start it, then run the command again.

<!-- nav:start -->
---

Previous: [I changed a setting and nothing happened](changed-a-setting-and-nothing-happened.md) · Up: [Gotchas](README.md) · Next: [podiumctl uses Podman, but I want Docker (or the other way round)](podiumctl-uses-podman-but-i-want-docker.md)
<!-- nav:end -->
