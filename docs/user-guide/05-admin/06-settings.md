---
title: "Settings"
description: "Turn features on or off for everyone on this server and change its settings."
group: "Getting started"
order: 6
---

# Settings

These settings apply to every browser and stay after a restart.

**Feature flags**, at the top, turn a feature on or off for everyone on this server.

- **Respond from Podium** (`respond`) is off by default. It lets people answer and message the sessions they own (see
  [Answering a session from Podium](../04-reading-the-console/12-answering-a-session-from-podium.md)). Each answer is written to the Admin log with who
  sent it, followed by a row saying what became of it:
  - the session took it, or refused it;
  - it never got there, because its sender discarded it, its ask closed first, the session ended or was deleted first, or
    responding was turned off first;
  - a message the session had queued when it ended says only that the session ended while it was still queued, because
    Podium cannot tell whether Claude Code read it.
- **Agent activity feed** (`activity-feed`) is on by default. Turned off, every agent and orchestrator panel says the
  Admin turned the feed off, the server asks no mod for activity and forgets what it held, whatever each machine's
  `activityFeed` option says. Turned back on, open panels start the feed again, empty, without a reload. Turned off, nothing
  new is stored either, even if the Admin keeps stored history.
- **File diff** (`file-diff`) is off by default. On, only the owner of a session, signed in, can click a file in
  the Files list to read its diff in a window, and step to the next or previous file with the buttons at the window's lower left. The diff is source code: the mod reads it from the machine only if that machine's `fileDiff` option is on. With the
  `fileDiffPreload` option also on (the default), it reads the diff of every changed file while the owner has the session's page
  open, so a file opens with no wait and updates when it is edited again; set `fileDiffPreload` to false to read a diff
  only when someone opens the file. The diffs sit in the owner's browser page and are thrown away when the page is left. The server passes it to the one browser
  that asked and keeps no copy. The mod hides what looks like a secret (tokens, passwords, keys, credentials in URLs) as `[redacted]` before
  the diff leaves the machine, and never sends `.env` files, keys or credentials files at all. Hiding is best
  effort, not a guarantee. Off, the Files rows show their counts and no link.
- **Release check** (`update-check`) is on by default. About once a day the server asks GitHub for the latest Podium
  release, and when it is newer than the one running, the wall shows a notice with both versions and a link to the
  release notes. To update, pull the new release and run `podiumctl build`. Turned off, the server makes no request to
  GitHub at all, which is the setting for an install that must not make outbound calls. A check that fails (offline,
  rate limited) shows nothing and tries again the next day.
- **Orchestrator messaging** (`peer-messaging`) is off by default. It lets a person's orchestrators message each
  other, only between that person's own machines, once each machine's podium-reporter has its `peers` option on and the
  owner has given the pair a right on [My reporters](../04-reading-the-console/14-my-reporters.md). It needs authentication on. Turned on, it adds an
  **Orchestrator messaging** section here, a Messaging section on each reporter, [My reporters](../04-reading-the-console/14-my-reporters.md) and
  [Traffic](../04-reading-the-console/15-traffic.md).

- **Session recording** (`session-recording`) is off by default. It lets the owner of a session, or an Admin, record the
  session whole and replay it (see [Session recording](../04-reading-the-console/13-session-recording.md)). It needs authentication on, and the switch is
  unavailable without a token. Turned on, it adds a **Session recording** section and a **Recordings** table here. Turned
  off, every recording stops and what is stored stays until it expires.

**Session recording**, shown while that flag is on, sets how long recordings are kept and how big they may get. The
**Recordings** table below it lists every recording with its owner, who started it, state, size and when it goes, with
**Stop**, **Open replay** and **Delete**. Stop and Delete ask first. [REPLAY.md](../../REPLAY.md#limits) has the ranges and what
happens at each limit.

| Setting | Default | What it does |
|---|---|---|
| Keep a recording for | 6 hours | Counted per part from when it was recorded, at most 7 days. A shorter time removes recordings already older |
| Disk budget | 4 GB | All recordings together. Reaching it stops every recording |
| Limit for one session | 512 MB | A recording stops when its session reaches it |

**Orchestrator messaging**, shown while that flag is on, sets the limits on every link. An owner can make them stricter
on their own links in My reporters, never looser. [MESSAGING.md](../../MESSAGING.md#limits) says what happens at each one.

| Setting | Default | Range | What it does |
|---|---|---|---|
| Round trips before a person approves | 10 | 1 to 100 | After this many exchanges in one conversation, the next message waits for the owner to approve it |
| Messages per minute on a link | 6 | 1 to 60 | More than this is refused, and the sender is told to wait |
| Longest message, in characters | 20,000 | 1 to 20,000 | A longer message is refused, never cut |
| Keep conversations, in days | 30 | 1 to 365 | How long a conversation is kept after its last message |

A value is saved when you leave its box or press Enter. One out of range is refused in its row: the error says nothing
was saved and which value still applies.

**Wall notices.** The notes Podium shows at the bottom of the wall each have a switch here, and the X on a note turns its
switch off for everyone. After you close one, Podium says so and links to this page. The update notice is the exception:
its X hides the release it names for everyone and the notice comes back when a newer release is published, so its switch
is **Release check** under Feature flags.

**Background sessions.** **Show background sessions on the wall** keeps sessions nobody is attached to in view. It is off
by default.

**Card titles.** **Title cards with the machine** titles each card on the wall with the machine and the session, such as
`Silverbolt | Foobar`, so cards from several machines are told apart at a glance. It is off by default, and it changes
every browser at once. A session whose machine is not known keeps its own name.

**Forget old reporters** is off by default. It removes a reporter from Admin > Reporters once the server has not heard
from it for the number of **Days** you set (30 to start with).

- It is checked when the server starts and then every hour.
- Each run that removes any is written to the Admin log.
- Sessions are not touched, and a reporter comes back if it reports again.

<!-- nav:start -->
---

Previous: [Reporters](05-reporters.md) · Up: [Admin](README.md) · Next: [Model prices](07-model-prices.md)
<!-- nav:end -->
