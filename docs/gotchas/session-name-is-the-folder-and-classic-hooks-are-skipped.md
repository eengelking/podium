---
title: "My session's name is the folder, and background tasks, notifications and permission answers are missing"
description: "On a Team or Enterprise login Claude Code skips the mod's classic hooks; the name now comes from claude agents, the rest still does not report."
group: "Project internals"
area: "Connecting the mod"
date: "2026-10-27"
status: "open"
order: 56
---

# My session's name is the folder, and background tasks, notifications and permission answers are missing

**You see:** Every session in one folder shows the folder's name on its card, although Claude Code or the desktop app
titles it. After each turn the transcript says `podium-reporter: its classic.Stop hook was skipped.
"cc-plugin-sec-default" runs first and sent the event on past it.` Background tasks and crons are missing from the
session, and a permission prompt cannot be answered from Podium.

**Why:** Under a Team or Enterprise `/login`, or on a machine with managed settings, Claude Code loads its guard
`cc-plugin-sec-default` ahead of every user-installed mod, and the guard passes `classic.*` events on to the
organization's settings hooks without running the mod's. The reporter's `classic.SessionStart` and
`classic.UserPromptSubmit` hooks never run, so the `session_title` never arrives, and neither do `classic.Stop`,
`classic.Notification` and `classic.PermissionRequest`.

**Do:** Update the mod to the release with the fix for #595. It reads the session's title from `claude agents --json`
instead ([SPEC 6.6](../spec/06-reporter-protocol/06-06-session-display-name.md)), so the name is right again. Background
tasks, crons, notification signals and answering permission prompts have no such fallback yet and wait on the
organization allowing the mod's `classic.*` hooks; set the name by hand with `/podium name <text>` in the meantime.

<!-- nav:start -->
---

Previous: [npm run test:mod fails with 'Permission to use AskUserQuestion has been denied'](test-mod-fails-where-the-engine-denies-an-ask.md) · Up: [Gotchas](README.md)
<!-- nav:end -->
