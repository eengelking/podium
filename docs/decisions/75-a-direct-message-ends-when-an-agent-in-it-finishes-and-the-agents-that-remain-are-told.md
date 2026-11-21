---
title: "75. A Direct Message ends when an agent in it finishes, and the agents that remain are told (#1283)"
description: "A finished agent's conversation is deleted with its text, not kept for a resume. Only a lost heartbeat still hides it and brings it back."
group: "Project internals"
number: 75
date: "2026-11-21"
status: "accepted"
order: 75
---

# 75. A Direct Message ends when an agent in it finishes, and the agents that remain are told (#1283)

*Amends 66 (#1113): a closed conversation was kept for the harness's resume window. That now holds only when the agent lost its heartbeat. A finished agent's conversation is deleted at once.*

## Context

A Direct Message that involved an agent stayed on the sidebar after the agent ended, with only a tag, "Tester ended". The agents that remained were not told, so they could keep
writing to it or open a new conversation to the same name. Worse, a session that is reset with `/clear` can take the same name again. The new agent has none of the earlier
conversation, yet it looked like a party to it, so other agents talked to it as if it remembered.

## Decision

- **A final end concludes the conversation.** When an agent finishes (the old session after `/clear` included) or an Admin deletes it, every Direct Message it is in is locked and
  deleted with its text, and it leaves everyone's list. A conversation between people alone has no agent and is never touched.
- **A lost heartbeat is not an end.** A report may undo it, so such a conversation is still hidden and comes back (decision 66 holds for it).
- **A conversation with two or more people left stays.** The agent is shown as ended, it can no longer send or be sent to, and the people can keep writing. The "ended" mark is read
  from the agent's session, so no column was added and it holds after a restart.
- **The people and the agents that remain are told.** The people see a wall notice and, in an open thread, a banner. A message waiting for the owner's approval is discarded with the
  conversation, and its writer is told how many messages were not delivered. A live agent that remains gets one notice in Podium's own words, which both reporters turn into a turn.
  The words start with a shared mark (`ENDED_NOTICE_MARK`), so a reporter tells them from every other notice, which is a log line only.
- **What the console is told is memory only.** The list of what was concluded holds names and times for 24 hours, at most 20 for a person. A person who was not connected when it
  happened is not shown it.

## Why

- Whoever remains must be able to tell that the conversation is over, or the next message goes to nobody, or to a stranger that took the name.
- The work the conversation was about is over, so nothing of it is kept. Keeping the text for a resume would put it in front of an agent that never wrote it.
- Reading "ended" from the session needs no schema change in three storage adapters, and cannot drift from the session it describes.

## Alternatives

- Keep the hide-and-resume for every end: it keeps the stale conversation the issue set out to remove.
- Delete on a lost heartbeat too: a network blip would delete a conversation its owner can still resume.
- Store the notice as a message in the thread: it needs a new message kind and a schema change in every adapter, for a line that can be derived.
- Make closing the wall notice turn it off for everyone, as the standard says: the notice reports an event, so one close would switch off the next one. Its X dismisses one row, as the
  update notice's X hides one release, and a switch under Admin > Settings turns the kind off.

## Cost

- A person who resumes a finished session no longer finds its Direct Messages. Only a lost heartbeat does that now.
- The wall notice and the banner are not stored: a restart, or 24 hours, forgets them.
- An agent that finished and then resumes under the same session id is no longer shown as ended once it reports again. Decision 66's resume window and this one meet there.

<!-- nav:start -->
---

Previous: [74. A Direct Message is a conversation of two or more people, and an Admin cannot read one that has no agent in it (#1278)](74-a-direct-message-is-a-conversation-of-two-or-more-people-and-an-admin-cannot-read-one-without-an-agent-in-it.md) · Up: [Decisions](README.md)
<!-- nav:end -->
