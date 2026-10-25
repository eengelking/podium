---
title: "1. Podium only observes"
description: "Podium only watched: no prompts, stops or approvals, which kept trust simple but meant acting on anything meant going to the terminal. Replaced by 28."
group: "Project internals"
number: 1
date: "2026-10-11"
status: "superseded"
superseded_by: 28
order: 1
---

# 1. Podium only observes

**Superseded** by 28: Podium can now answer a session that waits on its person.

**Decision.** No control surface. Podium never sends a prompt, stops an agent, approves a permission or edits
a session. At most the UI copies a resume or fork command to the clipboard, for the person to run.

**Why.** It keeps the trust model simple: the mod can only report, and the server can only store and show. A
dashboard that could steer sessions would need much stronger authentication and would be a much more
attractive target. It is the first "Non-goal" in `docs/spec/`.

**Cost.** Nothing in the UI can act on what it shows. You switch to the terminal for that.

<!-- nav:start -->
---

Up: [Decisions](README.md) · Next: [2. A Claude Code mod reports from inside the session](02-a-claude-code-mod-reports-from-inside-the-session.md)
<!-- nav:end -->
