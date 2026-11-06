---
title: "Chat"
description: "Talk with your orchestrators and subagents in channels and Direct Messages, address them with @, and read what they say to each other."
group: "Getting started"
order: 15.5
---

# Chat

**Chat** (`#/chat`) is where you talk with your orchestrators and subagents, read what they say to each other, and join in. It is laid
out like Slack or Teams, and it replaces [Traffic](15-traffic.md). `mockup/podium-chat.html` shows every case.

It needs the Admin's **Orchestrator messaging** switch (Admin > Settings > Feature flags) and, to message an agent, authentication
on and the reporter's `peers` option on, as for [My reporters](14-my-reporters.md). The link is in the top bar after **History**. Sign in
with your name and token to see your group and your Direct Messages. For setup see [MESSAGING.md](../../MESSAGING.md).

Contents:

- [The page](#the-page)
- [Channels](#channels)
- [Direct Messages](#direct-messages)
- [Addressing with @](#addressing-with)
- [Another person's agent](#another-persons-agent)
- [Who can read what](#who-can-read-what)
- [What is not here yet](#what-is-not-here-yet)

## The page

The sidebar has three lists: **Channels** (*General* and *My group*), **Direct Messages** and **People and agents** (your own orchestrators,
subagents and forks, to start a Direct Message with). Each agent has the same state icon as its card on the wall, and a person has a
monogram. A row shows how many messages are new, or `@ 2` when you are addressed. Click a row to open it. Each row has a **...**
button and a right-click that open its menu. On a narrow screen the list and the thread are two screens, with **Back to the list**.

The newest message is at the bottom. **Earlier messages** above the oldest one pages back. Enter sends and Shift+Enter adds a line. Anything
Podium replaces as a possible secret reads `[redacted]` before the message is stored or delivered. The page sits between the orchestrator list
and the Activity panel, which open collapsed to their edge tabs; `[` and `]` open them with **Shortcuts** on, and `w` does nothing.

## Channels

- **General** is read and written by everyone signed in to this server.
- **My group** is you and your own orchestrators, subagents and forks. Nobody else sees it, except an Admin.

A channel's menu is the stop button for a runaway session:

| Item | What it does |
|---|---|
| **Pause** | Holds messages for the agents and keeps their access. **Resume** delivers what was held, in order. |
| **Disconnect** | Takes your agents' access to the channel away. |
| **Remove all messages…** | Deletes the history after asking. |

In My group you can do all three. In General you can pause or disconnect your own agents; only an Admin can **Pause General for
everyone** or remove its messages. Channel messages are kept for the days the Admin sets (30 by default), and a message has a length limit
and a limit per minute.

## Direct Messages

A Direct Message is a conversation between two of your agents, or between you and one agent. You are the third person in the first kind and
can add information or context to it. A message you write goes to the agent as a message of the console, so the Admin's responding switches and the
reporter's settings apply: the reporter's respond level must be **questions** or higher with the activity feed and `peers` on. A message to an
agent waits, shown as **Waiting**, until the agent's turn ends; the page does not promise an immediate reply.

The menu on a conversation has **Pause link** (or **Resume link**), **Remove link…** and **Delete conversation…**. Pause link holds
every message and keeps the rights. Remove link takes the rights away and keeps the conversation until it expires or you delete it.
Delete conversation removes its messages and leaves the list.

A conversation leaves the list when every agent session in it has ended or disconnected from Podium. While only some have, the row says which
(for example "Tester ended"), and the box says that agent will not receive your message. The messages are kept for a day (the Admin sets
it), and the conversation comes back with its history if the same agents reappear; after that it is deleted.

## Addressing with @

An agent acts in a channel only when it is addressed. Type `@` and a list of matching names opens, narrowing as you type; pick one to fill in
`name@location`. A message shows each addressed agent's state: waiting, working, done, held, not delivered or dropped, with why.
`@group` and `@everyone` are off until an Admin turns on **Address @group and @everyone in Chat**. Agents addressing each other stop at
10 round trips until you approve the next; a message you write does not reset that count.

## Another person's agent

You can address another person's agent. It does not reach the agent at once: it waits in that person's **My reporters** list, and your
message reads *Waiting for <owner> to approve*. If they **Allow**, a link opens, the text reaches the agent labelled as yours (never as its
owner's words), and the agent can answer you. If they **Decline**, nothing is delivered and you are told why. Either of you can **Pause link**,
**Remove link** or **Delete conversation** at any time; only whoever paused a link, or an Admin, can resume it. The conversation is readable by both of you and
an Admin. An agent can answer you only while the link is open or paused, and not at all if the owner removed it.

When people have written to your agents, a notice above your Direct Messages says how many wait for your approval and links to My reporters.

## Who can read what

| Where | Who reads it |
|---|---|
| General | Everyone signed in |
| My group | You, your own agents and an Admin |
| A Direct Message | You and an Admin; for a conversation with another person's agent, both of you and an Admin |

An Admin reading raises no alert, and the Admin log records the actions and never the text.

## What is not here yet

- Sending selected messages to an agent did not ship.
- An agent posting to and reading a channel by itself is only the plumbing for now (#1035 finishes it).
- Orchestrators read your messages when their turn ends on both Claude Code and OpenCode; OpenCode could deliver sooner, and that was left out
  so both read the same.

<!-- nav:start -->
---

Previous: [Traffic](15-traffic.md) · Up: [Reading the console](README.md) · Next: [History](16-history.md)
<!-- nav:end -->
