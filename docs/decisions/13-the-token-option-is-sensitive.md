---
title: "13. The token option is sensitive"
description: "The mod's token option is marked sensitive so Claude Code hides it, at the cost of no row in the /config menu."
group: "Project internals"
number: 13
date: "2026-10-11"
status: "accepted"
order: 13
---

# 13. The `token` option is sensitive

**Decision.** The mod's `token` option is marked `sensitive`.

**Why.** It is a credential, so Claude Code keeps it out of the plain settings display.

**Cost.** A sensitive option has no row in the `/config` menu. Set it with
`/plugin configure podium-reporter@eengelking-marketplace`. (Found when testing, 2026-10-11.)

<!-- nav:start -->
---

Previous: [12. The mod stays in this repo and is listed from the skills marketplace](12-the-mod-stays-in-this-repo-and-is-listed.md) · Up: [Decisions](README.md) · Next: [14. The project is named Podium, in one repo](14-the-project-is-named-podium-in-one-repo.md)
<!-- nav:end -->
