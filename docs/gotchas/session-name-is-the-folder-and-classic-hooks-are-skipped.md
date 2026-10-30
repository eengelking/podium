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
instead ([SPEC 6.6](../spec/06-reporter-protocol/06-06-session-display-name.md)), so the name is right again. The other
three hooks:

- `classic.Stop` (#740): no fix exists. It is the only place Claude Code lists a session's background tasks and
  crons. `$.agent.list()` covers agents only, `claude agents --json` has no task list, and mirroring `tool.call`
  for `run_in_background`, `Monitor` and `CronCreate` gives launches but never completions. The card shows no
  background work, and a session idle on it reads as waiting for you. Background subagents still show as agent cards.
- `classic.Notification` (#741): a permission prompt still puts the session on the wall as waiting. The reporter
  reads it from `tool.check` resolving `ask` when no `PermissionRequest` follows within 2 seconds, with responding on
  or off, and drops the wait if the call ends first. Idle needs nothing, since `turn.complete` marks the session
  idle. Other notification types (`auth_success`, `elicitation_dialog`) have no other source, and the reporter never
  used them.
- `classic.PermissionRequest` (#742): the prompt reaches the card from `tool.check`, and the console says the session
  cannot be answered from Podium as soon as a turn ends with no classic hook having run, not only after the first
  prompt. The engine does not let a `tool.check` hook answer for the person, so answer a permission prompt in the
  terminal. Plan feedback and questions still work. Plan approval needs the hook.

Set the name by hand with `/podium name <text>` in the meantime if the app's title does not come through.

<!-- nav:start -->
---

Previous: [npm run test:mod fails with 'Permission to use AskUserQuestion has been denied'](test-mod-fails-where-the-engine-denies-an-ask.md) · Up: [Gotchas](README.md) · Next: [The Activity section says to turn on activityFeed, but the option is on](activity-feed-says-turn-on-the-option-but-it-is-on.md)
<!-- nav:end -->
