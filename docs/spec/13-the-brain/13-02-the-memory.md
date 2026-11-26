---
title: "13.2 The memory"
description: "The memory record: its fields, types, tags, project, versions and states (including the 30-day trash), edges, and how an id binds it to a person."
group: "Reference"
section: "13.2"
order: 2
---

# 13.2 The memory

## 13.2 Fields

A memory is one record with these fields. The names are the contract between the server, the reporter and the console; the
column names are the adapters' business.

| Field | Rule |
|---|---|
| `id` | Server-given, never reused, never changed. A memory is found by id, never by name (DECISIONS 77). |
| `owner` | The `people.id` of the person it belongs to. For an `everyone` memory, the person who made it public. |
| `scope` | `person` or `everyone`. |
| `project` | The id of one project, or none ([13.3](13-03-who-can-read-and-write.md)). It is not part of a version's content. Only the owner changes it, in the console, and the change is recorded in the memory's history. |
| `type` | One of `user`, `feedback`, `project`, `reference`. A harness's format maps its own field to this one ([13.5](13-05-sync-with-local-memory-files.md)). Part of a version's content. |
| `name` | One line, at most 120 characters. Display text, never a key. |
| `description` | The summary: one line, at most 300 characters. It is what a search result shows, so it says when the memory applies. |
| `resources` | At most 10 attached references, each a `name` (120), a one-line `description` (300) and `content` (8,000). They are read one at a time ([13.4](13-04-search-and-weight.md)). Part of a version's content. |
| `checked_at`, `checked_by` | When someone last confirmed the memory is still true, and who. Set by the owner, or the owner's agent after it checked. It is not part of a version's content, and a change to the body does not set it. |
| `pinned` | Set by the owner. A folder set to sync "pinned only" holds just these ([13.5](13-05-sync-with-local-memory-files.md)). |
| `body` | The text, at most 8,000 characters, stripped of control characters on intake. Never interpreted: it is not HTML, a path or a command, and the console renders it as text nodes through the Markdown component. |
| `tags` | At most 10, each 1 to 40 characters of `a-z`, `0-9` and `-`. Free-form, lowercased on intake. Tags are the memory's categories, a first-class field that a search can require ([13.4](13-04-search-and-weight.md)). `type` and `project` are fields, not tags. |
| `state` | `active`, `flagged`, `trashed` or `deleted` ([13.2 States](#132-states)). |
| `version` | The id of the current version ([13.2 Versions](#132-versions)). |
| `weight`, `weight_at` | Derived from votes and use ([13.4](13-04-search-and-weight.md)). |
| `written_by` | The id of the agent whose call made the first version, or the person. Names are stored beside it for display only. |
| `approved_by` | For an `everyone` memory, the person or Admin who approved it into that scope, and when. For a copy made by an accepted share, the recipient. Empty for a `person` memory the owner or their own agent wrote. |
| `source` | For a copy made by an accepted share or a promotion, the id of the memory it came from, and for a share the version. |

A body or a resource never holds a secret. The server and the reporter refuse one that matches a secret pattern and name the pattern, never
the matched text. The reporter's `redactText` returns the redacted text and a count, and no pattern name, and it is not bounded for a long
single line, so this needs a new function in `plugin/core/` that returns the names of the patterns that matched and is
bounded, which the server then imports. That function is part of the first issue that writes a body.

## 13.2 Versions

Every change to `name`, `description`, `body`, `resources`, `tags` or `type` makes a new **version**: an id, the id of its parent
version, the author, the time (the server's clock, never a reporter's), the content, and a hash of the content. The author is
an agent of the owner, the owner, or a review proposal the owner approved ([13.6](13-06-the-reviewer.md)). An Admin is never an
author. A version has one parent, except the first, which has none, and a merge, which has two ([13.5](13-05-sync-with-local-memory-files.md)).
A person's local side of a conflict is stored as a version on a side branch, so that it has an id a mirror can name as its base.

Versions are the basis of sync and of the person's history. The server keeps the current version, every version a mirror
still names as its base, every version of the last 30 days, and the 20 most recent. It purges the rest with their text
([13.9](13-09-storage-limits-and-retention.md)).

## 13.2 States

- `active`: found by search and returned by `get`.
- `flagged`: a reviewer, a downvote with the reason `unsafe`, or a person's report marked it. It is still returned, with
  `flagged: true`. For an `everyone` memory it is hidden from search when an Admin confirms the flag, or when 3 different
  people (an Admin setting) have flagged it. A flag on a `person` memory is seen by its owner only.
- `trashed`: deleted by the owner, an agent of the owner, an Admin, or an approved review change, and **kept for 30 days with
  its text so that the owner can restore it**. A trashed memory is not searchable, is not returned by a tool, and counts as a
  delete for sync. The owner sees it in **Recently deleted** and can restore it in one click. An Admin cannot restore one.
- `deleted`: after the 30 days, or when a person is deleted, the body and every old version are purged and a **tombstone**
  stays: the id, the owner, the scope, the project, the time, who deleted it and why. It is kept for the tombstone retention
  ([13.9](13-09-storage-limits-and-retention.md)) so that a sync on another machine deletes its file and a restored database
  never brings the memory back. A tombstone has no text and cannot be restored. The person can make a new memory.

Removing a memory from search, tags, edges and the index happens in the same step as the state change ([13.4](13-04-search-and-weight.md)).

## 13.2 Edges

An edge links two memories: `related` (either direction) or `supersedes` (the first replaces the second). Only the owner
makes one, in the console or by approving a review `merge`. An Admin makes none. An edge changes a search result only when
both memories are readable by the reader and are in the same scope, so a private memory can never mark a shared one
`superseded` for anyone else. A traversal returns only memories the reader could read directly.

Edges are in the first schema so that adding them later is not a migration across three adapters. The first release writes
`supersedes`, and `related` from the links in a local file ([13.5](13-05-sync-with-local-memory-files.md)), and reads both.

## 13.2 Identity

Everything that names a person or an agent binds by id and never by name (DECISIONS 77).

- A person's memories are bound to `people.id`. When a person is deleted, their `person` memories are purged at once and leave
  tombstones, with no 30 days, because nobody could restore them and an Admin could read them only in silence. Their `everyone`
  memories stay with `owner` empty and the name kept as text, as DECISIONS 77 does for other rows, and nobody who takes the name
  later owns them.
- An agent is the id the server gave its session (`agent_ids`). A memory it wrote keeps that id in `written_by` after the
  session has ended.
- A reporter is the key the server already keeps, with its harness ([13.5](13-05-sync-with-local-memory-files.md)).

## Related

- [13.3 Who can read and write](13-03-who-can-read-and-write.md)
- [13.9 Storage, limits and retention](13-09-storage-limits-and-retention.md)

<!-- nav:start -->
---

Previous: [13.1 What the brain is](13-01-what-the-brain-is.md) · Up: [13. The brain](README.md) · Next: [13.3 Who can read and write](13-03-who-can-read-and-write.md)
<!-- nav:end -->
