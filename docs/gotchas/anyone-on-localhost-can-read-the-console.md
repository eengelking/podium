---
title: "Anyone on localhost can read the console"
description: "Reads are open on localhost by design; keep the default bind unless you want others to see the console."
group: "Project internals"
area: "Running the server"
date: "2026-10-25"
status: "open"
order: 21
---

# Anyone on localhost can read the console

**You see:** The console opens with no sign-in.

**Why:** The token guards reports, hooks and deletes, and Admin has its own lock. Reads (`GET /api/fleet/*`) are open
on localhost by design (SPEC 7.7). With `--bind` or `HOST` set to anything but `127.0.0.1`, other machines can read it
too.

**Do:** Keep the default bind unless you want others to see the console. For several people on one server, see
[SERVER.md](../SERVER.md).

<!-- nav:start -->
---

Previous: [podman inspect podium shows the token](podman-inspect-shows-the-token.md) · Up: [Gotchas](README.md) · Next: [A name set with the shared secret, or with no token, shows no person](name-without-a-person-token-shows-no-person.md)
<!-- nav:end -->
