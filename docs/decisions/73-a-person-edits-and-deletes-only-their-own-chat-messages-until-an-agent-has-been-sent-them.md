---
title: "73. A person edits and deletes only their own Chat messages, until an agent has been sent them (#1269)"
description: "Authorship is the person's id. A message locks once sent to an agent, a delete leaves a tombstone, and an edit keeps its mentions and sends nothing again."
group: "Project internals"
number: 73
date: "2026-11-20"
status: "accepted"
order: 73
---

# 73. A person edits and deletes only their own Chat messages, until an agent has been sent them (#1269)

*Builds on 62, whose rule that no Admin reads in silence is unchanged, and on 70, which says when a message is handed to an agent.*

## Context

A message sent in Chat could not be taken back. A typo stayed, and so did a message sent to the wrong channel or person. The change is small to ask for and hard to get right, because a message can already have reached someone's agent, and an agent cannot un-read it. Four things had to be settled: who may change a message, when it is too late, what a delete leaves behind, and what an edit may touch.

## Decision

- **Authorship is the person's id, not their name.** A message records `author_id`, the author's `people.id`. An id is never reused and has no foreign key, so a message kept after its person is deleted names nobody, and nobody can match it. The column is on `group_messages`, `public_messages` and `peer_messages`. An agent's message is still identified by its session id, and a mention by session id and peer key.
- **Messages stored before the change are backfilled in the migration** (SQLite 46, PostgreSQL 22, MariaDB 22). A step in JavaScript matches the stored author name to a current person with `nameKey`, the fold that already writes `people.name_lower`. For a direct message the name is the one in its sender key, or its owner when the person wrote into a conversation between two of their own agents. A message that matches nobody stays NULL and cannot be changed.
- **A message is locked once it has been sent to an agent.** In a channel, that is any mention of an agent (a session id) that is waiting, working or done (`lockedByDelivery`). In a direct message, it is one that is queued, handed or delivered, or one that is `ready` and approved by its owner (`isSentToAgent`). A mention of a person never locks. A message that is held (channel paused), waiting for another person's approval, not delivered, declined or dropped, and a message with no agent mention, stay changeable. Each adapter decides this in one step inside the store, so a message cannot be changed as an agent takes it.
- **A delete leaves a tombstone.** The row stays with its text emptied, its mentions cleared and `deleted_at` set. Its place, author and links are kept. A tombstone is never delivered, even from a held or approval state. A deleted direct message that was waiting is dropped with the reason `deleted`, and its approval request is closed.
- **An edit sends nothing again and cannot add or remove an @mention.** It runs the checks of a new message (length, rate limit, redaction) and keeps the stored mentions. What an agent was told and what the console shows cannot disagree. To address someone else, delete and send a new message.
- **Nobody changes another person's message.** There is no Admin edit or delete. The admin secret has no messages of its own, and an Admin who is a person may change only their own. No new Admin read or Admin act exists, so nothing new needs the notice 62 asks for.
- **A channel mention that waits for another person's approval keeps the id of its direct-message copy** (`copyId`, inside `mentions_json`, so no schema change). The chat core's `changeAcross` changes that copy first, so an owner never approves text the author has since changed or deleted.
- **The console learns of a change through the `chat` signal alone.** The signal carries no content, so the console re-reads the earlier pages it holds on each one, a request per page.

## Why

- A name can be taken again. A person created under a deleted person's name would otherwise inherit the old messages and could edit or delete them. An id cannot.
- Locking at the point of sending is the only line that keeps the record true. Once an agent has the text, changing it would make the console say something the agent was never told.
- A tombstone keeps cursors, replies and counts where they were. A physical delete would move all three.
- Keeping the mentions on an edit is what lets an edit send nothing, so it needs no second delivery and no second approval.
- Changing the copy first means the person who must approve is shown the text the author stands behind now, and the author's change is refused while that copy cannot follow it.

## Alternatives

- **Compare names to decide who wrote a message.** Rejected for the reuse above.
- **Leave messages stored before the change unchangeable.** The maintainer chose the backfill instead.
- **Lock only once the agent has taken the message (working or done).** Rejected. An edit would then have to pull the message out of the reporter's in-memory queue and queue it again, and a message could be taken between the check and the pull. The first version of the locked rule also left an approved but not yet fetched direct message editable, which let the text change after its owner approved it. The pre-PR review found that, and `ready` and approved now counts as sent.
- **A physical delete.** Rejected for the tombstone's reasons.
- **Let an edit change who is addressed.** Rejected. It would send a message to someone new, or take one back from an agent that already has it.
- **Let an Admin delete or edit any message.** Rejected. It is a new reach into a person's content, and 62 and 72 go the other way.

## Cost

- A person deleted and recreated under the same name before the upgrade could be matched to the old person's messages by the backfill. Only messages from before the upgrade are at risk, and the maintainer accepted it.
- A message that matched nobody in the backfill cannot be changed by anyone.
- A delete of a direct-message copy cannot be undone, so a delete that spans several copies can stop partway. The mention it stopped at reads dropped. A message that waited for approval before copies were kept has no `copyId` and is refused with 409 `approval`.
- Each `chat` signal makes a console re-read every earlier page it holds, one request per page. That cost is accepted so that the signal stays free of content.

<!-- nav:start -->
---

Previous: [72. An Admin responds only when the owner allows it, and every message names its sender (#1251)](72-an-admin-responds-only-when-the-owner-allows-it-and-every-message-names-its-sender.md) · Up: [Decisions](README.md)
<!-- nav:end -->
