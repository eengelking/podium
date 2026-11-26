---
title: "13.1 What the brain is"
description: "The goals of the brain, the consent it needs (all off until a person turns each on), what the switches protect against, and what it must not become."
group: "Reference"
section: "13.1"
order: 1
---

# 13.1 What the brain is

## 13.1 Goals

1. A person's agents on every machine and in every harness read and write one set of memories, so what an agent learned on
   one machine is there on the next.
2. A memory is found by search, with the matching memories ordered by how well they match and how useful they have been
   ([13.4](13-04-search-and-weight.md)).
3. A memory belongs to one of two scopes: **person** (the person, and the agents the person allows) or **everyone** (every
   person who chose to read shared memories). There is no scope that one agent alone owns, because a person's agents are one
   person's memory ([DECISIONS 79](../../decisions/79-the-brain-keeps-a-persons-memories-on-the-server-in-two-scopes-and-every-admin-read-of-one-is-told.md)).
4. A memory can belong to a **project**, and an agent reads a project only when its owner granted it ([13.3](13-03-who-can-read-and-write.md)).
5. A person can share one memory with one other person. The other person reads it and accepts it before it is theirs
   ([13.3](13-03-who-can-read-and-write.md)).
6. A person sees, edits, votes on, deletes and restores every memory their agents wrote, in the console ([13.8](13-08-the-console.md)).
7. Local memory files and the brain converge in both directions, and a conflict is kept for the person to resolve, never
   decided silently ([13.5](13-05-sync-with-local-memory-files.md)).
8. Every memory records which agent wrote it and who approved it into the scope it is in. An Admin can read and delete a
   memory, never edit one, and every such act tells the person ([13.3](13-03-who-can-read-and-write.md)).
9. A review, run by hand by an Admin or by the person, flags problem memories for a person to remove ([13.6](13-06-the-reviewer.md)).
10. An agent reads a memory in steps, summary first, so its context holds only what it needs ([13.4](13-04-search-and-weight.md)).

## 13.1 Consent

Everything is off until someone turns it on, as responding, messaging and the Admin's right to respond are (DECISIONS 28, 37, 72).

1. **The Admin** turns on **Brain** in Admin > Settings.
2. **The person**, for each reporter in My reporters, sets **Brain** to `off` (the default), `read` or `readwrite`. Only the
   reporter's owner sets it, the way only the owner gives an Admin the right to respond (DECISIONS 72). A person who has
   several reporters allows each one on purpose.
3. **The person** also decides, each one off by default: **Read shared memories** (the `everyone` scope, [13.3](13-03-who-can-read-and-write.md)),
   **Reviewer** ([13.6](13-06-the-reviewer.md)), and for a reporter **Sync** (`brainSync`: `off`, `pull` or `both`,
   [13.5](13-05-sync-with-local-memory-files.md)), because sync writes files on the person's machine.
   **The machine has the last word.** A reporter also has its own options, `brain` (`off` by default, `read` or
   `readwrite`) and `brainSync` (`off`, `pull` or `both`), set on the machine as other reporter options are. What a session may
   do is the lower of the machine's option and the console's switch, so a browser alone can never turn on the writing of files.
4. **The scope** of what a reporter's agents reach is the projects the person granted to that reporter, or mapped to a working
   directory ([13.3](13-03-who-can-read-and-write.md)). A grant narrows what is reachable. It does not turn anything on.

A session with no person behind it (the admin secret, or an unassigned session on a server with no person tokens) never has
the brain, whatever the switches say. An unauthenticated browser never sees a memory, and an unauthenticated harness never
reaches one.

Turning the Admin flag off stops every tool call and every sync at once and keeps the data. Turning a reporter's switch off
stops that reporter's calls and keeps its mirror state. Neither deletes a memory.

## 13.1 What the switches protect against

The switches decide which reporters may use the brain at all, and a person turns on only the ones they trust. Within a reporter
the project grants keep a cooperative agent to its projects. Like the switches for chat and messaging, they do not stop a hostile
process on the person's own machine that can read the person's token. That limit is accepted for the first version and is
stated in [DECISIONS 79](../../decisions/79-the-brain-keeps-a-persons-memories-on-the-server-in-two-scopes-and-every-admin-read-of-one-is-told.md).
The acts that must come from a human (accept an offer, approve an import or a promotion, start a review run, restore a memory)
are console acts, and no tool offers them. That is not a security boundary: a person's token also signs in to the console
([7.7](../07-server/07-07-hardening.md)), so a hostile process that holds the token can perform them too.

## 13.1 Non-goals

- **The brain is not a transcript store.** It holds notes an agent or a person wrote on purpose. It never receives a
  conversation, a prompt, a diff or a tool's output, and a memory whose text is one of those is a defect to flag.
- **The brain does not put a memory into a session by itself.** An agent asks for memories with a tool. The reporter adds
  nothing to a prompt, a system message or a file the harness reads, except the sync of [13.5](13-05-sync-with-local-memory-files.md),
  which writes the harness's own memory files for memories the person wrote or approved. A harness may load those files into
  its own context. That is the harness's behavior, and 13.5 says what the person is told about it.
- **The brain does not replace local memory files.** The harness keeps writing and reading them. The brain gives them a
  shared copy and a way to find them.
- **The brain does not run an agent.** Podium never starts, stops or resumes a session or an agent (section 1). A review is
  run by hand in a person's own harness ([13.6](13-06-the-reviewer.md)). Orchestration agents of Podium's own are a later,
  separate feature.
- **An Admin never edits a memory and never touches a person's machine.** An Admin reads and deletes, and each time the person
  is told ([13.3](13-03-who-can-read-and-write.md)).
- **There is no search by meaning in the first version.** Embeddings are deferred ([section 11](../11-out-of-scope-and-deferred.md)),
  and the search is built behind an interface so that they can be added ([13.4](13-04-search-and-weight.md), [DECISIONS 81](../../decisions/81-memory-search-is-an-in-process-index-behind-an-interface-fed-from-storage-and-checked-against-it.md)).
- **There is no memory per agent, per team or per group.** A memory is a person's or everyone's.
- **No hosted service and no memory shared between two Podium servers.** One server is the brain. Server and database are
  one `podiumctl` deployment.
- **English only in the first version.** Search and console text are English. Adding a language later is documented: what
  the tokenizer, the stop of prefix matching and the console strings need.

## Related

- [13.2 The memory](13-02-the-memory.md)
- [Section 1, goals and non-goals](../01-goals-and-non-goals.md), amended by [DECISIONS 79](../../decisions/79-the-brain-keeps-a-persons-memories-on-the-server-in-two-scopes-and-every-admin-read-of-one-is-told.md).

<!-- nav:start -->
---

Up: [13. The brain](README.md) · Next: [13.2 The memory](13-02-the-memory.md)
<!-- nav:end -->
