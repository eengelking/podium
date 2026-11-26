---
title: "13.3 Who can read and write"
description: "Scopes, projects and grants, promotion, sharing one memory with another person, and what an Admin may read and delete and how the person is told."
group: "Reference"
section: "13.3"
order: 3
---

# 13.3 Who can read and write

The rule that governs this page is PROJECT.md's "An Admin never reads in silence": whenever an Admin sees a person's
non-public content, that person is told, in the console and in `podium-reporter`, and the Admin log records who, whose and
when, never the text. A memory in the `person` scope is non-public content. A memory in the `everyone` scope is public to the
server, and an Admin's read of it is not told. An Admin reads and deletes. An Admin never edits a memory and never touches a
person's machine.

## 13.3 Who reads what

| Reader | `person` memory | `everyone` memory |
|---|---|---|
| The owner, in the console | Reads, edits, votes, deletes, restores, shares, promotes | Reads and votes. Edits and deletes only a memory they made |
| The owner's agent, through a tool | Reads and votes when its reporter holds the memory's project, or the memory has none. Writes only through `podium_brain_save` | Reads and votes, only when the person turned on **Read shared memories**. Cannot edit or delete |
| Another person, or their agent | Never, except a copy the owner shared and the person accepted ([13.3 Sharing](#133-sharing)) | Reads and votes, only when that person turned on **Read shared memories** |
| An Admin, in the console | Reads and deletes, and every one of those tells the owner ([13.3 An Admin](#133-an-admin)). Never edits | Reads, and deletes. The owner is told of a delete. Never edits |
| A review run | Only what [13.6](13-06-the-reviewer.md) allows: for a person's memories, that person's own run, or an Admin's run after that person turned on **Reviewer** | Reads and flags |

An agent's tool call reaches only what its owner could reach. The server decides the reader from the credential and the agent id
it gave the session, never from an argument the agent sends. A call that names a memory the reader may not read answers
`404`, the same as one that does not exist, so the id of a private memory is not confirmed to anyone.

**Read shared memories is off by default and is the person's choice.** With it off, `search` and `get` never return an
`everyone` memory to that person's agents, and the person's own console still shows the scope. This keeps what agents take in
from public places small and chosen, as DECISIONS 69 does for Chat, where an agent reads only when it is called in.

## 13.3 Projects and the grant

A **project** has an id and a name. It belongs to the person, and two people's projects of one name are different projects.
**By default a project is a git remote**, so the same repository is one project on every machine. A directory with no git
remote is a project that is named by hand. The person names and renames their projects, and an Admin can name and rename them
too. A person's project names are their content: **an Admin who lists, names or renames them is a told read**
([13.3 An Admin](#133-an-admin)). Nobody else sees them.

A person manages a reporter's access in **My reporters** ([13.8](13-08-the-console.md)), next to its Brain switch:

- **A directory rule.** The person maps a working directory, or a git remote, to a project. A reporter's agent that starts in that
  directory holds that project. **The same rule decides which memory folder the harness uses for that directory** ([13.5](13-05-sync-with-local-memory-files.md)), so an
  agent's project and its folder's project can never differ. A rule matches by the longest path prefix, and two rules that
  match equally are refused when they are saved.
- **A grant.** The person grants a reporter one or more further projects, which every agent of that reporter holds, whatever its
  directory.

An agent that holds no project reads and writes only the owner's memories that have no project. A memory with no project is for
every brain-enabled agent of the person, and is where a `user` or `feedback` memory that applies everywhere belongs. The
person chooses a project for each memory when it is made, and `podium_brain_save` takes the project from the rule or grant
that applies, never from the agent's own claim. When an agent holds several projects, the tool names which one, and a name the
agent does not hold is refused. Only the owner edits Access.

When a grant is revoked or a rule changes, the agent stops reading the project at its next call and the files already written
stay on the machine, as [13.5](13-05-sync-with-local-memory-files.md) describes. Deleting a project asks the person what to do with its memories: move
them to no project or move them to the trash.

## 13.3 Writing, promotion and approval

- An agent writes only `person` memories, only into a project it holds or none, and only when its reporter's Brain switch is
  `readwrite`.
- Nobody writes an `everyone` memory directly. A person **promotes** one of their own `person` memories. That makes a
  **promotion request**: a record of its own, readable by the owner and by the Admin who decides, and not in the `everyone`
  scope. Nobody else sees it, and it is not searchable, until it is approved. Approving makes a copy in the `everyone` scope
  with `source` set to the original, `written_by` the original's writer, and `approved_by` the approver. The original stays.
- **The Admin approves, with the owner as the fallback.** The setting in Admin > Settings is `admin` (the default) or `owner`.
  With `admin`, an Admin decides each request in Admin > Memories, and has to read the text to do it, so the owner is told.
  The owner may approve only when the setting is `owner`, or when no Admin is available, which the draft reads as a request
  that has waited longer than the fallback time (7 days by default) with no Admin decision ([13.10](13-10-open-questions.md)). With
  `owner`, the person's own promotion is the approval.
- An agent cannot make a promotion request. It can only say in its reply that a memory might be worth sharing, and the person
  decides. There is no tool for it.
- Every `everyone` memory shows who wrote it, which agent, and who approved it and when.
- A promoted memory is a copy. A later edit to the original does not change it, and the owner can withdraw it at any time, which
  trashes it.

**A share or a promotion warns about addresses and paths.** When the text holds a network address or a home folder path, the
console says so before the person sends the offer or the request. It is a warning and does not block.

## 13.3 Sharing

A person shares one of their memories with one other person. It is an **offer**, not a copy.

1. The sender picks a memory and a recipient, from the memory's menu or its right-click menu ([13.8](13-08-the-console.md)). Only
   a person starts an offer. An agent cannot.
2. **The offer is bound to the version the sender picked.** It holds a copy of that version's text for the offer's life, so what
   the recipient reads and accepts is what the sender chose, and a later edit by the sender changes nothing in the offer.
3. The offer is visible to the recipient in the console only, in their inbox. It is not visible to the recipient's agents, it
   is not searchable, and no tool returns it, until the recipient accepts.
4. The recipient reads the whole text under a warning that the text comes from another person and may try to steer an agent
   (a prompt injection), and then accepts, declines or ignores it.
5. **Accepting asks for a project** (or none) and says in plain words that the memory will be saved with the recipient's
   memories, may be written into their local memory files, and may be loaded by the harness into their sessions. Accepting makes
   a copy: a new `person` memory owned by the recipient, with `source` set to the original and its version, the sender recorded as
   the author, and the recipient recorded as the approver. The sender's later edits or deletes do not reach the copy.
6. The sender can withdraw an offer until it is accepted. An offer that is not answered in 30 days expires. An offer to a person
   who is then deleted is voided.

Limits: a sender holds at most 20 open offers, and a recipient can block a sender, after which the sender's offers to them
are refused without saying why. The text of an offer is never visible to an Admin.

## 13.3 An Admin

An Admin needs to be able to read and delete memories for security reasons, and the guardrail is that the person is told every
time.

**What an Admin can reach**

| Surface | An Admin | Registry entry |
|---|---|---|
| An `everyone` memory: its record and versions, and a review proposal against it | Reads, no notice | `open`, for the reason in DECISIONS 69 |
| The `everyone` memories flagged for review | Reads, and may hide or clear | `open` |
| A promotion request | Reads the text to decide. The owner is told | `told` |
| The list of one person's `person` memories (names, descriptions, tags, project names), after choosing the person | Reads. The owner is told that the list was opened | `told` |
| One `person` memory: its text and versions | Reads. The owner is told | `told` |
| Deleting a `person` memory, or an `everyone` memory | Moves it to the trash, with a reason the owner is shown. The owner is told, with who did it, and can recover it for 30 days. The Admin cannot restore or purge it early | `told` |
| A person's project names | Lists, names and renames them | `told` |
| Offers, conflicts, import lists, mirror state, review logs of `person` memories, a person's access rules, votes and their reasons on `person` memories, search terms | Refused | `owner-only` |
| A person's counts (memories, trashed, flagged) | Reads. A count is already on the wall for everyone | not content |

- **An Admin has no search, tag filter or sort over `person` memories.** Opening the list of one person is a told read, and so
  is each memory. Otherwise a filter would reveal content one question at a time.
- **A flag on a `person` memory goes to its owner only,** and never to an Admin queue, so an agent that flags many of its
  owner's memories cannot fill an Admin's queue with another person's content.
- **How the person is told.** In the console a red notice on the memory names the Admin while the read is live, and a permanent
  record line, never holding the text, stays with the memory's history. `podium-reporter` shows the person an obvious callout in
  the session, built as the other person-only notices are, and it is never sent to the model. A person with no live session is
  told the way DECISIONS 69 closed that gap (#1328): the act is kept on the person's own `act:` thread with its words, owed
  until they have seen it, and shown in the reporter of their next session on any reporter. The Admin log records who, whose and when.
- **An Admin's delete trashes the memory** ([13.2](13-02-the-memory.md)) and the owner can restore it for 30 days. It never deletes a
  file on a person's machine. A sync that finds the memory gone leaves the local file where it is, drops its entry, and tells the
  person ([13.5](13-05-sync-with-local-memory-files.md)).
- **An Admin cannot turn the notice off,** and no read is quiet for being brief, automated or done with the admin secret.
- **Reading another person's `person` memory through a tool is refused to an Admin,** with one exception: a review run the
  Admin started, over a person who turned on **Reviewer**. Every such read is a told read, as in the console ([13.6](13-06-the-reviewer.md)).
  Otherwise the tools answer the session's owner only.
- **Search terms are never logged,** so log shipping cannot carry a person's queries to an Admin.

Each route that returns memory content, a version, an offer, a proposal, a conflict or an import list has an entry in
`adminReads.registry.ts` ([DECISIONS 63](../../decisions/63-a-route-that-returns-a-persons-content-must-be-listed-in-a-registry-or-the-build-fails.md)).
That check does not see memory fields today, so extending it is the first issue and ships before any route ([13.9](13-09-storage-limits-and-retention.md)).

## Related

- [13.6 The reviewer](13-06-the-reviewer.md)
- [7.7 Hardening](../07-server/07-07-hardening.md), where the routes' gates are listed once built.

<!-- nav:start -->
---

Previous: [13.2 The memory](13-02-the-memory.md) · Up: [13. The brain](README.md) · Next: [13.4 Search and weight](13-04-search-and-weight.md)
<!-- nav:end -->
