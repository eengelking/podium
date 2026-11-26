---
title: "80. Memories sync by version chain with a three-way merge, and a conflict is kept and asked"
description: "Each memory has a version chain, each mirror remembers the version it last agreed on, and a clash is kept for the person to resolve instead of being decided."
group: "Project internals"
number: 80
date: "2026-11-25"
status: "proposed"
order: 80
---

# 80. Memories sync by version chain with a three-way merge, and a conflict is kept and asked

*Builds on 79. The rules are in SPEC 13.5.*

## Context

The point of the brain is that a memory written on a macOS machine is there on a Linux machine, and the other way round. A harness keeps memories as files that it reads and writes by itself. So the same memory can be edited on two machines, or on one machine and in the console, between two syncs. A sync that picks a side loses the other side's work without anyone knowing, and a memory is exactly the kind of text that is rewritten in small ways and never looked at again.

A sync also deletes. A file missing from a folder may mean a person removed it, or that a drive was not mounted. A memory deleted on one machine must not come back from another machine that has not heard yet.

## Decision

- **A memory is a chain of versions,** each with a parent. A merge has two parents. A **mirror**, one reporter's copy of one harness's folder for one server, remembers the **base**: the version both sides last agreed on, and the file's hash then. It is keyed by the server, the reporter's key, the harness and a folder id, because one key covers a machine, and a machine has many folders and may talk to several servers.
- **A sync compares each side with the base.** A side that changed alone wins without asking (fast-forward or push), and a push is a compare-and-swap on the current version. Both sides changed to the same content converge. A change on both sides is a three-way merge from the base's text, by field, and by line for the body. What is compared is a normalized record, never the file's bytes, so a field a harness rewrites on its own makes no change.
- **A merge with no overlap is applied and marked as merged,** and the memory carries a notice until the person looks at it. **A merge with an overlap is a conflict, and a conflict is kept and asked:** the server keeps its current version, stores the local side as a version on a side branch, leaves the local file alone, and shows both to the person, who chooses or edits. The resolution moves the conflicted mirror's base to the stored local side, so the same conflict does not open again.
- **A delete is a trash for 30 days and then a tombstone.** A tombstone has no text and stays for 180 days by default. A tombstone against an edit is a conflict. A mirror that has been away longer than a tombstone's life expires and reconciles in full, with every difference listed for the person.
- **An Admin's delete never removes a file on a person's machine.** A sync that finds a memory gone for that reason leaves the file, drops the entry and tells the person.
- **Guards sit on both sides:** a missing folder is not a deleted folder, a sync that would write or delete many files stops and asks, and so does a reporter that trashed many memories in 24 hours. The first sync is a dry run that changes nothing until the person approves it, adopts a file that already matches a memory instead of making a copy, and a file that matches a secret pattern is never uploaded.
- **Only memories the owner wrote or approved are mirrored,** and an `everyone` memory never is. A folder syncs all of its set, or only pinned memories, and the person is shown the size of the index first. A memory's resources are sibling files where the harness's format allows, and the whole memory is one mirror entry.
- **After a restore every mirror reconciles in full,** because a restored database can be older than a mirror.
- **The server's clock, and never a machine's, puts a time on a version.**
- **The shared rules (hashing, merge, conflict) live in `plugin/core/`,** and each harness supplies only its memory format.
- **No sync issue is cut until a spike has recorded what each harness's engine can do:** replace and delete a file, links, the end-hook budget, resume and the folder layout.

## Why

- A three-way merge needs the common ancestor, and a version chain with a recorded base is the smallest thing that gives it. Git has used that model for a long time, and people already know how it behaves.
- Fast-forwards and one-sided pushes are by far the most common case, and they need no question. Asking only when both sides changed keeps the question rare.
- The risk of an automatic merge is that two edits that do not overlap still contradict each other. Marking it, and keeping a notice, costs a look and avoids a silent contradiction.
- Last-write-wins is the simplest rule, and it loses a person's edit with no trace. Keeping both costs a screen and loses nothing.
- Tombstones are the only way a delete reaches a machine that was not there when it happened, and a limit on their life stops them growing without end. The full reconciliation closes the case where a long-absent machine would otherwise bring a deleted memory back. The 30 days of trash mean a wrong delete is recoverable.
- A compare-and-swap push makes two machines that edit from one version fall back to the merge, where otherwise the second would bury the first.

## Alternatives

- **Last write wins.** Rejected: loses edits silently.
- **Always ask on any difference.** Rejected: a person asked about every fast-forward stops reading the questions.
- **A conflict-free replicated type per memory (a CRDT).** Rejected for the first version: it merges text without asking, which is the behavior this decision refuses, and it carries a larger history than a version chain does.
- **A file watcher that syncs on every change.** Deferred: it is faster, and it needs a watcher in every harness and handling for a file half written. Session start and an explicit tool are the guarantee, and an end-of-session push is a courtesy.
- **Hold the mirror state in the harness's memory folder.** Rejected: it adds files the harness may read, and Podium should add nothing there but memory files.
- **Let an agent resolve conflicts.** Rejected: an agent's merge of its owner's text is the silent choice this decision refuses.
- **Key a mirror by the reporter alone.** Rejected: one reporter key covers every harness and folder on a machine, so two folders' bases would collide.

## Cost

- The server keeps the base versions that mirrors name, so a mirror that never syncs again keeps old text until it expires, and a store holds more than the current text.
- A conflict is a screen a person has to find time for. Until it is resolved the two machines differ, and a person who ignores conflicts has a pile of them.
- Merging by line is a poor fit for prose where a sentence wraps. Many memories are short notes, but a long one with edits in the same paragraph will conflict more than a person expects.
- A person with hundreds of local files has to approve the first upload, and the design offers one-by-one and all-at-once but no smarter way yet.
- Each harness's memory format has to be read and supported, and one that is not read is skipped and counted, never rewritten.
- Writing and deleting files depends on what each harness's engine allows, which is not yet known, and the end-of-session push may not fit in the hook's time.
- The invariants hold only if the model test of 13.5 is written and kept, and it takes a real effort to be convincing.

<!-- nav:start -->
---

Previous: [79. The brain keeps a person's memories on the server in two scopes, and every Admin read of one is told](79-the-brain-keeps-a-persons-memories-on-the-server-in-two-scopes-and-every-admin-read-of-one-is-told.md) · Up: [Decisions](README.md) · Next: [81. Memory search is an in-process index behind an interface, fed from Storage and checked against it](81-memory-search-is-an-in-process-index-behind-an-interface-fed-from-storage-and-checked-against-it.md)
<!-- nav:end -->
