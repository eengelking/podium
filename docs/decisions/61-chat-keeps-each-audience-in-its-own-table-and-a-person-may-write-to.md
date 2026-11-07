---
title: "61. Chat keeps each audience in its own table, and a person may write to another person's agent only with its owner's approval (#1034)"
description: "Three tables with three read paths, a Direct Message hidden before it is deleted, and another person's text approved by its owner and framed as theirs."
group: "Project internals"
number: 61
date: "2026-11-06"
status: "accepted"
order: 61
---

# 61. Chat keeps each audience in its own table, and a person may write to another person's agent only with its owner's approval (#1034)

*Amends 37 (#347): messaging between people was blocked on the terms of use; one narrow path is now open. Amends 48 in that the storage interface gains a Chat store.*

## Context

Chat (#1032, #1034) is a conversation page with a channel everyone reads, a channel for one person's group, and the conversations
between a person's agents. The first design had one message table with a `visibility` column. A missed filter in any query on
that table would then show one audience's text to another, and the text can hold source code and paths.

Direct Messages also need an end. #347 kept a conversation for 30 days after its last message, which is the wrong rule for a chat
whose agents have all left. And a person who wants to ask a colleague's agent something had no way to, because #347 limits a link to
one owner.

## Decision

- **One table for each audience:** `peer_messages` (a conversation, read by its owner and an Admin), `group_messages` (one person's
  group) and `public_messages` (General). None is ever copied into, merged with or returned with another. They have separate
  interfaces in `types.ts`, separate route files and a test that fails if the code on one side names the other's store, and
  there is no `visibility` column.
- **A Direct Message is hidden, then deleted.** When every agent session in it has left the live set it leaves the list, its rows are
  kept for a grace period (24 hours by default, an Admin setting), and a purge deletes them after. If the same peers return, it
  and its history come back. This replaces the 30-days-after-the-last-message rule for that case only.
- **A person may write to another person's agent, with the owner's say-so.** The message is held as a request in the owner's
  My reporters list; Allow delivers it and opens a link between that person and the agent's reporter, Decline drops it. Either person
  can pause or remove the link, or delete the conversation, at any time, and only whoever paused it (or an Admin) can resume it. The
  agent receives the text framed as written by that person, never as its owner's words. An Admin needs the owner's say-so too.
- **An Admin can read a group and a Direct Message and can pause, disconnect and clear a group, and never in silence.** The
  first version of this decision raised no alert for a read. That is reversed (#1034, PROJECT.md "An Admin Never Reads in Silence"): the people in
  a conversation an Admin reads see a red banner that names every Admin reading, a permanent record line in the thread, and a callout in their
  reporter, and the Admin log records each reading session. An Admin can also pause and resume any Direct Message link, and cannot remove a link,
  allow, delete a conversation, or write in a Direct Message or in a person's group. An Admin's pause names the Admin and the owner cannot resume it. An Admin's pause, resume, disconnect, reconnect and clear are
  recorded for good. The audit events record the action and never the text.
- Delivery stays `queue` on both harnesses.

## Why

- A separate table makes "no route returns another audience's text" something a test can check by reading which store a handler names, and not
  a property every query has to remember.
- Telling a person while an Admin reads, and keeping a line they can see afterward, leaves the Admin able to read what they were entitled to and removes the one thing they could do unseen.
- A hidden conversation that comes back means a restarted agent does not lose its history, and a purge after a grace period means a
  chat whose agents are gone does not stay for 30 days.
- The owner's approval keeps the ownership rule of #347 (nothing reaches an agent without its owner) and the frame keeps the agent from
  mistaking a colleague's text for its owner's instruction, which is the harm #347's frame was written against.

## Alternatives

- One table with `visibility`: smaller, and one filter away from a leak. Rejected.
- Delete a Direct Message the moment the last agent leaves: loses the history of a session that merely restarted. Rejected.
- Delivery by `steer` on OpenCode: it works (#1033, 4 of 4 runs), but Claude Code cannot, and the two should read the same. Deferred.

## Cost

- Three stores and three read paths, each in both adapters, with a contract case for each.
- A person's message to another person's agent waits for a human, so it is not a way to reach an agent quickly.
- An Admin's reading is a row and a reporter callout for each visit, and an open thread pings every 15 seconds to keep it live; the record lines stay until the conversation is deleted or retention removes them.
- The stream's `chat` event is sent to every open console, so it carries only a change counter and a coarse scope. Counts and approvals come from the Chat routes, which check who is asking.

<!-- nav:start -->
---

Previous: [60. The built plugins are tracked in dist/ on main and checked on every PR into main (#983)](60-the-built-plugins-are-tracked-in-dist-on-main-and-checked-on-every-pr.md) · Up: [Decisions](README.md) · Next: [62. An agent's text and live activity are gated to the owner and an Admin, and the other open fleet reads stay open (#1076)](62-an-agents-text-and-live-activity-are-gated-to-the-owner-and-admin-and-the-rest-of-the-open-fleet-reads-stay-open.md)
<!-- nav:end -->
