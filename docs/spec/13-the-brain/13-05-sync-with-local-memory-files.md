---
title: "13.5 Sync with local memory files"
description: "How a harness's memory files and the brain stay in line: mirrors, the three-way merge, conflicts, deletes, the guards, and what must be proved first."
group: "Reference"
section: "13.5"
order: 5
---

# 13.5 Sync with local memory files

The reasoning is in [DECISIONS 80](../../decisions/80-memories-sync-by-version-chain-with-a-three-way-merge-and-a-conflict-is-kept-and-asked.md).
This page is the rules.

Sync writes and deletes files on the person's machine, which nothing in Podium did before. So it has its own switch per reporter,
**Sync** (`brainSync`: `off`, `pull` or `both`, off by default), on top of the consent of [13.1](13-01-what-the-brain-is.md). `pull` writes local
files from the brain and never uploads one. `both` also uploads. An Admin never causes a file on a person's machine to be
written or deleted ([13.3](13-03-who-can-read-and-write.md)).

## 13.5 What must be proved first

The engine each harness gives a reporter decides what this page can promise, and some of it is not known. **No sync issue is cut
until a short spike has recorded, for each harness,** and the page then says what it found:

1. how a file is replaced without leaving a half-written one, and how a file is deleted (the Claude Code engine's file API has
   read, write, list, exists and stat, and no rename or delete, so the answer may be a helper process);
2. whether a write follows a symbolic link, and how to refuse one;
3. how long the end-of-session hook may run (Claude Code's is about 1.5 seconds for every hook together);
4. how a resumed session is detected, since an OpenCode resume starts no new session;
5. where each harness keeps its memory folder, including for a git worktree, what its index file does, and whether its
   format can hold a memory's resources as sibling files;
6. whether the person's credential can be read by an agent with a shell on each harness (it can on OpenCode).

Until then, the rules below say what must hold, and each says "by the means the spike found".

## 13.5 What is mirrored

- A **folder** is one harness's memory folder for one working directory. The directory rule that gives the agent its project
  ([13.3](13-03-who-can-read-and-write.md)) maps the folder to the same project. Nothing in an unmapped folder is read.
- A folder mirrors the owner's `person` memories of its project. It mirrors the owner's memories that have **no project** only when
  the person turned on **Include memories with no project** for that folder, which is off by default. It never mirrors an
  `everyone` memory. Those are found by search. To have one as a file the person copies it into their own memories, which is
  a memory they chose.
- **Only memories the owner wrote or approved are mirrored.** Every version in a mirror was written by the owner's own agent
  under their switch, or by the owner, or approved by the owner: an accepted share, an approved review change, a restore.
  Nothing an Admin did can reach a file, because an Admin never edits ([13.3](13-03-who-can-read-and-write.md)).
- **Everything by default, with a pinned-only choice.** A folder syncs every memory of its set, or only the ones the owner
  pinned. Claude Code loads its memory index into every session, so before the first sync the console shows how large the
  index would be and offers the pinned-only choice. Memories that are not on disk are still found by search.
- **Resources.** A memory with resources is written as its main file with sibling resource files where the harness's format
  allows, and the whole memory is one mirror entry: its files change, merge and delete together. Where the format cannot,
  only the main file is written, and the agent reads resources with the tool.
- A **mirror entry** ties one memory to one local file. It holds the memory id, the **base version** (the version both sides
  last agreed on), the file's hash then, and the time of the last sync.
- **A mirror is keyed by the server, the reporter's key, the harness and a folder id.** A reporter can talk to several
  servers, a machine has one key for every harness, and one machine has many folders (a git worktree has its own). The
  reporter makes the folder id when the folder is mapped and keeps it in its state file, so it survives a rename of the
  path. A folder that moved is re-linked to its id in My reporters, never guessed.
- The server holds each mirror's base version ids, so it can keep the text of those versions. The reporter holds the paths,
  hashes and folder ids in a state file in its own data folder, never in the harness's memory folder, so Podium adds nothing
  there but memory files. Two sessions on one machine take a lock per folder, and a state-file write merges what is there.

## 13.5 The format of a local file

Each harness has a **memory format** in its own folder under `plugin/`, which reads a local file into the record of
[13.2](13-02-the-memory.md) and writes a record back as a file of that harness's shape (Claude Code's is a Markdown file with frontmatter
and an index file beside it). The shared parts, the hashing, the merge and the conflict rules, live in `plugin/core/`, and a
harness supplies only the format ([PATTERNS](../../PATTERNS.md), "A shared rule lives in `plugin/core/`").

