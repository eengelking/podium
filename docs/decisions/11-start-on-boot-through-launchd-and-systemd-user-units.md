---
title: "11. Start on boot through launchd and systemd user units"
description: "podiumctl enable writes a launchd agent or systemd user unit so the server starts on boot; container mode through a reboot is not yet tested."
group: "Project internals"
number: 11
date: "2026-10-11"
status: "accepted"
order: 11
---

# 11. Start on boot through launchd and systemd user units

**Decision.** `podiumctl enable` writes a launchd agent (macOS) or a systemd user unit (Linux).

- In container mode the unit runs `podiumctl start`.
- In standalone mode it runs `podiumctl run` in the foreground and restarts only after a non-zero exit.

**Why.** A container restart policy is not enough on macOS: Podman runs in a VM that is not up at login, and
`podiumctl start` also starts it. Restarting only on a failure keeps `podiumctl stop` from being undone by
the service.

**Cost.** What was tested and what was not:

- The Linux unit has run on Bazzite 44 (Fedora Atomic, systemd 259, Podman 5.8.7, SELinux enforcing) with
  Node from Homebrew, in both modes (2026-10-16, #268).
- Standalone: it started, `stop` was not undone, a killed server came back in about 4 seconds, and `disable`
  removed everything.
- Container: the same, except that `systemctl --user start` does nothing after `podiumctl stop`. The unit
  is `Type=oneshot` with `RemainAfterExit=yes` and so still counts as active. Use `podiumctl start`, or
  `systemctl --user stop` first.
- A container is not restarted when it dies. Only the unit's start at login or boot brings it up.
- Standalone, rebooted (2026-10-20, #268): with `loginctl enable-linger` the server was listening at boot
  before anyone logged in; without it, it started at login. Both runs were clean, with one start and no restarts.
- Not yet tested: container mode through a reboot.
- The unit names Homebrew's `opt/<formula>` link for `node` rather than the `Cellar/<formula>/<version>`
  directory that `brew upgrade` deletes.

<!-- nav:start -->
---

Previous: [10. The token is generated on first start, and secrets stay out of argv](10-the-token-is-generated-on-first-start-and-secrets.md) · Up: [Decisions](README.md) · Next: [12. The mod stays in this repo and is listed from the skills marketplace](12-the-mod-stays-in-this-repo-and-is-listed.md)
<!-- nav:end -->
