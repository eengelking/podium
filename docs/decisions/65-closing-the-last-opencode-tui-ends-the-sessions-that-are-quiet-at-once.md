---
title: "65. Closing the last OpenCode TUI ends the sessions that are quiet at once (#1029)"
description: "The TUI part tells the server part when it closes, and a session that is quiet then goes done without the 90 s attach limit and the 60 s idle wait."
group: "Project internals"
number: 65
date: "2026-11-08"
status: "accepted"
order: 65
---

# 65. Closing the last OpenCode TUI ends the sessions that are quiet at once (#1029)

*Adds to [59](59-an-opencode-session-stays-open-while-a-tui-is-attached.md): a TUI that is attached still holds a quiet session open, and one that has closed no longer holds it for the time limit.*

## Context

Under `opencode --standalone` the plugin lives in the terminal's own process, so closing the terminal (Ctrl+C, or a kill) ends the reporter, which reports `done` at once, and the card leaves about 9 seconds later (a live run: `done` at 1 to 2 s, gone at 9 s). Under OpenCode's background service the plugin outlives the terminal. Nothing told it the TUI had gone, so the session stayed `waiting` until the TUI's last attach passed 90 seconds, then waited out `idleSeconds` (60), then lingered 8: a live run measured `done` at 72 s and gone at 81 s.

## Decision

- The TUI part says it is leaving, in the cleanup it already has, with a `detach` call that names it. Each TUI part has an id (`attach` and `detach` carry it), so the server part knows when the **last** one has left.
- When the last TUI part detaches, every session that is quiet at that moment (nothing running, no question or permission open, not compacting) is reported `done` with `endReason: "detached"`, with no idle wait. The card then leaves like any `done` one, after the 8 second linger.
- A session that is running, asking or compacting is kept, and falls back to the old rules. Another TUI part still attached keeps every session open.
- No default changes: `idleSeconds` stays 60 (at least 5), and the server's timers are untouched, so Claude Code is not affected.

## Why

The reporter cannot tell a closed terminal from a model that is thinking quietly, so a shorter `idleSeconds` would end a session that is only working. The TUI part is the one that knows its own terminal closed.

## Alternatives

- A shorter `idleSeconds`: ends a quietly working session early.
- Shorter server timers (`LINGER_MS`, `STALE_AFTER_MS`): shared by Claude Code, and the stale path only covers a reporter that has stopped, not one that is still running.

## Cost

A TUI killed so hard that it cannot run its cleanup says nothing, and the card falls back to the 90 second limit and the idle wait (not seen under `--standalone`, where the whole plugin dies with it). The word is per location, not per session: when the last TUI closes while a web client or another non-TUI client still has a quiet session open in the same folder, that session is reported `done` too, and it returns only when it reports activity again (messaging to it is refused until then). Podium cannot see such a client (`attached` is never false, see REPORTER.md), so this is accepted. A session left running with no TUI that was never attached is unchanged.
