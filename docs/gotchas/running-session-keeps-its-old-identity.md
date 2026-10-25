---
title: "I changed my reporter settings and a running session did not change who it reports as"
description: "A session takes its name and token once, when it starts; quit Claude Code and start a new session, or set PODIUM_USER and PODIUM_TOKEN."
group: "Project internals"
area: "Reporters and machines"
date: "2026-10-15"
status: "open"
order: 12
---

# I changed my reporter settings and a running session did not change who it reports as

**You see:** You saved a new name or token, and a session that was already running still reports as the old person.

**Why:** A running Claude Code session cannot be handed to another Podium user. A session takes its name and token
once, when it starts, and keeps them. Saving new values in `/plugin configure`, `/reload-plugins` and `/clear` do not
change them (#226), and a session that tries is refused. A session with no token has nothing held yet, so adding one
later does apply.

The settings hold one login for each Claude config directory, so two logins on one machine need the environment
variables below (#230, blocked on what Claude Code offers a mod).

**Do:** Quit Claude Code and start a new session. Or start the terminal with `PODIUM_USER` and `PODIUM_TOKEN` set:

```sh
PODIUM_USER=Ed PODIUM_TOKEN=<Ed's token> claude
```

The server log shows no refusal for a person whose reporter simply sent nothing, so from the server's side that person
looks as if they do not exist. If a reporter shows as signed in on the person's side and nothing appears in Podium,
restart Claude Code first.

<!-- nav:start -->
---

Previous: [Rows that read "Not since restart" and never go away](not-since-restart-rows-never-go-away.md) · Up: [Gotchas](README.md) · Next: [The status line says "refused: session belongs to someone else"](refused-session-belongs-to-someone-else.md)
<!-- nav:end -->
