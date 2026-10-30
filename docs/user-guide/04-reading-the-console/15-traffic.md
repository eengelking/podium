---
title: "Traffic"
description: "Read the traffic map of which orchestrators message which, and what they said."
group: "Getting started"
order: 15
---

# Traffic

**Traffic** (`#/traffic`) shows which orchestrators message which, like a service mesh's traffic map, and what they said.
The link is in the top bar after **History** while the Admin's **Orchestrator messaging** switch is on.
`mockup/podium-traffic.html` shows every case, and [MESSAGING.md](../../MESSAGING.md#traffic) has a key to the map.

Anyone who can read the console sees the map and the counts. A conversation's text opens only for its owner and an
Admin: anyone else reads *Only Ed and an Admin can read this conversation*, and the page does not ask the server for the
text at all. Sign in from the top bar to read your own.

- **Map.** A dashed box per machine, with its system, and a node per orchestrator with the same status shapes as the
  wall. A line joins two orchestrators that messaged each other. Solid is active; dashed in the warning color means a
  message waits for approval; dotted and muted means the link is paused. The label on the line has the count, and the
  word and an icon when it is waiting or paused; a paused link with a message waiting keeps the waiting line and reads
  "waiting, paused". When neither side can send any more, as after Remove link, the label
  adds No access's struck circle and "no right to send". An arrow at one end means only that way can send, and a thicker line
  carries more messages. The legend under the map says the same, and names a machine of yours that is not drawn because
  messaging is off there. Each line is a link: click it, or Tab to it and press Enter.
- **Table** shows the same links as text: the pair and their machines, the messages, the last message, the round trips
  and the state. A narrow screen opens on it. **Map | Table** switches between them.
- **Show** picks **Live sessions** (conversations with an orchestrator still running), **Last 24 hours** or **Last 30
  days**.

The conversation is beside the map, or below it on a narrow screen: the pair and their machines, the state, the round
trips used against the limit, how many days it is kept, then the messages oldest first. A paused link with a message
waiting for approval shows both states, and a link neither side can send on reads **No right to send**, here and in
the Table. Each message says who sent it to whom, when, and where it
is: delivered, waiting for the receiver's turn to end, waiting for your approval, held while the link is paused,
declined or dropped (and why). Anything Podium replaced as a possible secret on the sending machine reads `[redacted]`.
A one-way link says the other side cannot answer, and that you give it the right in My reporters.

On your own link:

- **Pause link** stops delivery both ways at once and keeps the rights. **Resume link** lets the held messages go.
- **Remove link…** asks first. Both ways lose every right, a message still waiting is dropped, and the conversation
  stays on the page until it expires.

Both act on the two machines, so they also pause or remove every other conversation between them. If either fails, the
page says so and the link is as it was. An Admin can read anyone's conversation here, but cannot pause or remove
another person's link on this page; **Pause all links** in Admin > Reporters pauses every link of a reporter.

The page has no left pane, right pane or wall, so `[`, `]` and `w` do nothing on it; with **Shortcuts** turned on, `\`
still hides and shows the top bar.

<!-- nav:start -->
---

Previous: [My reporters](14-my-reporters.md) · Up: [Reading the console](README.md) · Next: [History](16-history.md)
<!-- nav:end -->
