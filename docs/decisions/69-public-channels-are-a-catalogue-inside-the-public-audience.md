---
title: "69. Public channels are a catalogue inside the public audience (#1035)"
description: "A public channel is a key on public_messages, not a new audience: no visibility column, no Admin-read notice; agents read it as General."
group: "Project internals"
number: 69
date: "2026-11-17"
status: "accepted"
order: 69
---

# 69. Public channels are a catalogue inside the public audience (#1035)

*Amends 61: General is no longer the only content of the public audience's table.*

## Context

Chat has General and My group, and General is the only public place ([61](61-chat-keeps-each-audience-in-its-own-table-and-a-person-may-write-to.md)). People and agents also need public places for a topic, a project, a milestone or an issue, where anything posted can be found later (#1035). Decision 61 says the audience is the table and there is no `visibility` column, so a new place has to fit that rule and not weaken it.

## Decision

- **A public channel is a key on `public_messages`, not a new audience.** The audience is still the table. Each message of the public table carries the key of its channel, and General is the built-in key (`general`, not a row of `public_channels`). `public_channels` only lists the channels beside General: name, description, an optional link to an issue, a milestone or a project, and who opened it. There is no `visibility` column, and a group's or a Direct Message's text is never reachable through a public channel route. `chatSeparation.test.ts` and the privacy cases in `chatChannelsPublic.test.ts` hold this.
- **Everything in a public channel is readable by every signed-in person, every reporter and every Admin.** An Admin's read of a public channel raises no notice and writes no `chat_admin_reads` record, exactly as for General. The content is public, so there is no one to tell. An agent's read of a public channel is the same call as its read of General (`channels.agentRead`), which is `owner-only` in the Admin read registry: an Admin is refused it, so it needs no notice.
- **An Admin's power to stop things is still told to the person it affects.** An Admin who edits the description of a channel, or removes it, tells the person who opened it, in each of that person's live reporter sessions, in words and with the Admin's name. An Admin's pause for everyone and remove-all are told to every live session, as for General. The Admin log records who and which channel, never text.
- **Who may do what.** A signed-in person or an Admin opens a channel (at most 50 beside General). Its opener or an Admin edits the description. Only an Admin removes a channel. An agent may only read and post, through its reporter's token route, and only an orchestrator's main loop posts for an agent (the reporter enforces that; the server cannot tell).
- **An agent reads and posts a public channel exactly as it does General, and there is no difference between them.** In every channel (General, My group and each public channel) an agent reads or posts only when it was called into that channel, which means a delivered `@` of it stored in the channel in the last hour, and it sees at most the last hour: the newest messages that fit in about 30,000 characters, whole messages only, oldest first, with a cursor for the older ones that are still inside the hour. An agent that was not called in is refused with `NOT_CALLED`. The maintainer's rule: an agent should never read a public channel's full history, least of all with no call-in, and may review the past hour at most, and only when called in. Listing the channels (name, description, link, opener, message count and flags, never a message) needs no call-in, because an agent needs a name to post to `channel:<name>`.

## Why

- A key on the existing table adds a place without adding an audience, so the separation that 61 relies on (one table, one read path) is kept and a missed filter still cannot show private text.
- Notice is for content that is not already public. A notice for every read of a place everyone may read would carry no information and would train people to ignore the notices that matter.
- Telling the opener of an Admin's edit or removal keeps the rule that an Admin's power over what a person made is never quiet.
- An agent that reads a whole channel's history, or any channel without being asked into it, would take in text its person never meant it to act on. One rule for every channel keeps what an agent may see small and easy to state: it was called in, and only the last hour.

## Alternatives

- **A `visibility` column on one message table.** One missed filter shows one audience's text to another. Rejected in 61 and again here.
- **A new table per channel.** The audience would be a table again, but the number of tables would follow the number of channels. A key keeps the schema fixed.
- **Agents page the full history of a public channel, with no call-in.** This was the first version of #1035. The maintainer rejected it: an agent should never read a public channel's full history, especially with no call-in.

## Cost

- An agent cannot look back past an hour in any channel. A person reads the full history in the console.
- An Admin who edits or removes a channel is told to the opener only in live reporter sessions, for five minutes. A person with no live session sees nothing, because the Admin records have no kind for these acts yet.
- An `@` of another person's agent in a public channel still creates the request for that agent's owner, as in General, and that request is a conversation row holding the person's own public text.

<!-- nav:start -->
---

Previous: [68. A loop's background shells and monitors have a Background tab in the Activity modal (#897)](68-a-loops-background-shells-and-monitors-have-a-background-tab-in-the-activity-modal.md) · Up: [Decisions](README.md)
<!-- nav:end -->
