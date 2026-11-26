---
title: "13.8 The console"
description: "My memories and My reporters for a person, Admin > Memories for an Admin: what each shows, the notices, the content-free live event, and the mockup."
group: "Reference"
section: "13.8"
order: 8
---

# 13.8 The console

Three places, and a mockup of all of them comes before any code. The mockup is made with `/frontend-design:frontend-design`,
`/dataviz` and `/podium-standards-check`, uses the app's tokens and components, links `frontend/src/fleet/tokens.css` with
no `:root` block of its own, shows light, dark and a narrow width, is opened as an Artifact, and is accepted by the maintainer
first. A component or pattern the pages need that the standards lack is added to the standards through the maintainer's approval
and `/podium-standards-update`, never invented inside this feature.

## 13.8 My reporters

For each reporter, beside the switches it already has, a person sets:

- **Brain**: `off` (the default), `read` or `readwrite`. Only the reporter's owner can.
- **Sync**: `off` (the default), `pull` or `both`, and for each of its folders the project it maps to, **Include Global
  memories** (off by default), and a way to re-link a folder that moved ([13.5](13-05-sync-with-local-memory-files.md)).
- **Directory rules**: which project a directory with no git remote belongs to ([13.3](13-03-who-can-read-and-write.md)).

Turning a switch on for a reporter says in plain words what it allows. The first sync of a folder says that the harness may load
the files into sessions ([13.5](13-05-sync-with-local-memory-files.md)).

## 13.8 My memories

For the signed-in person. **Projects come first:** the page opens on the person's projects and **Global**, and every list is
the list of one of them. It shows the person's own memories there and, for a project they are a member of, its shared memories:

- a list with search, filters (type, tag, state, personal or shared, mine or others') and a sort (weight, newest, last used),
  paged;
- a memory's page: name, description, body, resources, tags, type, project, scope, who wrote it, who shared it, weight,
  votes, when it was last checked, the history of versions (with **merged automatically** marked) and edges;
- a **project**'s name, which a member can change;
- actions on the person's own memory: edit, vote, delete, share, offer, mark as checked, pin, and, while it is personal, change
  its project. On another member's shared memory: vote, flag and copy. Each is a visible control, and the right-click menu on a
  row is a shortcut to the same actions, never the only way to reach one (keyboard and touch);
- **Waiting for you**: each change an agent made to one of the person's shared memories, as a diff against what members see,
  with **Approve** and **Reject**;
- **Recently deleted**: every memory trashed in the last 30 days, with who deleted it (the person, their agent, an Admin or an
  approved review), why, the days left, and **Restore**;
- **Inbox**: offers, each readable in full under the prompt-injection warning of [13.3](13-03-who-can-read-and-write.md), with
  Accept, Decline and Block sender;
- **Conflicts** ([13.5](13-05-sync-with-local-memory-files.md)): the two texts side by side, a draft of the merge, and the choices;
- **Import**: a first sync's dry run (files to upload with their secret-scan results, files to write, and the index size), to
  approve one by one or all, and the pauses for a mass change;
- **Settings**: **Reviewer**, off by default;
- **Reviewer**: start a run for one project, with what it may read, its estimate and who it runs on, and the proposals to
  approve or reject ([13.6](13-06-the-reviewer.md)).

A red notice on a memory says an Admin is reading it now, names the Admin, and the page keeps a permanent line that an Admin read
or deleted it, never with the text. The line is shown with the memory's history.

## 13.8 Admin > Memories

For an Admin. It shows:

- the **settings**: the Brain flag, the weight amounts, the cap on uses and the half-life, the number of flags that hide a
  shared memory, the limits and the retention periods ([13.9](13-09-storage-limits-and-retention.md)), each with its default;
- a banner while the brain is being re-indexed;
- **Projects** first: each with its name, its repository name, the **groups** assigned to it and its counts, to name, rename
  and assign;
- in a project, its shared memories, each with Open and Delete, and the flagged ones, each with Hide, Clear and Delete. Opening
  the list tells the authors in it;
- on a memory, **Purge: exposed secret**, which removes it at once and is logged and told in those words ([13.3](13-03-who-can-read-and-write.md));
- a list of people with their counts (memories and trashed) and nothing else. Choosing a person and opening their list
  or one of their memories is a read that tells that person ([13.3](13-03-who-can-read-and-write.md));
- the log of Admin reads and deletes, with who, whose and when, never the text.

There is no search or tag filter over memories, and no edit anywhere. Opening a memory's list or text shows a confirmation that
names who will be told, and the read is told and logged. A delete asks for a reason,
which the owner is shown.

## 13.8 Notices and the banner

A merge notice on a memory is mocked up with the pages and tried before its final form is fixed. While the index is building,
every brain page shows that the brain is being re-indexed and that search will be back shortly.

## 13.8 Live and paged

The pages follow the wall's rules, and they follow how Chat does it, because the stream is open to every console.

- **A `brain` event carries nothing about a memory.** It is `{ rev, scope: 'personal' | 'shared' }`, where `rev` is a change
  counter and `scope` says which kind of change, with no id, no name, no person and no count, because every open console receives
  it, as the `chat` event does ([7.6](../07-server/07-06-sse-stream.md)). One action sends one event for each scope it changed,
  when it is done. A console that gets one asks the gated brain routes, which check who is asking, for its own person's changes. An
  Admin's live read, an offer, a conflict, a flag and a change on another machine reach the person this way, with no refresh.
- A console asks again at most once a second, whatever the number of events.
- Lists are paged, 12 at a time, and a sort and a filter are part of the query, not applied to a page.
- A page has an accessibility case (axe, and contrast and target size in a real browser), a 400 px and 1440 px check with
  `scripts/page-shot.mjs` against a throwaway server, and e2e specs with a row in `docs/e2e/COVERAGE.md`.

## 13.8 Copy

Words follow the standards' voice. The notices name the Admin and the action in plain words ("An Admin, Dana, opened your memory
'deploy steps' to read it"). Errors are never notices. The names are **memory** and **the brain**, and the pages are **My
memories**, **My reporters** and **Admin > Memories**.

## Related

- [13.3 Who can read and write](13-03-who-can-read-and-write.md)
- [8. The UI](../08-ui/README.md)

<!-- nav:start -->
---

Previous: [13.7 The reporter's tools](13-07-the-reporters-tools.md) · Up: [13. The brain](README.md) · Next: [13.9 Storage, limits and retention](13-09-storage-limits-and-retention.md)
<!-- nav:end -->
