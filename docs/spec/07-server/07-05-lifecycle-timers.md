---
title: "7.5 Lifecycle timers"
description: "The sweeper's timers and their defaults: when a session goes stale, lingers and is dropped."
group: "Reference"
section: "7.5"
order: 5
---

# 7.5 Lifecycle timers

Module: `sweeper.ts`. It runs every second, and all values are env-configurable.

| Condition | Result | Default |
|---|---|---|
| `status ≠ done` and no report for `STALE_AFTER_MS` | Shown as `stale` (derived, not stored) | 15,000 |
| `stale` for `DROP_AFTER_MS` more | `dropped_at` set, removed from the live set, event `end` "heartbeat lost" | 60,000 |
| `status = done` for `LINGER_MS` | Removed from the live set, event `end` "session ended" | 8,000 |
| `attached = false` for `DETACHED_HIDE_AFTER_MS` | The wall sets the card aside behind a "N background sessions hidden" note (client-side; the session stays live, in History and in the totals). A client attaching again clears it at once | 60,000 |

A stale session that reports again immediately returns to its stored status. A dropped session that reports again is revived (clear `dropped_at`, `ended_at`). On server start the sweeper treats every stored non-done session as stale until it reports. SSE broadcasts `removed` when a session leaves the live set.

`SessionView.dropAt` is when a stale session leaves the live set by itself: `max(last_seen + staleAfter, server start if not heard since) + DROP_AFTER_MS` (`staleAfter` is `STALE_AFTER_MS`, or `HOOK_STALE_AFTER_MS` for a hook-only session). The sweep and the view use the same calculation, so a heartbeat-lost card shows a countdown that matches what happens, including after a restart.

**The Claude desktop app (#737).** The reporter runs inside each session's own process, so it reports only for a session the app has started. After the app is quit and opened again it restores the session on screen and leaves the others dormant; a dormant session reports nothing until the person opens it. The timers above apply unchanged: quitting the app makes every session it had open stale, then dropped as "heartbeat lost". When the app starts the session on screen again, it reports under its old id and is revived as above. A dormant session has nothing to revive, so it stays off the wall until the person opens it. Once opened, it may report under a new id, and then it is a new card, not a revival; the old id stays in History. Podium does not keep a card for a session that is not reporting, because it cannot tell a dormant desktop session from one that has ended.

**Remove.** A heartbeat-lost card and its rail row have a Remove control, and the orchestrator page has "Remove now" on its status band. It calls `POST /api/fleet/sessions/:id/drop`, which runs the same exit as the automatic drop (`dropped_at` set, event `end` "heartbeat lost", `removed` with reason `dropped`), so every open tab updates. The session stays in History, so Remove asks for no confirmation. The server refuses a session that is not `stale`. Removing hides the card and nothing more: a removed session that reports again comes back on the wall, exactly as a dropped one does. Remove needs no token, like the other requests the dashboard makes, and sends nothing to the session.

**Quiet sessions are not part of the wall.** A session that has done nothing yet has a status other than
`running` and no tokens, cost, context, blowouts, agents or plan.

- It stays out of `/state`, the SSE `session` and `activity` messages, the KPIs, `/history`, `clearedToday`,
  the activity feed, and the `liveSessions` number in the report ack and `/health`.
- It appears as soon as any of those change.
- Sessions reported only through settings hooks are exempt, because hooks carry no usage and would never leave
  that state.
- Claude Code's background daemon runs such sessions (a parked twin of an interactive window, and a pool of
  pre-warmed spares), and each one loads the reporter.

**Chat (#1034).** Chat has its own timers, run by the hourly retention and by what happens to a session. They are set in
Admin > Settings > Chat ([7.2](07-02-database.md#what-chat-keeps-and-where-1034)).

| Condition | Result | Default |
|---|---|---|
| Every agent session in a Direct Message has left the live set (ended, dropped or deleted) | The conversation is **hidden**: it leaves the list, and its messages are kept (`hidden_at` set) | at once |
| A hidden conversation for `graceHours` | Its messages are purged by the hourly run, and the conversation is gone | 24 hours (1 to 720) |
| One of the same peers reports again within that time | The conversation is shown again, with its history | n/a |
| A channel message older than `retainDays` | Deleted by the hourly run, in General and in every group | 30 days (1 to 365) |
| The server starts, and every hour | Every owner's conversations are checked against the live set, so what changed while the server was down is hidden or shown | hourly |

- This replaces "kept until 30 days after the last message" for a conversation whose agents have all left. Before this, such a
  conversation stayed on the list until the Admin's messaging retention ended it, and it was deleted with its sessions. Now
  it leaves the list when the last agent leaves and is deleted a grace period later. Messaging's own retention
  ([7.7](07-07-hardening.md#orchestrator-messaging-347)) still removes a conversation that has been quiet for that many days.
- While only some agents of a conversation have left, the conversation stays, the row names which have ended, and a message to
  an ended agent is refused with "has ended, so Podium did not queue the message".
- A conversation is hidden for the person who owns it; hiding it changes nothing about the link or the rights.
- The hourly run writes one `chat_purged` entry to the Admin log when it removes something, with counts and never text.
- A held message (a channel that is paused) waits until the channel resumes. If the agent it was for ends first, it is marked
  Dropped with the reason.

<!-- nav:start -->
---

Previous: [7.4 View types](07-04-view-types.md) · Up: [7. The server](README.md) · Next: [7.6 SSE stream](07-06-sse-stream.md)
<!-- nav:end -->
