---
title: "74. A Direct Message is a conversation of two or more people, and an Admin cannot read one that has no agent in it (#1278)"
description: "A person messages any person, running or not, in a conversation of two or more members. An Admin reads one only when an agent is in it, and the people are told."
group: "Project internals"
number: 74
date: "2026-11-20"
status: "accepted"
order: 74
---

# 74. A Direct Message is a conversation of two or more people, and an Admin cannot read one that has no agent in it (#1278)

*Amends 69's list of audiences (a fourth is added) and the spec's definition of a Direct Message in 7.1. Builds on 62, whose Admin read notices stay for every conversation an Admin may read.*

## Context

Chat lists every person under People and agents, but Message on a person opened New direct message, which could only send to one of that person's live orchestrators. With none running, "Choose who to message." could not be answered and nothing could be sent. The spec defined a Direct Message as a conversation between two of a person's agents, or between a person and one agent, kept in `peer_messages`, so a message to a person was never possible.

The maintainer's model is Slack or Teams: a person messages a person, and an agent is in the conversation only when someone puts it there on purpose.

## Decision

- **A Direct Message is a conversation of two or more members.** A member is a person or an agent. A conversation has no agent unless a person added one on purpose; it is never tied to an agent by default. Two people make a Direct Message, three or more make a group conversation, and the same rule holds for agents (two or more agents or people).
- **Message on any person always works.** It opens the conversation with that person, or the one that already exists for the same members, whether or not they have an orchestrator running. "Choose who to message." does not appear for a person who is listed.
- **The recipient is told in Chat.** The conversation shows in their list with an unread count, and a message to someone who is not looking raises the same unread count and mention that a channel message does. The console is where they look; nothing is sent to a reporter for a conversation with no agent in it.
- **Consent.** Any signed-in person may start a conversation with any other signed-in person and needs no approval. An agent joins a conversation only when a person adds it, and another person's agent still waits for its owner's allow, as an `@` of it does (7.1, "Another person's agent").
- **An Admin cannot read a conversation that has no agent in it.** No route, page, tool or log shows an Admin its messages, or its name, members or counts, and the Admin's read of a person's Chat (`?owner=`) leaves it out. "An Admin never reads in silence" is met here by there being nothing to read: a person-to-person conversation cannot run away, so there is nothing for an Admin to stop.
- **An Admin may read a conversation that has an agent in it,** so it can break the agent's link or delete the conversation in a runaway. That read tells every person in the conversation in the console and in `podium-reporter`, and is recorded in the Admin log with who, whose and when, and never the text, as for any Direct Message today. While an agent is a member, an Admin may pause the agent's link and remove the agent, and may not write or edit.
- **Storage is a fourth audience, in its own tables,** next to `group_messages`, `public_messages` and `peer_messages`, and never copied into, merged with or returned together with any of them: a conversation, its members (a person or an agent, with who added it and when it joined or left) and its messages. Each adapter carries the same schema and migration, with a `contract.ts` case, and the retention sweep and a deleted person remove their membership (a conversation left with no person in it is deleted).
- **`peer_messages` is unchanged.** The conversations between agents, and between a person and one agent, stay as they are until a later decision moves them into a conversation with members.

## Why

- A person is the recipient and an agent is one way a message may be delivered. Tying a message to a live orchestrator made Chat unable to do what any chat does.
- An Admin's power over a person's conversation exists to stop an agent that runs away. Two people cannot run away, so the Admin needs no read, and the person's words stay theirs.
- Members with a kind (person or agent) let one model carry a person-to-person conversation now and an agent added later, without a second table for either.
- A fourth table keeps the rule that a missed filter cannot send one audience's text to another.

## Alternatives

- **A person's message also goes to their orchestrator when one is running.** Rejected: it makes the conversation depend on whether an agent is running and surprises the recipient with an agent reading their private words.
- **Admins read every conversation with a notice.** Rejected: the notice stays an Admin's guardrail for what an Admin may read, and a conversation with no agent has no reason to be read at all.
- **Store a person's conversation in `peer_messages` with a person on each side.** Rejected: that table is keyed by agent sessions and its read path is built on them, and its separation from the other audiences is held by a test.

## Cost

- A new set of tables, routes and read state in every adapter, and a new audience to keep separate.
- A person's conversation is outside every Admin tool, so an Admin cannot help a person who asks for it to be read. A person who wants help shares it themselves.
- Chat still needs orchestrator messaging on, because its routes answer `403` while it is off. A conversation of two people does not need it to work, so tying it to that switch is a cost to remove later.
- Adding an agent to a conversation is a separate piece of work (its link, its owner's allow, the Admin's read and the notices it brings). Until it ships a conversation has people only.

<!-- nav:start -->
---

Previous: [73. A person edits and deletes only their own Chat messages, until an agent has been sent them (#1269)](73-a-person-edits-and-deletes-only-their-own-chat-messages-until-an-agent-has-been-sent-them.md) · Up: [Decisions](README.md)
<!-- nav:end -->