- **What is hashed is a normalized record,** never the bytes: the fields the brain owns (`name`, `description`, `type`, `tags`
  where the harness has them), the body and each resource, with line endings and the trailing newline normalized. Frontmatter the brain does
  not own, such as a harness's own session id or modified time, is kept and written back unchanged, never hashed, and never makes
  a change.
- A file the format cannot read is **skipped and counted**, never treated as missing or as changed, and never rewritten.
- The reporter derives a file's name itself, in the characters `a-z`, `0-9` and `-`, and **adopts the name of a file that
  already exists**. It never takes a path from the server.
- A write goes by the means the spike found, then reads the file back and checks its hash. It refuses to write through a symbolic
  link or to a real path outside the mapped folder, keeps the file's permission bits, and leaves a file that changed since it was read for the
  next sync.
- An index file that the harness keeps is edited only on the lines whose link is a file the reporter manages.
- A file that cannot be parsed, or whose body would shrink to less than half of the base's, is not uploaded without the person
  confirming it in the console, because a truncated file must not become every machine's version.

## 13.5 Links between memories

A `[[name]]` link in a local file's body becomes a `related` edge ([13.2](13-02-the-memory.md)) on import and on sync, when exactly one memory
the owner may read has that name. A link that matches none or several is kept as text and creates no edge. The edge is by
id, so renaming a memory does not break it, and a sync writes the current name back into the link.

## 13.5 When a sync runs

A sync runs when a session starts (pull, then push), and when the agent calls `podium_brain_sync` ([13.7](13-07-the-reporters-tools.md)).
A sync also tries at the end of a session, but only within what the harness allows there, so **the next start is the guarantee,
and an end-of-session push is a courtesy**. There is no file watcher in the first version. A memory an agent saves with
`podium_brain_save` is written to the local file of its project's folder straight away, because the server's reply carries it,
and is not written when that project has no mapped folder.

## 13.5 The rules for one memory

L is the local file compared with the mirror entry, S is the server's current version compared with the base, and the mode is
`both` unless the row says `pull`.

| Local file | Server | What the sync does |
|---|---|---|
| Same as base | Same as base | Nothing |
| Same as base | Changed | **Fast-forward**: write the server's version to the file. The base becomes it |
| Changed | Same as base | **Push**: a new version whose parent is the base. The base becomes it. In `pull` mode: keep the local edit, upload nothing, and show "not uploaded" |
| Changed | Changed to the same content | Converge: the base becomes the server's version, and no new version is made |
| Changed | Changed, different content | **Three-way merge** (below). In `pull` mode: a conflict, because nothing may be uploaded |
| Missing | Same as base | **Trash** the memory on the server, if the guards allow it. In `pull` mode: mark the entry "deleted here", do not recreate the file, send nothing |
| Missing | Changed | **Conflict** (an edit against a delete) |
| Same as base | Trashed or deleted | Delete the file, if the guards allow it, by the means the spike found |
| Changed | Trashed or deleted | **Conflict** (a delete against an edit). The file is left as it is |
| Missing | Trashed or deleted | Drop the entry |
| Not readable | Any | Skip, count and show it. Never treated as missing |
| Any | The memory is no longer in this folder's set (its project moved, a rule or grant changed, the folder was unmapped, an Admin deleted it) | Leave the file where it is, drop the entry, tell the person, and never upload it again unless the person imports it |
| A file with no entry | None | On the first sync, **match** it to a server memory by content, then by normalized name, and adopt it. If none matches, it is a new memory after the first-sync approval below |
| None | A memory with no entry | Adopt a matching file as above. If none matches, write a new file and make the entry |
| A new file | A new memory of the same normalized name | Two memories, both marked `possible duplicate` for the person. They are never merged unasked |

**A push is a compare-and-swap.** The server accepts it only when the memory's current version is the base the reporter names. If
another machine has pushed in between, the push fails and the sync falls back to the merge row. Without this, two machines that
edit from one version and sync in the same second would let the second bury the first, which is last-write-wins.

### 13.5 The three-way merge

The base version's text is the common ancestor. The merge works field by field.

- `name`, `description` and `type`: a field changed on one side takes that side. A field changed on both sides to different
  values is a conflict.
- `tags`: the base's tags with each side's additions and removals applied. A tag one side added and the other removed is a conflict.
- `body`: merged by lines against the base. Changes to lines that do not overlap are both applied. Changes to the same lines, or
  to lines next to each other, are a conflict.
