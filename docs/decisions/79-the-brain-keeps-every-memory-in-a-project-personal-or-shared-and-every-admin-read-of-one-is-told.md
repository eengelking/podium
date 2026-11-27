---
title: "79. The brain keeps every memory in a project, personal or shared, and every Admin read of one is told"
description: "Memories live on the server, each in a project, personal or shared with its members. An Admin may read and delete but never edit, and the author is told."
group: "Project internals"
number: 79
date: "2026-11-25"
status: "proposed"
order: 79
---

# 79. The brain keeps every memory in a project, personal or shared, and every Admin read of one is told

*Amends section 1 of the spec: it adds a goal, a sixth opt-in exception to the conversation-content rule, and lets the reporter write a harness's memory files when the person allows it. Builds on 28, 37 and 72 (consent), 63 (the Admin read registry), 69 (how an owed notice reaches a person) and 77 (binding by id).*

## Context

A harness writes an agent's memories as files on the machine the agent runs on. They do not follow the person to another machine or harness, and what one person's agents learned about a project never reaches the others working on it. The maintainer wants one place where memories live once, are found by search, rank higher the more they help, and are shared across machines, people and teams, for the same project.

A memory is usually true of one project and can be false in another. A shared store of text that agents read is also a channel: a memory one agent wrote can steer another person's. It holds private notes as well, and PROJECT.md says an Admin never reads a person's non-public content in silence.

## Decision

- **The brain is a store on the Podium server, behind the storage adapter, in SQLite, PostgreSQL and MariaDB alike.** An agent reaches it only through tools `podium-reporter` registers. A person reaches it in the console. Search is an index in the server (81).
- **Every memory belongs to a project, and a person or an agent is shown only the memories of the project it is working on.** A project is anything one or more people work on, one per name on the server, identified by the repository's name alone, so a fork is the same project. An agent holds it automatically from the repository it works in. A directory with no git remote is named by hand.
- **A Global memory belongs to no project,** is personal only and holds preferences (`user` and `feedback`).
- **A memory is `personal` or `shared`** with the members of its project. No scope reaches the whole server, and there is no memory per agent or owned by a group.
- **An Admin decides membership by assigning projects to groups, and a person can be in as many groups as needed.** Today a person is in at most one, so many groups is its own change to Podium, made first.
- **An agent writes personal memories, and its person shares one with the project in one action.** A shared memory stays shared.
- **An agent's change to a shared memory waits for the owner's approval,** and members see the previous version until then. The owner's own edit in the console applies at once. Anything that arrives through the reporter counts as an agent's change.
- **Everything is off until a person turns it on.** The Admin flag, the machine's option, the reporter's Brain switch in My reporters (only the owner sets it, as with the Admin's right to respond in 72), **Reviewer** and **Sync** are each off by default. A browser alone never turns on the writing of files. A session with no person behind it never has the brain.
- **A memory can be offered to one other member,** bound to the version the sender chose, accepted after reading its whole text under a prompt-injection warning. Accepting makes a copy.
- **An Admin reads and deletes, and never edits.** An Admin never writes or deletes a file on a person's machine. Every Admin read of a person's memory, personal or shared, tells that person in the console (a red notice and a permanent record line) and in `podium-reporter` (a callout the model never receives), kept for a person with no live session until they have seen it, and is recorded in the Admin log with who, whose and when, never the text. This holds for an Admin who is a member of the project, and for an Admin who reads a session that was shown another person's shared memory.
- **A delete is kept for 30 days and can be restored,** except a purge of an exposed secret, which an Admin may make at once and which is logged and told as exactly that.
- **A review finds problem memories and flags them. It removes nothing.** A project member runs it by hand in their own harness, because Podium starts no agent. A person approves each change.
- **An agent reads a memory in steps:** search returns summaries, opening it returns the body and a list of resources, and each resource is opened on its own. Tags are categories a search can require.
- **Weight orders results and never hides one.** It is the sum of uses and votes that fade with time, computed lazily. The amounts are Admin settings that apply from the change on, and a history with no person in it lets them be re-scored later.
- **The brain's tools and sync support three versions** by major and minor, and the rest of the reporter keeps its range.
- **Memories bind to `people.id` and agents to their ids,** never to a name (77).
- **What the switches do not do.** They choose which reporters may use the brain and keep a cooperative agent to its project. They do not stop a hostile process on the person's machine that can read the person's token. That limit is accepted for the first version.

The rules are in SPEC 13, the sync with local files is decided in 80 and search in 81.

## Why

- One copy on the server is the only way a memory reaches a second machine, a second harness or a second person without every pair of machines syncing with each other.
- The project is what makes a memory true. Showing only the current project's memories keeps an agent from applying one repository's facts to another, and keeps its context small.
- The repository's name is what two machines, two clones and a fork have in common, and an agent can hold it with nobody setting anything up, as a harness already does with its memory folder.
- Membership by group gives a name no power by itself: a folder called `podium` opens no shared memory to a stranger.
- Approval of an agent's change is the guard on a shared channel. Text an agent picked up cannot reach other people's agents until the memory's owner has seen the diff.
- Everything off by default is how the repository already treats anything that acts for a person, and the brain adds a store that agents read and files that are written.
- A memory is content. Making every Admin read of one told keeps the rule the repository already holds, and the registry (63) fails the build on a read that has no entry.
- A reviewer that only flags cannot be turned into a way to delete other people's work.

## Alternatives

- **Two scopes, a person's and everyone's, with an Admin approving each promotion.** The first draft. Rejected by the maintainer: a memory is tied to a project, and sharing is about the people who work on it.
- **Identify a project by `owner/name`.** Rejected: a fork would lose the project's memories.
- **Let the repository name alone make a member.** Rejected: anyone with a folder of that name would join.
- **An Admin approves what is shared.** Rejected: the maintainer wants sharing to be democratic, and every read an approval needs would be a told read.
- **Let an agent's change to a shared memory apply at once.** Rejected: one confused or compromised session would write to other people's agents.
- **A graph database, or graph tables with a traversal.** Rejected for the first version: the questions asked of memories are "find the ones about this" and "which are worth reading", which a search answers. Edges are in the schema so that a traversal can come later.
- **Put recalled memories into the prompt automatically.** Rejected for the first version: it makes a memory an instruction without the agent choosing to read it.
- **Let an Admin edit a memory.** Rejected by the maintainer: an Admin's power exists to stop a failure, and reading and deleting do that.

## Cost

- A person in several groups touches Podium beyond the brain: the database in every adapter, Admin, how the console arranges people, and My group.
- Two unrelated repositories with one name are one project. Members of one see shared memories of the other, and renaming a repository leaves its memories under the old name.
- A project's server cannot check which repository a session is really in. A process holding a person's token can claim any project the person is a member of.
- A new store of private content, and a new Admin read surface with its notices in two places. An Admin who works in a shared project causes a notice for each author they or their agent read. The registry check does not see memory fields today, so extending it is the first issue.
- A shared memory with a waiting change has two live texts, in the store and in the index.
- An owner who does not approve leaves members on old text.
- A harness may load synced files into every session. What is synced is the person's own, and can still be wrong.

<!-- nav:start -->
---

Previous: [78. An adapter may differ in physical layout when the difference is declared, checked and changes no data a store call can see (#1296)](78-an-adapter-may-differ-in-physical-layout-when-the-difference-is-declared-and-checked.md) · Up: [Decisions](README.md) · Next: [80. Memories sync by version chain with a three-way merge, and a conflict is kept and asked](80-memories-sync-by-version-chain-with-a-three-way-merge-and-a-conflict-is-kept-and-asked.md)
<!-- nav:end -->
