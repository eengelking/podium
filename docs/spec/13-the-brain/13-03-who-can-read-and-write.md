---
title: "13.3 Who can read and write"
description: "Projects and membership through groups, personal and shared memories, sharing and approval of changes, and what an Admin may read and delete."
group: "Reference"
section: "13.3"
order: 3
---

# 13.3 Who can read and write

Two rules govern this page.

1. **Every memory belongs to a project,** and a person or an agent is shown only the memories of the project it is working on.
   The one exception is a **Global** memory, which belongs to no project and holds a person's own preferences.
2. **An Admin never reads in silence** (PROJECT.md). Whenever an Admin sees a memory of a person, personal or shared, that
   person is told in the console and in `podium-reporter`, and the Admin log records who, whose and when, never the text. An
   Admin reads and deletes. An Admin never edits a memory and never touches a person's machine.

## 13.3 Projects

A **project** is anything one or more people work on. Today that is often one person with many agents, and later many people
with many agents. A project belongs to nobody: there is **one project per name on the server**, used by everyone who works in it.

- **A project is identified by the repository's name alone.** For `git@github.com:eengelking/podium.git` the project is
  `podium`. A fork (`foobar/podium`) is the same project, so a fork keeps access. Names are compared ignoring case. Two
  unrelated repositories with one name are one project too, which is accepted. What that cannot do is open another person's
  memories to a stranger: shared memories need membership.
- **An agent holds the project of the repository it works in, automatically,** the way Claude Code keeps a memory folder for a
  repository. Move to another repository and the project and its memories change with it. Nobody grants it, and an agent holds
  one project at a time.
- **A directory with no git remote has a project only when a person names it.** In **My reporters** the person maps a working
  directory to a project name ([13.8](13-08-the-console.md)). An Admin can name projects too. This includes a git repository
  with no remote. Until it is named, an agent there reads and writes only Global memories.
- **A name that someone types is letters, digits and hyphens, at most 60 characters,** because a name is shown to agents and
  must not be a way to put words in front of them. A name taken from git is letters, digits, `.`, `_` and `-`, at most 100.
- **Renaming a project changes the name shown to everyone,** like renaming a channel in Slack, with no notice. The repository
  name still finds it. A member of the project or an Admin renames it.
- **A project's name is not private content.** An Admin lists projects without a notice. A person sees the projects they are a
  member of and the ones they have memories in.
- **A project that holds memories cannot be deleted.**

The server takes a session's project from what the session's reporter reports about its directory, **never from a tool's
argument**. The reporter sends the repository name from the `origin` remote as its own field, or nothing, so the server never
mistakes a folder's name for a repository's.

## 13.3 Members and groups

**An Admin decides who is a member of a project, by assigning the project to groups.** A person's projects are everything
their groups are assigned. There is no separate adding of single people, and a person never joins by having a folder of the
right name.

**A person can be in as many groups as needed.** Today a person is in at most one (`people.group_id`), so this is a change to
Podium itself and not only to the brain. It is built and released as its own change, before shared memories, with the schema
change in every adapter. Where one group is expected today:

- a person has a **My group** chat for each group they are in;
- a person appears under each of their groups in the console;
- a person is in Administrators, with what that gives, when any of their groups is Administrators.

**A person who is not a member still has their own memories there.** In a repository whose project no one is assigned to yet,
personal memories work. Sharing starts when an Admin assigns the project.

**A person who stops being a member** no longer reads the project's shared memories. What they shared stays shared. They can
still see and delete their own, and can no longer change what members see.

## 13.3 Personal and shared

