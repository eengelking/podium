---
title: "Closing a background session"
description: "Close a background session with Claude Code, since Podium cannot do it for you."
group: "Getting started"
order: 9
---

# Closing a background session

Podium cannot close a session for you. Claude Code can:

1. **List them.** `claude agents` opens Claude Code's agent view, with each background session and whether it needs
   input. For a plain list, run `claude agents --json --cwd ~/dev/skills` (use your own project directory). Each entry
   has an `id`, a `name` and a `state`. Add `--all` to include finished ones.
2. **Match the card to the session.** Look for the project directory and the name. Do not match on the id shown on a
   card. A card shows the session id, which changes on `/clear`, while the commands below take the background session's
   own `id` from the list. After a `/clear` the two differ (a card might read `ba37e9d6` for the session
   `claude agents` calls `ee780da5`).
3. **End it.** `claude stop <id>` stops the session and keeps its conversation, so `claude attach <id>` can open it again
   later. The card leaves the wall a few seconds after it stops.
4. **Or delete it.** `claude rm <id>` deletes the session and its worktree, and works on sessions that have already
   exited. If the worktree has unpushed commits or uncommitted changes, `claude rm` reports them and does not discard
   them unless you pass the flag it prints. Use `stop` when you only want it off the wall.

Two more commands help:

- `claude attach <id|name>` opens one in the current terminal. The arrow-left key returns to the agent view, and Ctrl+Z
  drops back to your shell.
- `claude logs <id|name>` prints its recent output.

`attach` and `logs` accept part of the name, but `stop` and `rm` need the id. These are Claude Code's commands, so
`claude <command> --help` is the final word if they change.

<!-- nav:start -->
---

Previous: [Sessions that have not done anything yet](08-sessions-that-have-not-done-anything-yet.md) · Up: [Reading the console](README.md) · Next: [One session](10-one-session.md)
<!-- nav:end -->
