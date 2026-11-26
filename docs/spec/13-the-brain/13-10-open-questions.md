---
title: "13.10 Open questions"
description: "What the maintainer decided, how the draft reads the unclear points, the proposals not yet decided, and what must be proved before issues are cut."
group: "Reference"
section: "13.10"
order: 10
---

# 13.10 Open questions

This section is a draft. It records what was decided, where the draft had to read between the lines, what is proposed and not yet
decided, and what must be proved.

## 13.10 Decided (2026-11-25)

After an adversarial review of draft 1 and the rounds that followed:

- **Consent.** Everything ships off. A person turns on Brain for each reporter in My reporters. The switches do not stop a hostile
  process that holds the person's token. Unauthenticated users see no memories and unauthenticated harnesses reach none.
- **Admin.** Reads and deletes to the trash, never edits, never touches a person's machine, and every read of a `person` memory
  tells the person in the console and in `podium-reporter`. The model is never told.
- **Scopes and projects.** Two scopes, no memory per agent. The `everyone` scope is opt-in. A project is a git remote by default, and
  with no git it is named by hand. A person names their own projects and an Admin can name them too, which is a told read.
- **Promotion.** The Admin approves, with the owner as the fallback.
- **Reading and search.** Summaries first, then the body, then resources. Tags are categories and can be required. MiniSearch,
  behind a swappable interface. A memory has at most 10 resources of 8,000 characters.
- **Weight.** Admin-adjustable amounts applying forward, with a history. Agent and person votes weigh the same. A rejection stays out of
  the session that made it.
- **Sync.** Everything by default with a pinned-only choice. The first sync is a dry run, then approval. Resources are a main file and
  sibling files where a harness's format allows.
- **Review.** Manual and Admin-run at first. An Admin-run review reads the `everyone` scope, and a person's memories only with that
  person's permission. Orchestration agents come later.
- **Operations.** Back up the database with the server stopped and record the version. Block a restore whose version differs. One
  server. English only. Reasonable rate limits. The brain's tools and sync support three versions, counted by major and minor.
- **Deletes** are kept 30 days. **Edges** stay in the first schema. **Merge notices** are mocked up and tried.
- **Issues** carry their required tests in their Definition of Done, and the documentation-sync sweep covers the docs.

Decided after that: search covers resource content. The four ideas from a sample of one project's memory files are in the rules
(the outline per type, links as edges, the memory habits in the tools, and the address warning). The amendment to section 1 is
approved. A person may run a review of their own memories. "No Admin is available" means a promotion has waited longer than
a setting, 7 days by default. The flag threshold, the sync pause limits, the retention periods and the size and rate limits of
this draft are accepted as starting values. Restore checking gets its own command.

## 13.10 Not decided: raised by the second review

A second adversarial review of this draft found that it is **not ready to cut into issues**. These need the maintainer, and
the draft's text above is unchanged for them:

1. **An Admin-run review over a person's memories** puts their text into the Admin's own session, transcript, recording and agent
   answers, where it can be read with no notice to the owner. Proposed: leave it out of the first version.
2. **The owner can edit an approved `everyone` memory with no new approval, and can restore one an Admin trashed.** Proposed:
   both go back through approval, and a restore lands in the owner's `person` scope.
3. **An exposed secret waits 30 days in the trash.** Proposed: an Admin may purge at once for that reason, with the owner told.
4. **Silence approves a promotion** after the fallback time. Proposed: it does not. The owner approves only under the `owner`
   setting.
5. **A memory an agent wrote on its own is written to disk with no person looking,** which lets injected text reach every
   session. Proposed: a per-folder switch, off by default.
6. **The brain has no machine-side option,** unlike the other features. Proposed: add `brain` and `brainSync` reporter options.
7. **A project's identity from git** is not defined: only `owner/name` is read today. Proposed: host, owner and name with
   credentials removed, as a suggested name only.
8. **A reporter newer than its server, and development builds,** are not covered by the three-version window.
9. **Every git worktree is its own folder.** Proposed: worktrees share the main checkout's.
10. **Votes cannot demote a much-used memory.** Proposed: cap how much uses alone add.
11. **Rejecting a memory needs it opened first,** which counts as a use. Proposed: a rejection from a summary leaves it out of
    the session and changes no weight.
12. **An Admin's project rename reaches the person's agents.** Proposed: restrict names to a tag-like set of characters.

## 13.10 Known defects from the second review, to be fixed in this draft

These need no decision and are **not yet fixed**:

- Ids are not safe across a restore, and a restore can bring back a deleted memory. Memories and versions need ids that are
  not reused after a restore, and the database needs a mark that tells every mirror it was restored.
- Resources need a stable id and unique names: merges, routes and sibling files all key on the name.
- The sync protocol is one route. The base text, the compare-and-swap, a conflict's local side, the dry run and a pause need
  their own routes and shapes.
- Several writes that change what the index ranks are not listed for re-indexing, two updates can apply out of order, and the
  drift check compares only totals. Tags and `supersedes` must be read through `Storage`.
- The index contract states properties that are not true in general, and paging is not stable while weights fade.
- A vote is keyed by agent session, so one person can vote many times, and the history cannot pair a withdrawal with its vote.
- Only bodies and resources are scanned for secrets, not names, summaries, tags or delete reasons.
- Routes and error codes are missing for several stated features ([13.11](13-11-interfaces.md)).
- A promotion request is not bound to a version.
- A file released from a mirror, or created after the first sync, has no rule.
- The Admin's per-person flagged count tells the Admin about flags that are the person's alone.
- Spec 1's wording of the brain's consent and size does not match this section.
- Restoring a backup made with a database's own tools never meets the restore check.

## 13.10 What must be proved before issues are cut

- The harness spike of [13.5](13-05-sync-with-local-memory-files.md): atomic write, delete, links, the end hook's budget, resume, folder locations,
  how each harness's format holds resources, and whether an agent can read the credential.
- The extension of the Admin read registry check ([13.9](13-09-storage-limits-and-retention.md)).
- The measurement at the limits, with the index's rebuild time and memory ([13.9](13-09-storage-limits-and-retention.md)).
- A mockup of My reporters, My memories and Admin > Memories, including the merge notice, accepted by the maintainer ([13.8](13-08-the-console.md)).

## 13.10 Where the draft touches the rest of the spec

- [Section 1](../01-goals-and-non-goals.md) gains a goal, a sixth opt-in exception to its conversation-content rule, and an amendment to
  its non-goals. The amendment is the maintainer's to approve.
- [Section 3](../03-glossary.md) gains terms.
- [Section 11](../11-out-of-scope-and-deferred.md) lists what the brain defers.
- [Section 12](../12-open-questions.md) points here.

## Related

- [DECISIONS 79](../../decisions/79-the-brain-keeps-a-persons-memories-on-the-server-in-two-scopes-and-every-admin-read-of-one-is-told.md)
- [DECISIONS 80](../../decisions/80-memories-sync-by-version-chain-with-a-three-way-merge-and-a-conflict-is-kept-and-asked.md)
- [DECISIONS 81](../../decisions/81-memory-search-is-an-in-process-index-behind-an-interface-fed-from-storage-and-checked-against-it.md)

<!-- nav:start -->
---

Previous: [13.9 Storage, limits and retention](13-09-storage-limits-and-retention.md) · Up: [13. The brain](README.md) · Next: [13.11 Interfaces](13-11-interfaces.md)
<!-- nav:end -->
