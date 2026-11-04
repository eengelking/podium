---
title: "59. An OpenCode session stays open, and reachable, while a TUI is attached (#984)"
description: "Idle still ends an OpenCode session after idleSeconds, except while its TUI part is attached, so a quiet open session keeps taking messages."
group: "Project internals"
number: 59
date: "2026-11-04"
status: "accepted"
order: 59
---

# 59. An OpenCode session stays open, and reachable, while a TUI is attached (#984)

*Amends #847's choice that idle means done (decision 4 of that issue): that still holds when no TUI is attached.*

**Context.** The OpenCode reporter swept a session quiet for `idleSeconds` (60 by default) to `done`, stopped reporting it, and the
server stops answering a `done` session. A message or `/compact` from the console could therefore not reach an OpenCode session left
quiet for more than a minute, and a peer message to it was dropped with `receiver-ended`. A Claude Code session stays `waiting`
while idle, and SPEC 1 ("send a new message") reads as if messaging works for an open session.

**Decision.**

- **Open means attached.** While the plugin's TUI part has said it is attached (it says so every 30 seconds, and it counts for 90),
  a quiet root is never swept to `done`. It stays `waiting` and keeps reporting, so it can be messaged and sent `/compact`.
- **Without a TUI, idle still means done.** A headless run, or a session whose TUI has gone for 90 seconds, ends after `idleSeconds`,
  as before. `session.deleted` and `session.archived` still end a root at once.
- **A delete does not reopen.** `session.deleted` and `session.archived` on a root that is already `done` change nothing, so the feed
  shows one "ended" entry, not "session reopened" followed by "session ended".

**Cost.** A TUI left open keeps its sessions on the wall as `waiting` for as long as it is open, as a Claude Code session is. The TUI
part's "attached" is a heartbeat, not proof the person is there. Claude Code's reporter is unchanged.
