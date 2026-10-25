---
title: "5.7 Git queries"
description: "The git commands the reporter runs, how often, and how it builds the changed-files list."
group: "Reference"
section: "5.7"
order: 7
---

# 5.7 Git queries

Run from the session's `cwd`. Poll every 10 s and on `session.start`, never per event.

```
git rev-parse --abbrev-ref HEAD                  → branch ("HEAD" means detached; report the short sha instead)
git rev-parse --git-dir ; git rev-parse --git-common-dir
        → isWorktree = (resolve(git-dir) !== resolve(git-common-dir))
git rev-parse --show-toplevel                    → worktreePath (when isWorktree)
git status --porcelain=v1 -b                     → first line "## branch...origin/branch [ahead N, behind M]"; remaining lines = modified count (dirty)
```

If any call exits non-zero (not a repo), report `git: null`. Cache the result; send it with every report.

## Changed files

The same poll builds `session.files`, the files the session changed.

The first read of a session records the commit HEAD points at (the empty tree when there are no commits yet)
and keeps it in the mod's store under the session id. Every later read diffs the working tree against it, so
committed work stays listed. Each query runs as `git -C <toplevel> …`:

```
git rev-parse HEAD                               → the starting commit, on the first read
git merge-base --is-ancestor <start> HEAD        → still an ancestor? if not, the commit was dropped (rebase, amend, branch switch)
git merge-base HEAD @{upstream}                  → the fallback base; with no upstream, diff against HEAD and report since "worktree"
git diff --name-status -z -M <base>              → status and rename pairs
git diff --numstat -z -M <base>                  → added and removed lines per file (`-` for a binary file)
git ls-files -z --others --exclude-standard --full-name   → untracked files
git grep --no-index -I -c -z '' -- <paths>       → their line counts, one process per 100 files; it leaves out empty and binary files
git diff --no-index --numstat -- /dev/null <path> → those left-out files, one process each, for at most 20 per read
```

Only paths and counts are read, never file contents or diff text. The one exception is a file's diff opened on
demand from the console (#319, [6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md)), which is off unless two switches are on.

- The list is sorted by path and cut at 200 files.
- `total`, `added` and `removed` cover every file, with one exception: an untracked file past the 200th is
  counted as a file but adds no lines. Only the listed ones are line-counted, on every poll. An empty or binary
  one past the first 20 of those in a read shows no counts, as a binary file always does.
- A repository with no commits yet is read too, against the empty tree.
- If any query fails, the mod keeps the last list.
- Two sessions in the same checkout see the same changes, because the diff is of the working tree. Worktrees
  avoid that.

<!-- nav:start -->
---

Previous: [5.6 What the engine does and does not tell you](05-06-what-the-engine-does-and-does-not-tell-you.md) · Up: [5. The Claude Code mod API: everything the reporter needs](README.md) · Next: [5.8 Session identity, /clear, restarts](05-08-session-identity-clear-restarts.md)
<!-- nav:end -->
