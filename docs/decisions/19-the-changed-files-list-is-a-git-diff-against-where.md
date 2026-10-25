---
title: "19. The changed-files list is a git diff against where the session started"
description: "The changed-files list is a git diff against the commit the session started at, matching GitHub, but two sessions in one checkout see the same changes."
group: "Project internals"
number: 19
date: "2026-10-12"
status: "accepted"
order: 19
---

# 19. The changed-files list is a git diff against where the session started

**Decision.** The mod records the commit HEAD pointed at when the session began and lists the files that
differ from it in the working tree (SPEC 5.7).

- Line counts come from `git diff --numstat`, and untracked files are counted separately.
- It does not count only the files the session's own Edit and Write calls touched.
- If that commit is no longer an ancestor of HEAD (a rebase, an amend, a branch switch), it diffs against
  the merge base with the upstream, and with no upstream against HEAD alone. The report says which (`since`).
- The Files tab pages the list 20 at a time, and the left column widens to 400 px while it is open (#26).

**Why.** It matches what GitHub shows, includes changes made by shell commands and formatters, and survives
a commit, which a count of tool calls does not. The starting commit is kept in the mod's store under the
session id, so a hot reload does not move it.

**Cost.**

- Two sessions in the same checkout both see the same changes, because the diff is of the working tree.
  Worktrees avoid it.
- A session that switches to an unrelated branch reads as `upstream` or `worktree` rather than as its own
  changes.
- The mod runs five git queries every 10 seconds instead of one, and counts at most the first 200 files.
- Untracked files are counted with one `git grep -c` per 100 files (#271). A folder of hundreds costs a few
  processes a poll. An empty or binary untracked file past the first 20 in a read shows no counts, and
  untracked files past the 200th add no lines to the totals.
- The report carries the list in every snapshot, since a report is a full snapshot (SPEC 6.7). The mod only
  marks a report due when the list changes.

<!-- nav:start -->
---

Previous: [18. A supported range of reporter versions, not a protocol number](18-a-supported-range-of-reporter-versions-not.md) · Up: [Decisions](README.md) · Next: [20. Per-person tokens bound to a name, and an Admin section gated by the old shared secret](20-per-person-tokens-bound-to-a-name-and-an-admin.md)
<!-- nav:end -->