A memory is **personal** (only its owner and the owner's agents) or **shared** (the members of its project). There is no scope
that reaches everyone on the server. If everyone works on one project, that project's members are everyone.

A **Global** memory belongs to no project. It is personal only, of the type `user` or `feedback`, and is returned in every
project, because it is about the person. It cannot be shared or offered.

| Reader | Personal memory | Shared memory | Global memory |
|---|---|---|---|
| The owner, in the console | Reads, edits, votes, deletes, restores, shares | Reads, edits, votes, deletes, restores, approves changes | Reads, edits, votes, deletes, restores |
| The owner's agent, through a tool, in that project | Reads and votes. Writes | Reads and votes. Writes, and the owner approves the change | Reads and votes. Writes |
| The owner's agent, in another project | Never | Never | Reads and votes. Writes |
| Another member, or their agent | Never, except a copy offered and accepted | Reads the approved text, votes and flags. Never edits | Never |
| A person who is not a member | Never | Never | Never |
| An Admin, in the console | Reads and deletes, and the owner is told | Reads and deletes, and the owner is told | Reads and deletes, and the owner is told |

The server decides the reader from the credential and the agent id it gave the session, never from an argument the agent
sends. A call that names a memory the reader may not read answers `404`, the same as one that does not exist, so the id of a
private memory is not confirmed to anyone.

## 13.3 Writing and sharing

- **An agent writes personal memories.** A new memory goes into the project the agent works in, unless the agent asks for a
  Global one and its type allows it. In a directory with no project, only a Global memory can be saved. It needs the
  reporter's Brain switch at `readwrite`.
- **A person shares a memory with its project in one action,** in the console. There is no request to approve and no copy: the
  same memory becomes shared. The person must be a member. An agent cannot share. It can only say in its reply that a memory
  might be worth sharing.
- **A shared memory stays shared.** It never has to be shared again, and members get each approved change. There is no
  unshare, and a shared memory is not moved to another project. Its owner can delete it, and a restore by the owner brings
  it back shared.
- **An agent changes only its own owner's memories.** Another member's agent votes or flags.

### Changes to a shared memory

**When an agent changes a shared memory, the owner approves the change.** Members see the previous version until then. A
change the owner makes themselves in the console takes effect at once.

- A shared memory has a **current version**, which its owner and the owner's agents see and sync, and a **shared version**,
  which members see. They differ only while a change waits.
- **Anything that arrives through the reporter counts as an agent's change,** whether a tool call or a synced file, because
  the server cannot tell a person's edit of a local file from an agent's. Only an act in the console is the owner's own.
- The owner sees the change as a diff under **Waiting for you** in My memories and gets a person-only callout. **Approve**
  makes the current version the shared one. **Reject** makes a new version with the shared version's content, which a sync
  writes back to the owner's file.
- **An agent's delete of a shared memory waits the same way.** Members keep it until the owner approves.
- An owner who saves an edit in the console while a change waits sees both and publishes the text they see.
- A change to a personal or Global memory takes effect without approval.

Every shared memory shows who wrote it, which agent, who shared it, and when its shared version was approved.

**Sharing warns about addresses and paths.** When the text holds a network address or a home folder path, the console says so
before the person shares or offers it. It is a warning and does not block.

## 13.3 Offering a memory to one person

A person can give one of their project memories to one other **member of the same project**, without sharing it with the whole
project. It is an **offer**, not a copy.

1. The sender picks a memory and a recipient, from the memory's menu or its right-click menu ([13.8](13-08-the-console.md)). Only
   a person starts an offer. An agent cannot.
2. **The offer is bound to the version the sender picked.** It holds a copy of that version's text for the offer's life, so what
   the recipient reads and accepts is what the sender chose.
3. The offer is visible to the recipient in the console only, in their inbox. No tool returns it and it is not searchable
   until the recipient accepts.
4. The recipient reads the whole text under a warning that the text comes from another person and may try to steer an agent
   (a prompt injection), and then accepts, declines or ignores it.
5. **Accepting** says in plain words that the memory will be saved with the recipient's memories, may be written into their
   local memory files and may be loaded by the harness into their sessions. It makes a copy: a new personal memory of the same
   project, owned by the recipient, with `source` set to the original and its version, the sender as author and the recipient
   as approver. The sender's later edits or deletes do not reach the copy.
6. The sender can withdraw an offer until it is accepted. An offer that is not answered in 30 days expires. It is voided if the
   recipient is deleted or stops being a member.

A sender holds at most 20 open offers, and a recipient can block a sender, after which the sender's offers to them are
accepted by the route and go nowhere. The text of an offer is never visible to an Admin.

## 13.3 An Admin

An Admin needs to be able to read and delete memories for security reasons, and the guardrail is that the person is told every
time.

| Surface | An Admin | Registry entry |
|---|---|---|
| The list of projects, their names and the groups assigned to them | Lists, names, renames, assigns | not content |
| The list of one person's memories (names, descriptions, tags), after choosing the person | Reads. The owner is told that the list was opened | `told` |
| The shared memories of one project (names, descriptions, tags) | Reads. Every author whose memory is listed is told | `told` |
| One memory, personal, shared or Global: its text, versions and any waiting change | Reads. The owner is told | `told` |
| Deleting a memory | Moves it to the trash, with a reason the owner is shown. The owner is told, with who did it, and can recover it for 30 days. The Admin cannot restore it | `told` |
| Purging a memory at once because it holds an exposed secret | Purges its text and every version immediately, for that reason only. The owner is told those words | `told` |
| Offers, conflicts, import lists, mirror state, a person's directory rules, votes and their reasons, review logs of personal memories, search terms | Refused | `owner-only` |
| A person's counts (memories and trashed) | Reads. A count carries nothing a person wrote. There is no count of flags | not content |

- **An Admin has no search, tag filter or sort over memories.** Opening a list is a told read, and so is each memory.
  Otherwise a filter would reveal content one question at a time.
- **An Admin who is a member of a project reads its shared memories like any member, and each author is still told,** whether
  the Admin read in the console or the Admin's agent was shown it by a tool. The rule has no exception. Callouts may group
  several reads into one, and the record lists each.
- **An Admin who reads a session sees what its agent was shown.** The server records which shared memories of other people a
  session was shown by a search or opened, and when an Admin reads that session's conversation, recording or answers, those
  authors are told too.
- **A flag on a personal memory goes to its owner only,** and never to an Admin queue.
- **How the person is told.** In the console a red notice on the memory names the Admin while the read is live, and a permanent
  record line, never holding the text, stays with the memory's history. `podium-reporter` shows the person an obvious callout in
  the session, built as the other person-only notices are, and it is never sent to the model. A person with no live session is
  told the way DECISIONS 69 closed that gap (#1328): the act is kept on the person's own `act:` thread with its words, owed
  until they have seen it, and shown in the reporter of their next session on any reporter.
- **An Admin's delete trashes the memory** ([13.2](13-02-the-memory.md)). It never deletes a file on a person's machine. A sync
  that finds the memory gone leaves the local file where it is, drops its entry, and tells the person
  ([13.5](13-05-sync-with-local-memory-files.md)). A shared memory an Admin trashed comes back **personal** when its owner
  restores it, and sharing it again is the owner's act.
- **An Admin cannot turn the notice off,** and no read is quiet for being brief, automated or done with the admin secret.
- **A purge for an exposed secret is logged as one.** The Admin log entry says who, whose, which memory, when, and "purged for
  an exposed secret", never the text, and the tombstone records the same reason. The owner is told in the same words. A purge
  does not reach files already on a person's machine or copies others accepted, and the notice says so, so the secret is also
  rotated.
- **Search terms are never logged,** so log shipping cannot carry a person's queries to an Admin.

Each route that returns memory content, a version, an offer, a conflict, a proposal or an import list has an entry in
`adminReads.registry.ts` ([DECISIONS 63](../../decisions/63-a-route-that-returns-a-persons-content-must-be-listed-in-a-registry-or-the-build-fails.md)).
A route a member calls that returns another person's shared memory is `told` when the caller is an Admin. The registry check
does not see memory fields today, so extending it is the first issue and ships before any route ([13.9](13-09-storage-limits-and-retention.md)).

## Related

- [13.6 The reviewer](13-06-the-reviewer.md)
- [7.7 Hardening](../07-server/07-07-hardening.md), where the routes' gates are listed once built.

<!-- nav:start -->
---

Previous: [13.2 The memory](13-02-the-memory.md) · Up: [13. The brain](README.md) · Next: [13.4 Search and weight](13-04-search-and-weight.md)
<!-- nav:end -->
