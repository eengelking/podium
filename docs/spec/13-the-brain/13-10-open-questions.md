---
title: "13.10 Open questions"
description: "What the maintainer decided, what is still open, what the draft chose on its own, and what must be proved before issues are cut."
group: "Reference"
section: "13.10"
order: 10
---

# 13.10 Open questions

This section is a draft. It records what was decided, what is still open, which details the draft chose itself, and what must be
proved. Two adversarial reviews shaped it.

## 13.10 Decided (2026-11-25)

- **Consent.** Everything ships off. A machine option (`brain`, `brainSync`) and a console switch both have to allow it. The
  switches do not stop a hostile process that holds the person's token. Unauthenticated users see no memories and
  unauthenticated harnesses reach none.
- **Admin.** Reads and deletes to the trash, never edits, never touches a person's machine, and every read of a `person` memory
  tells the person in the console and in `podium-reporter`. The model is never told. An exposed secret may be purged at once,
  logged and told as that.
- **Scopes and projects.** Two scopes, no memory per agent. The `everyone` scope is opt-in. A project is a git remote, read as
  `owner/name`, and with no git it is named by hand. A person names their projects and an Admin can too, as a told read. Typed
  names are restricted.
- **Promotion.** The Admin approves and silence never does. The owner approves only under the `owner` setting. An edit to a shared
  memory needs approval again, and one an Admin trashed is restored as private.
- **Reading and search.** Summaries first, then the body, then resources. Resource content is searched. Tags are categories and can
  be required. MiniSearch, behind a swappable interface. At most 10 resources of 8,000 characters. An agent may reject from a
  summary.
- **Weight.** Admin-adjustable amounts applying forward, with a history. Uses alone are capped. A rejection stays out of the
  session that made it.
- **Sync.** Everything by default with a pinned-only choice, including what agents write on their own. The first sync is a dry run,
  then approval.
- **Review.** By hand. An Admin's run reads shared memories only. A person may run one over their own. Orchestration agents come
  later.
- **Habits.** An outline per type, links as edges, memory habits in the tools, and a warning about addresses before sharing.
- **Operations.** Back up with the server stopped and record the version. A `podiumctl` restore refuses a different version. One
  server. English only. Rate limits. The brain's tools and sync support three versions, counted by major and minor.
- **Deletes** are kept 30 days. **Edges** stay in the first schema. **Merge notices** are mocked up and tried.
- **Issues** carry their required tests in their Definition of Done. They are not filed until the maintainer has discussed them.

## 13.10 Still open

1. **Is a project shared between people?** The maintainer said a project is bigger than one person. The draft still gives each
   person their own projects, with private names. A shared project would change who sees names and what an Admin's rename means.
2. **Does an agent in a repository hold that project automatically,** or only after a grant? The draft requires a directory rule
   or a grant ([13.3](13-03-who-can-read-and-write.md)).
3. **How much can uses add to a weight?** The draft says 10.
4. **May a git-derived project name keep `owner/name`,** with the tighter rule only for typed names? The draft says yes.

## 13.10 Chosen by the draft while fixing the second review

These fix defects the second review found. Nobody has reviewed the fixes:

- Random ids, and a random change id a mirror remembers so that a restore is detected ([13.2](13-02-the-memory.md), [13.5](13-05-sync-with-local-memory-files.md)).
- Resource ids and unique names, and resource files in a folder beside the main file.
- The six exchanges of a sync and their routes, and dry-run uploads purged after 7 days if not approved.
- Index updates that re-read by id, a per-memory drift check, and a paging cursor that pins the query's time.
- A weight kept as a use part and a vote part, votes keyed by person, and history events with a random vote id.
- A review run that reads at most 500 memories.
- The added routes and codes of [13.11](13-11-interfaces.md), and the rules for new and released files.

## 13.10 What must be proved before issues are cut

- The harness spike of [13.5](13-05-sync-with-local-memory-files.md): atomic write, delete, links, the end hook's budget, resume, folder locations,
  how each harness's format holds resources, and whether an agent can read the credential.
- The extension of the Admin read registry check ([13.9](13-09-storage-limits-and-retention.md)).
- The measurement at the limits, with the index's rebuild time and memory ([13.9](13-09-storage-limits-and-retention.md)).
- A mockup of My reporters, My memories and Admin > Memories, including the merge notice, accepted by the maintainer ([13.8](13-08-the-console.md)).
- That the search library does what [13.4](13-04-search-and-weight.md) needs, checked against its documentation.

## 13.10 Where the draft touches the rest of the spec

- [Section 1](../01-goals-and-non-goals.md) gains a goal, a sixth opt-in exception to its conversation-content rule, and an amendment to
  its non-goals. The maintainer approved the amendment.
- [Section 3](../03-glossary.md) gains terms.
- [Section 6.8](../06-reporter-protocol/06-08-version-compatibility.md) notes the brain's planned version exception.
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
