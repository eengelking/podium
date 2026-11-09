---
title: "66. A closed conversation is kept for the days its harness lets a person resume the session (#1113)"
description: "Presence and data are separate rules: an agent is listed while its harness is open, and its chat is kept for the harness's resume window, then purged."
group: "Project internals"
number: 66
date: "2026-11-08"
status: "accepted"
order: 66
---

# 66. A closed conversation is kept for the days its harness lets a person resume the session (#1113)

*Amends 61 (#1034): a hidden Direct Message was deleted after the Admin's flat grace period. The harness's resume window now decides when it is known.*

## Context

A closed harness leaves the chat's People and agents list, but its session can still be resumed. Claude Code keeps a session's
transcript for 30 days by default so it can be resumed, and its `cleanupPeriodDays` setting changes that. A Direct Message that
was deleted 24 hours after its agents left was gone while the person could still resume the session, so a resume came back with
no history.

## Decision

- **Presence and data are two rules.** The agent is listed while its harness is open. Its chat content is kept for the harness's
  resume window.
- **The reporter says the window.** Each report carries `resumeWindowDays`. Claude Code reports its `cleanupPeriodDays` when that
  is a usable number, and 30 otherwise. A harness with no expiry uses 30, which is Claude Code's default: OpenCode has no retention
  option, so it always reports 30. The shared rule is `plugin/core/resumeWindow.ts`.
- **The server keeps it per session** (`sessions.resume_window_days`, in both adapters). A hidden Direct Message is deleted when it has
  been hidden longer than the longest window of its two agents. When neither agent has a window (a session stored before this, or a
  person's end of a conversation) the Admin's `graceHours` decides, as before.
- **A resumed session within the window returns with its content.** A new session for the same agent has a new session id, so it has
  its own conversation and shows none of the old one.

## Why

- The window is the harness's own promise that the session can come back. Keeping the chat that long, and no longer, is what a person
  expects from a resume.
- A reporter reads its harness's setting, so a person who changed `cleanupPeriodDays` gets the chat they chose to keep.

## Alternatives

- Keep every hidden conversation until the Admin's `retainDays`: ignores what the harness does, and keeps chat for sessions that can no longer be resumed.
- A server-side window setting only: the Admin would have to mirror each person's harness settings by hand.

## Cost

- A window longer than the server's own session retention (`RETAIN_SESSIONS_MS`, 30 days by default) does not keep chat past it, because
  deleting a session deletes its messages. An operator who wants a longer window raises that setting too.
- A Claude Desktop or Cowork session has no expiry unless the person sets one, and no expiry is reported as 30 days, not as for ever.
- The Claude Code reporter reads `cleanupPeriodDays` from the user's `settings.json` once when it starts. A value set only in a project's settings or by a managed policy, or changed during a running session, is not seen, and the default of 30 is reported.
- Group and General messages are not tied to one session, so they stay on the Admin's `retainDays`.

<!-- nav:start -->
---

Previous: [65. Closing the last OpenCode TUI ends the sessions that are quiet at once (#1029)](65-closing-the-last-opencode-tui-ends-the-sessions-that-are-quiet-at-once.md) · Up: [Decisions](README.md) · Next: [67. A PR adds a changelog fragment, and release-prep assembles the fragments](67-a-pr-adds-a-changelog-fragment-and-release-prep-assembles-them.md)
<!-- nav:end -->
