---
title: "I changed a setting and nothing happened"
description: "podiumctl config set only edits config.env; run podiumctl restart to apply it."
group: "Project internals"
area: "Running the server"
date: "2026-10-11"
status: "open"
order: 15
---

# I changed a setting and nothing happened

**You see:** You ran `podiumctl config set ...` and the server behaves as before.

**Why:** `podiumctl config set` only edits `~/.podium/config.env`.

**Do:** Run `podiumctl restart`. The `--mode`, `--engine`, `--port` and `--bind` flags are saved by `start`, `restart`, `build` and
`enable`.

<!-- nav:start -->
---

Previous: [A refused client certificate shows as "socket hang up", not a TLS alert](refused-client-certificate-looks-like-a-reset.md) · Up: [Gotchas](README.md) · Next: [On macOS the first podiumctl start takes a while](first-start-on-macos-takes-a-while.md)
<!-- nav:end -->
