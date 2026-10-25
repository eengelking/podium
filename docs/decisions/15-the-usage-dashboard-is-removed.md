---
title: "15. The usage dashboard is removed"
description: "The usage dashboard, its routes, recharts and the admin API key setting were removed, a breaking change for anyone who used the page."
group: "Project internals"
number: 15
date: "2026-10-11"
status: "accepted"
order: 15
---

# 15. The usage dashboard is removed

**Decision.** The earlier usage dashboard is gone. Removed:

- the "Usage dashboard" link and the `#/usage` page
- the `/api/claude-code` and `/api/api-usage` routes, and the modules only they used
- `recharts`
- the `ANTHROPIC_ADMIN_API_KEY` setting

A `#/usage` link now lands on the fleet console. `podiumctl` ignores a leftover `ANTHROPIC_ADMIN_API_KEY` in
an existing config and lets `config unset` clear it.

**Why.** The maintainer moved away from it. Checking the empty-in-container case (#16) showed the page had
little value, and fixing it would have meant mounting transcripts into the container only to feed it. It
shared the repo and the server but none of the fleet console's code. This overrides the "stays reachable at
`#/usage`" statements in SPEC and entry 14.

**Cost.** A breaking change for anyone who used the page (pre-1.0). Cross-session cost history, if wanted,
would be a new feature in the fleet console built from what the mod reports.

<!-- nav:start -->
---

Previous: [14. The project is named Podium, in one repo](14-the-project-is-named-podium-in-one-repo.md) · Up: [Decisions](README.md) · Next: [16. The host passes its home directory to a containerized server](16-the-host-passes-its-home-directory.md)
<!-- nav:end -->
