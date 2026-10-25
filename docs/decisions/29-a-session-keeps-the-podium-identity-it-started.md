---
title: "29. A session keeps the Podium identity it started with"
description: "A session takes its Podium name and token once at session.start and keeps them, so a second identity on one machine cannot hijack running sessions."
group: "Project internals"
number: 29
date: "2026-10-15"
status: "accepted"
order: 29
---

# 29. A session keeps the Podium identity it started with

**Context.** The reporter's `userName` and `token` options are one set per Claude config directory, and
Claude Code reloads every running session's module when an option changes. Signing in as a second Podium
identity on the same machine therefore switched the first terminal's running sessions to the new token, and
the server refused them (409, a session stored under Admin reported with a person's token). The refusal was
right. The switch was the defect (#226).

**Decision.** The mod takes its name and token once, at `session.start`, and holds them in `$.state`, which
survives a reload. At that first start it prefers the terminal's `PODIUM_USER` and `PODIUM_TOKEN` over the
shared options.

**Alternatives.**

- Reading the options live (the old behavior).
- Holding the pair in `$.store`, which would write a token to disk.
- A project-scoped setting, which Claude Code does not offer for plugin options.
- Letting the server accept a session from a second owner, which would undo #209.

**Cost.** A running session cannot pick up a corrected token or name. Fixing a wrong token means starting a
new session, where before a reload was enough. Two identities on one machine need the environment variables,
not the settings screen.

<!-- nav:start -->
---

Previous: [28. Podium can answer a waiting session, through the reporter, not through a terminal](28-podium-can-answer-a-waiting-session-through.md) · Up: [Decisions](README.md) · Next: [30. Admin opens from the console's sign-in, with a name and a token](30-admin-opens-from-the-consoles-sign-in-with-a-name.md)
<!-- nav:end -->
