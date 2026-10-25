---
title: "systemctl --user start podium.service does nothing after podiumctl stop (container mode)"
description: "The container unit stays active after podiumctl stop; use podiumctl start, or stop the unit and then start it."
group: "Project internals"
area: "Running the server"
date: "2026-10-16"
status: "open"
order: 24
---

# `systemctl --user start podium.service` does nothing after `podiumctl stop` (container mode)

**You see:** After `podiumctl stop`, a plain `systemctl --user start podium.service` has no effect.

**Why:** In container mode the unit is `Type=oneshot` with `RemainAfterExit=yes`. `podiumctl stop` stops the container
but systemd still counts the unit as active, so a plain `start` is a no-op. A container that dies is not restarted by
the unit. Standalone mode restarts a crashed server after 3 seconds.

**Do:** Use `podiumctl start`. Or run `systemctl --user stop podium.service` and then `start`.

<!-- nav:start -->
---

Previous: [A group change shows a few seconds late](group-change-shows-a-few-seconds-late.md) · Up: [Gotchas](README.md) · Next: [A session shows no plan](session-shows-no-plan.md)
<!-- nav:end -->
