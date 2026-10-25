---
title: "What the reader sees, in their words"
description: "One sentence, under 160 characters, that says the symptom and the fix."
group: Project internals
date: 2026-01-01
status: open
area: console
---

# What the reader sees, in their words

`status` is one of `open` (it still happens), `fixed` (it was fixed in a release, and `fixed_in: <version>` says
which) or `wontfix`. `area` is the part it belongs to, so the index can group entries: `console`, `server`, `reporter`,
`admin`, `docs`.

**You see:** What shows up on screen or in a terminal, with the exact text of any message.

**Why:** The cause, so the reader can tell whether it applies to them.

**Do:** What to do about it, as a command or a short numbered list.
