---
title: "13.10 Open questions"
description: "What the maintainer decided, what the draft assumed and stands unless changed, and what must be proved before issues are cut."
group: "Reference"
section: "13.10"
order: 10
---

# 13.10 Open questions

This section is a draft. No question is waiting for the maintainer. It records what was decided, what the draft assumed, and what
must be proved. Two adversarial reviews shaped it. Neither saw the project model below, which replaced an earlier one of
`person` and `everyone` scopes.

## 13.10 Decided (2026-11-25)

- **Projects.** Every memory belongs to a project, and a person or an agent is shown only the current project's memories. A
  project is anything one or more people work on, identified by the repository's name alone, and held automatically from the
  repository. With no git it is named by hand, by a person or an Admin. A rename is seen by everyone, with no notice.
- **Global.** A memory with no project is personal only, for preferences (`user` and `feedback`).
- **Personal and shared.** No scope reaches the whole server. An agent writes personal memories and its person shares one in one
  action. A shared memory stays shared.
- **Approval.** An agent's change to a shared memory waits for the owner. The owner's own edit applies at once.
- **Membership.** An Admin assigns projects to groups, and a person is in as many groups as needed.
- **Consent.** Everything ships off. A machine option (`brain`, `brainSync`) and a console switch both have to allow it. The
  switches do not stop a hostile process that holds the person's token. Unauthenticated users see no memories and
  unauthenticated harnesses reach none.
- **Admin.** Reads and deletes to the trash, never edits, never touches a person's machine, and every read of a memory tells its
  author in the console and in `podium-reporter`. The model is never told. An exposed secret may be purged at once, logged and
  told as that.
- **Reading and search.** Summaries first, then the body, then resources. Resource content is searched. Tags are categories and
  can be required. MiniSearch, behind a swappable interface. At most 10 resources of 8,000 characters. An agent may reject from
  a summary.
- **Weight.** Admin-adjustable amounts applying forward, with a history. Uses add at most 10. A rejection stays out of the
  session that made it.
- **Sync.** Everything by default with a pinned-only choice, including what agents write on their own. The first sync is a dry run,
  then approval.
- **Review.** By hand. Orchestration agents of Podium's own come later.
- **Habits.** An outline per type, links as edges, memory habits in the tools, and a warning about addresses before sharing.
- **Operations.** Back up with the server stopped and record the version. A `podiumctl` restore refuses a different version. One
  server. English only. Rate limits. The brain's tools and sync support three versions, counted by major and minor.
- **Deletes** are kept 30 days. **Edges** stay in the first schema. **Merge notices** are mocked up and tried.
- **Issues** carry their required tests in their Definition of Done. They are not filed until the maintainer has discussed them.

## 13.10 Assumed, and stands unless changed

The draft filled these in. Each is written into the pages as a rule.

**Projects and membership**

- A git repository with no remote is named by hand, like a directory with no git. Names are compared ignoring case. A rename
  changes the shown name only, and a member or an Admin renames. A project name is not private content. A project that holds
  memories cannot be deleted.
- In a project no one is assigned to, personal memories work and nothing can be shared.
- Many groups per person ships as its own change before shared memories. A person has a My group chat per group, appears under
  each, and is an Admin if any of their groups is Administrators.
- A person who leaves a project keeps what they shared there, shared, and can delete it but not change what members see.

**Sharing and changes**

- There is no unshare and no moving a shared memory. The owner deletes it.
- An agent changes only its owner's memories. Anything that arrives through the reporter, a synced file included, counts as an
  agent's change. An agent's delete of a shared memory waits for approval too. A change to a personal memory needs none.
- A new memory goes into the current project unless the agent asks for Global.
- An offer to one person stays, only between members of the same project. Another member's shared memory is not written to disk.
- A project member runs the review of shared memories. There is no Admin-run review and no switch for reading shared memories.
- Limits are 20,000 shared memories in a project and 500 per person in it.

**The Admin**

- An Admin who is a member still tells authors when reading their shared memories.
- An Admin who reads a session tells the authors of the shared memories that session was shown.

**Details fixed while repairing the second review, which nobody has reviewed**

- Random ids, and a random change id a mirror remembers so that a restore is detected ([13.2](13-02-the-memory.md), [13.5](13-05-sync-with-local-memory-files.md)).
- Resource ids and unique names, and resource files in a folder beside the main file.
- The six exchanges of a sync and their routes, and dry-run uploads purged after 7 days if not approved.
- Index updates that re-read by id, a per-memory drift check, and a paging cursor that pins the query's time.
- A weight kept as a use part and a vote part, votes keyed by person, and history events with a random vote id.
- A review run that reads at most 500 memories.
- The routes and codes of [13.11](13-11-interfaces.md), and the rules for new and released files.

## 13.10 What must be proved before issues are cut

- The harness spike of [13.5](13-05-sync-with-local-memory-files.md): atomic write, delete, links, the end hook's budget, resume, folder locations,
  how each harness's format holds resources, and whether an agent can read the credential.
- The extension of the Admin read registry check ([13.9](13-09-storage-limits-and-retention.md)).
- The measurement at the limits, with the index's rebuild time and memory ([13.9](13-09-storage-limits-and-retention.md)).
- A mockup of My reporters, My memories and Admin > Memories, including projects, a waiting change and the merge notice,
  accepted by the maintainer ([13.8](13-08-the-console.md)).
- That the search library does what [13.4](13-04-search-and-weight.md) needs, checked against its documentation.

## 13.10 Where the draft touches the rest of the spec

- [Section 1](../01-goals-and-non-goals.md) gains a goal, a sixth opt-in exception to its conversation-content rule, and an amendment to
  its non-goals. The maintainer approved an amendment before the project model changed how a memory reaches another person, so
  its wording is to be read again.
- [Section 3](../03-glossary.md) gains terms.
- [Section 6.8](../06-reporter-protocol/06-08-version-compatibility.md) notes the brain's planned version exception.
- [Section 11](../11-out-of-scope-and-deferred.md) lists what the brain defers.
- [Section 12](../12-open-questions.md) points here.

## Related

- [DECISIONS 79](../../decisions/79-the-brain-keeps-every-memory-in-a-project-personal-or-shared-and-every-admin-read-of-one-is-told.md)
- [DECISIONS 80](../../decisions/80-memories-sync-by-version-chain-with-a-three-way-merge-and-a-conflict-is-kept-and-asked.md)
- [DECISIONS 81](../../decisions/81-memory-search-is-an-in-process-index-behind-an-interface-fed-from-storage-and-checked-against-it.md)

<!-- nav:start -->
---

Previous: [13.9 Storage, limits and retention](13-09-storage-limits-and-retention.md) · Up: [13. The brain](README.md) · Next: [13.11 Interfaces](13-11-interfaces.md)
<!-- nav:end -->
