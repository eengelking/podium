---
title: "Sessions that have not done anything yet"
description: "Understand why a fresh session is not on the wall until it has done something."
group: "Getting started"
order: 8
---

# Sessions that have not done anything yet

A session is put on the wall once it has done something: it is running, or it has tokens, cost, context use, a blowout,
an agent or a plan. Until you send it a prompt it is not shown, and the status line in a fresh session reads
`podium ● 0 live`. This is on purpose.

Claude Code's background daemon runs sessions you did not start by hand. On Claude Code 2.1.296 we saw a parked
background twin of each interactive window and a pool of pre-warmed spare processes. Every one of them loads the
reporter and reports itself as a session, so a single window could put three identical "waiting on you" cards on the
wall. Podium keeps the ones that have done nothing off the wall, out of the activity feed and out of the history, and
shows them the moment they start work. The rule is in [SPEC 7.5](../../spec/07-server/07-05-lifecycle-timers.md).

What that means in practice:

- Open Claude Code in a project: no card yet. Send a prompt and one card appears.
- The `N` in `podium ● N live` is the number of cards on the wall, not the number of Claude Code processes on your
  machine.
- After `/clear` the old card ends and the new session gets a card once you send its first prompt.
- Sessions you started without the mod, reported through settings hooks, are never hidden this way, because hooks carry
  no token or cost figures to judge them by.

## A card after you close the window

A card can stay on the wall after you close the window. Closing Claude Code can leave the conversation running in the
background (the window says "Your conversation moved to the background"). That is a real session and it stays until it
ends. See [Closing a background session](09-closing-a-background-session.md) to list and end it.

A session with no window on it is marked:

1. After `/exit`, the card turns dashed and muted with a "nobody attached" chip and a countdown.
2. After `DETACHED_HIDE_AFTER_MS` (a minute by default) it leaves the wall. A note at the bottom of the wall says how many
   background sessions are hidden and what they cost, with a Show them link. It still counts in the totals and in
   History.
3. Run `claude attach` and the card comes back as a normal card at once.

Close the note with its X to turn it off. Admin > Settings turns it back on and can also keep background sessions on the
wall. A one-off `claude -p` run reads the same way, because it never has a window. This needs the mod at 0.7.0 or later.
An older mod's sessions are never marked.

<!-- nav:start -->
---

Previous: [Paging the list](07-paging-the-list.md) · Up: [Reading the console](README.md) · Next: [Closing a background session](09-closing-a-background-session.md)
<!-- nav:end -->
