---
title: "A reporter with no name has a row of its own, and another once it has one"
description: "A reporter without a name is keyed by address, so naming it adds a second row; set userName and a token everywhere, then remove the old row."
group: "Project internals"
area: "Reporters and machines"
date: "2026-10-15"
status: "open"
order: 10
---

# A reporter with no name has a row of its own, and another once it has one

**You see:** The same machine appears as an `addr:...` row, and again as a named row after you set a name.

**Why:** The mod sends a machine id only when the `userName` option is set. A reporter without a name is keyed by its
source address (`addr:...`). When the same machine later reports with a name, it becomes a second row.

**Do:**

1. Set `userName` and the person's token on every reporter. See
   [A name set with the shared secret, or with no token, shows no person](name-without-a-person-token-shows-no-person.md).
2. Remove the old `addr:` row from Admin when you no longer need it.

<!-- nav:start -->
---

Previous: [One machine shows an extra row ending in # and a name](extra-machine-row-ending-in-hash-and-name.md) · Up: [Gotchas](README.md) · Next: [Rows that read "Not since restart" and never go away](not-since-restart-rows-never-go-away.md)
<!-- nav:end -->