- `resources`: matched by name. Each resource's content merges as the body does and its description as a field. A resource one
  side removed and the other changed is a conflict.

A merge with no conflict makes a version with two parents, the local one and the server's, marked `merged`. The console shows it as
**merged automatically**, with both sides, in the memory's history, and the memory carries a notice until the person looks at it,
because two edits that merge cleanly can still disagree in meaning. The merged text is written to the file and sent to the server.

### 13.5 A conflict

A conflict is kept, never decided. The server keeps its current version as the memory's version, so every other machine is
unchanged, and **stores the local side as a version on a side branch** whose parent is the base. The file on the machine that conflicted
is not touched. The memory shows **Conflict** in My memories with the two texts side by side and a draft of the merge, and the
person chooses either side or edits a merged text. The choice makes a new version whose parents are the server's current version
and the stored local side. **The conflicted mirror's base then becomes that stored local side,** so on its next sync the file
is the same as its base and the server has changed, which is a fast-forward. Without that step the same conflict would open
again at every sync. If the file changed again meanwhile, the merge uses the stored side as its ancestor.

While a conflict is open, the server's version is the one search and `get` return, and a further sync of the same file
adds nothing new.

## 13.5 Guards

- **After a restore, every mirror reconciles in full.** A restored database can be older than a mirror, which then names a base
  the server no longer has. Any base the server does not know is treated as an expired mirror, below, and never as a delete.

- **A missing folder is not a deleted folder.** A sync trashes on the server only when the folder exists, is readable and holds at
  least one memory file the reporter manages. Otherwise it does nothing and says why.
- **A mass change pauses.** A sync that would write or delete more than 20 local files, or trash more than 3 memories on the
  server, stops before doing any of it and asks the person in the console with the list. **A rolling 24 hours counts too**: a
  reporter that has trashed more than 10 memories in that time pauses, so repeating a small sync does not get round the guard.
- **A first sync is a dry run.** It writes and uploads nothing. The console shows what it would do in both directions: the
  files it would upload (**Import**), with each file's secret-scan result, the files it would write, and the size of the index.
  The person approves, one by one or all at once, and only then does anything change on either side.
- **A secret is never uploaded.** Before any upload the reporter scans the file with the patterns of 13.2. A file that matches is
  not uploaded, and the person sees its name and the pattern's name, never the matched text. The server scans again and refuses.
- **A machine that has been away too long reconciles in full.** A mirror whose last sync is older than the tombstone retention
  ([13.9](13-09-storage-limits-and-retention.md)) expires. Its next sync applies nothing by itself: every difference is listed for the person, as in a first sync.
- **A reporter whose switch is off, or a server without the Admin flag,** does nothing and queues nothing. When they come back on,
  the next sync finds the differences as above.
- **A limit lowered below existing data** never blocks a mirror silently: a file over the new limit is shown as "over the limit"
  and its existing version is kept ([13.9](13-09-storage-limits-and-retention.md)).

## 13.5 What the person is told

When a memory is written into a folder, the person has already accepted it (they wrote it, approved a share, approved a review
change, or restored it). Because a harness may load its memory files and index into every session's context, the first time a
folder is set to sync, the console says so in plain words: what is written there, that the harness may load it into sessions, and
how to stop it.

## 13.5 The model test

A sync is hard to get right, so the build includes a model of it: a test that runs two mirrors and a server through random
sequences of edits, deletes, conflicts, resolutions, restores and restarts, over every adapter, and checks these invariants.

1. **Nothing is lost inside the windows.** After any sequence, every text a person or an agent wrote in the last 30 days is in a
   current version, a conflict, a version in the history or the trash.
2. **A deleted memory does not return on its own.** No sequence that ends with a memory trashed or deleted ends with it active
   on a mirror, unless a person restored it.
3. **A second sync with nothing in between changes nothing.**
4. **Two mirrors converge.** Two mirrors that have synced, with no edits since, in either order, hold the same files for the
   memories they share.
5. **A resolved conflict does not reopen.**

## Related

- [13.2 The memory](13-02-the-memory.md)
- [13.7 The reporter's tools](13-07-the-reporters-tools.md)

<!-- nav:start -->
---

Previous: [13.4 Search and weight](13-04-search-and-weight.md) · Up: [13. The brain](README.md) · Next: [13.6 The reviewer](13-06-the-reviewer.md)
<!-- nav:end -->
