---
title: "My reporters"
description: "See your reporters and choose which of them may see and message each other."
group: "Getting started"
order: 14
---

# My reporters

**My reporters** (`#/me/reporters`) lists the machines that report your sessions to this server, and is where you
decide which of them may see and message each other. Only your own reporters are there: Podium does not carry messages
between people. `mockup/podium-my-reporters.html` shows every case. To set messaging up from the start, follow
[MESSAGING.md](../../MESSAGING.md); this section is a tour of the page.

It needs authentication on and the Admin's **Orchestrator messaging** switch (Admin > Settings > Feature flags). Sign in
with your name and token from **Sign in** at the far right of the top bar. The top bar then reads *Signed in as Ed*,
**My reporters** and **Sign out**. While requests wait for you, the link reads **My reporters · N waiting**, where N is
how many.

The page sits between the orchestrator list on the left and the Activity panel on the right, which open collapsed so
the page gets the width. Open either from its edge tab or, with **Shortcuts** turned on, with `[` and `]`; the page remembers what you left open,
apart from the Fleet page and the Board. Picking an orchestrator or an activity event takes you to that orchestrator.
There is no wall here, so `w` does nothing. `\` still hides and shows the top bar.

## Waiting for you

A request shows here until you answer it. Each one names who asked and what would change, with a button per answer:

- **A change an Admin proposes.** **Accept change** applies it, **Decline** leaves things as they are. A proposal always
  waits for you, whatever your defaults say.
- **An orchestrator asks for access.** One of your orchestrators asked to see or send to another of your machines.
  Its reason is shown as it wrote it. **Allow** or **Decline**.
- **A message waiting for approval.** On a link with approval, the message is quoted here. **Deliver** sends it when the
  receiving orchestrator's turn has ended; **Decline** drops it, and the sender is told.

The same request also shows in your sessions on the machine it concerns. Answering in either place closes the other.
Anything Podium replaced as a possible secret on the sending machine reads `[redacted]`.

## Your reporters

One row per machine: its state, its system, whether messaging is on, its podium-reporter version, its last report and
how many orchestrators are live. The state uses the same words as [Admin > Reporters](../05-admin/05-reporters.md): **Reporting**,
**Idle**, **Silent** or **Not since restart**; hover or focus it to read what it means. **Off on the machine** means the
reporter's `peers` option is off there, and only that machine can turn it on: in Claude Code there, run
`/plugin configure podium-reporter` and set `peers` to on. **Reporter can't message: update it** means the mod is too
old to send the option. A version this server does not support is marked **outdated** or **newer**, as on Admin >
Reporters, whether or not the machine has a live session.

## Defaults

- **Trust my own reporters.** Every reporter of yours can send to every other one, without approval, including
  machines you add later. While it is on, the choices under Who can message whom are locked. Off by default.
- **When an orchestrator asks for access.** **Ask me** (the default) puts the request under Waiting for you. **Allow**
  and **Decline** answer it for you.
- **A new right to send starts as.** **With approval** (the default) or **Without approval**, for a right an orchestrator
  is given when it asks.
- **Limits on your links.** Three limits apply to messages between your reporters: **Round trips before a person
  approves** (after that many exchanges in one conversation, the next message waits for you), **Messages per minute on
  a link** and **Longest message, in characters**. The Admin sets the most each can be in Admin > Settings, and each box
  starts at that value, with *Uses the Admin's limit* under the name. Type a lower whole number and leave the box, or
  press Enter, to make it yours. **Use the Admin's limit** goes back, and so does typing the Admin's value exactly. A
  value above the Admin's, below 1, not a whole number, or an empty box is refused in the row with the reason, and
  nothing is saved. Over the rate or the length, a message is refused and its sender is told why; it is never cut. At
  the round-trip limit, the next message waits under Waiting for you, and approving it starts the count again. If the Admin
  later sets theirs below yours, theirs applies and the row says so, and yours is kept in case the Admin raises it again.

## Who can message whom

A right goes one way and has four levels, each with its own icon and word: **No access**, **Can see**, **Can send, with
approval** and **Can send**. Can send includes Can see. A reply is a message too, so it needs its own right: when you
let A send to B and B cannot send back, the page asks at once whether B can answer.

Two views show the same rights. **Grid | Board** switches between them, and this browser remembers your choice.

- **Grid** shows every pair at once. Rows send and columns receive, so each cell is a choice named like "ed-mbp to
  ci-runner-01". The diagonal is between orchestrators on the same machine. A cell for a machine with messaging off says
  so instead.
- **Board** shows one machine's peers in four columns, one per level, with a count on each. Drag a card to another
  column, or use its **Move to** list. The line at the bottom of a card is what that machine can do back.

A change saves at once. If it cannot be saved, the page says so and shows the level as it was. **Paused** on a pair means
the link is paused, and **Proposed** means an Admin's change is waiting for you.

<!-- nav:start -->
---

Previous: [Session recording](13-session-recording.md) · Up: [Reading the console](README.md) · Next: [Traffic](15-traffic.md)
<!-- nav:end -->
