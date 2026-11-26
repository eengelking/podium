---
title: "79. The brain keeps a person's memories on the server in two scopes, and every Admin read of one is told"
description: "Memories live on the server for a person or for everyone. An Admin may read and delete but never edit, and the person is always told."
group: "Project internals"
number: 79
date: "2026-11-25"
status: "proposed"
order: 79
---

# 79. The brain keeps a person's memories on the server in two scopes, and every Admin read of one is told

*Amends section 1 of the spec: it adds a goal, a sixth opt-in exception to the conversation-content rule, and lets the reporter write a harness's memory files when the person allows it. Builds on 28, 37 and 72 (consent), 63 (the Admin read registry), 69 (what an agent reads from public places) and 77 (binding by id).*

## Context

A harness writes an agent's memories as files on the machine the agent runs on. They do not follow the person to another machine, another harness or another project, so one person's agents know different things, and an agent cannot learn from what another agent learned. The maintainer wants one place where memories live once, are found by search, rank higher the more they help, and can be shared when the person chooses.

A shared store of text that agents read is also a channel. A memory one agent wrote can steer another, and one in a scope everyone reads can steer all of them. It holds a person's private notes as well, and PROJECT.md says an Admin never reads a person's non-public content in silence.

## Decision

- **The brain is a store on the Podium server, behind the storage adapter, in SQLite, PostgreSQL and MariaDB alike.** An agent reaches it only through tools `podium-reporter` registers. A person reaches it in the console. Search is an index in the server (81).
- **A memory has one of two scopes: `person` or `everyone`.** There is no memory per agent. A memory may belong to a project, an agent reads a project only when its owner granted it to the agent's reporter, and one with no project reaches all of the person's brain-enabled agents.
- **Everything is off until a person turns it on.** The Admin flag, the reporter's Brain switch in My reporters (only the owner sets it, as with the Admin's right to respond in 72), **Read shared memories** for the `everyone` scope, **Reviewer**, and **Sync** are each off by default. A session with no person behind it never has the brain.
- **An agent writes only `person` memories. A person or an Admin approves a promotion to `everyone`,** through a request of its own that nobody else can read. Every memory records the agent that wrote it and who approved it. An agent cannot start a share or a promotion.
- **Another person reads a memory only by an offer the owner starts and the recipient accepts,** bound to the version the sender chose, after reading its whole text under a prompt-injection warning. Accepting makes a copy the recipient owns.
- **An Admin reads and deletes, and never edits.** An Admin never writes or deletes a file on a person's machine. Each Admin read of a `person` memory, and each delete, tells the person in the console (a red notice and a permanent record line) and in `podium-reporter` (a callout the model never receives), kept for a person with no live session until they have seen it, and is recorded in the Admin log with who, whose and when, never the text. Reads of `everyone` memories are not told, because that scope is public to the server. Offers, conflicts, import lists, mirror state, access rules and the like are refused to an Admin.
- **A delete is kept for 30 days and can be restored.** After that the text is purged and a tombstone stays, so that the delete reaches other machines.
- **A review finds problem memories and flags them. It removes nothing.** At first an administrator runs it by hand, in their own harness, because Podium starts no agent, and a person may run one over their own memories. It reads a person's memories only with that person's permission, and a person approves each change it proposes.
- **The Admin approves a promotion, with the owner as the fallback.** A person names their own projects, which are git remotes by default, and an Admin can name them too, as a told read.
- **An agent reads a memory in steps:** search returns summaries, opening it returns the body and a list of resources, and each resource is opened on its own, so context holds only what is needed. Tags are categories a search can require.
- **Weight orders results and never hides one.** It is the sum of uses and votes that fade with time, computed lazily so that nothing runs on a timer. The amounts are Admin settings that apply from the change on, and a history with no person in it lets them be re-scored later.
- **The brain's tools and sync support three versions** by major and minor, and the rest of the reporter keeps its range.
- **Memories bind to `people.id` and agents to their ids,** never to a name (77).
- **What the switches do not do.** They choose which reporters may use the brain and keep a cooperative agent to its projects. Like the switches for chat and messaging, they do not stop a hostile process on the person's machine that can read the person's token. That limit is accepted for the first version. The acts that must come from a human are console acts.

The rules are in SPEC 13, the sync with local files is decided in 80 and search in 81.

## Why

- One copy on the server is the only way a memory reaches a second machine or a second harness without each pair of machines syncing with each other.
- Two scopes are enough for what was asked, and a third kind (a team, an agent) would double the places a read has to be checked. A project field does the job a smaller scope was wanted for.
- Everything off by default is how the repository already treats anything that acts for a person (answering, messaging, recording), and the brain adds a store that agents read and files that are written, so each of those is its own choice.
- A memory is content. Making every Admin read of one told, with no quiet path, keeps the rule the repository already holds, and the registry (63) fails the build on a read that has no entry. An Admin who cannot edit cannot decide what enters a person's sessions, which 37 says no Admin should.
- Provenance and approval are the answer to a shared channel: when a bad memory is found, the log says which agent wrote it and who let it into the scope.
- A reviewer that only flags cannot be turned into a way to delete other people's work.
- Keeping a deleted memory for 30 days means an Admin's delete, an agent's tidy-up and a person's mistake can all be undone.
- An opt-in `everyone` scope keeps what agents take in from a shared place small and chosen, which is the aim of 69's call-in rule for Chat.

## Alternatives

- **A graph database, or graph tables with a traversal.** Rejected for the first version: the questions asked of memories are "find the ones about this" and "which are worth reading", which a search answers. Edges are in the schema so that a traversal can come later without a migration in three adapters.
- **A memory per agent, and a team scope.** Rejected: the maintainer's agents on two machines are one person's, and no case needs a memory that one agent alone may read.
- **Put recalled memories into the prompt automatically.** Rejected for the first version: it makes a memory an instruction without the agent choosing to read it, which is the injection path this decision tries to close. Sync writes files the harness may load, and the person is told so and has approved what is written.
- **Let an Admin edit a person's memory.** Rejected by the maintainer: an Admin's power exists to stop a failure, and reading and deleting do that.
- **Let agents write to `everyone` directly.** Rejected: one confused or compromised session would write to every other person's agents.
- **Require a credential the agent cannot read for brain calls.** Not for the first version: it is not possible on every harness, and the same limit applies to chat today.

## Cost

- A new store of private content to protect, and a new Admin read surface with its notices in two places, which every new route has to keep. The registry check does not see memory fields today, so extending it is the first issue.
- A person has more switches to turn on, one by one, before anything works.
- Sync writes files on the person's machine, which Podium has never done. That is its own option and its own guards, and it needs each harness's memory format and file API read first.
- An Admin cannot fix a bad memory except by deleting it, and cannot help a person who asks for a memory to be edited.
- A harness may load synced files into every session. The person has approved what is written there, and the reviewer is the second line, and a memory a person approved can still be wrong.
- A hostile process on the person's machine that has their token can use their reporter's access. That is the limit the existing features have too.

<!-- nav:start -->
---

Previous: [78. An adapter may differ in physical layout when the difference is declared, checked and changes no data a store call can see (#1296)](78-an-adapter-may-differ-in-physical-layout-when-the-difference-is-declared-and-checked.md) · Up: [Decisions](README.md) · Next: [80. Memories sync by version chain with a three-way merge, and a conflict is kept and asked](80-memories-sync-by-version-chain-with-a-three-way-merge-and-a-conflict-is-kept-and-asked.md)
<!-- nav:end -->
