---
title: "A new session is not on the wall until I send a prompt"
description: "Podium keeps a session off the wall until it has done something; send a prompt and the card appears."
group: "Project internals"
area: "What the console shows"
date: "2026-10-11"
status: "open"
order: 33
---

# A new session is not on the wall until I send a prompt

**You see:** A freshly opened session has no card, and its status line reads `podium ● 0 live`.

**Why:** Podium keeps a session off the wall until it has done something (it is running, or has tokens, cost, context
use, a blowout, an agent or a plan). Claude Code's background daemon runs a parked twin of each interactive window and
a pool of spares, and each of them reports as a session. Without this rule one window showed three identical cards. The
number in the status line is the cards on the wall, not the Claude Code processes. A session known only from settings
hooks is never hidden.

**Do:** Send a prompt. The count becomes `1` or more. The rule is SPEC 7.5, and the user guide explains it in
[Sessions that have not done anything yet](../user-guide/04-reading-the-console/08-sessions-that-have-not-done-anything-yet.md).

<!-- nav:start -->
---

Previous: [A session sitting at the prompt shows as waiting](idle-session-shows-as-waiting.md) · Up: [Gotchas](README.md) · Next: [A session I closed is still on the wall](closed-session-is-still-on-the-wall.md)
<!-- nav:end -->
