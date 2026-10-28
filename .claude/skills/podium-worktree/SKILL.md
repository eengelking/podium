---
name: podium-worktree
description: Create, use and remove the git worktree every Podium working branch lives in. Load this before the first Edit or Write of any change while the checkout is on main or development, when starting an issue, a hotfix, a release-prep branch or a backport, when a branch already exists and needs a worktree, and when cleaning up after a merge is confirmed. Use it any time you are about to run `git checkout -b` or `git switch -c` in the primary checkout, because that is forbidden here and this skill has the replacement.
---

# Working branches are worktrees

`PROJECT.md` states the rule: in this repo every working branch is a git worktree, and the primary checkout stays on `development`. This skill is the mechanics. The reason for the rule: work on several branches never trades files, and a test run or server in one worktree cannot be disturbed by another. It replaces the `git checkout -b` step in `git-branching` and in the skills that quote it; the rest of `git-branching` (parents, names, parallel batches) still applies.

## Create

```bash
git fetch origin
git worktree add .claude/worktrees/<branch-slug> -b <branch> origin/development   # origin/main for a hotfix
cd .claude/worktrees/<branch-slug> && npm ci --ignore-scripts
```

- `<branch-slug>` is the branch name with each `/` written as `-`, so `issue/354-design-system` lives in `.claude/worktrees/issue-354-design-system`. That folder is ignored by git.
- A branch that already exists gets `git worktree add .claude/worktrees/<branch-slug> <branch>`.
- `core.hooksPath` is `scripts/hooks`, a path inside the checkout, so each worktree has the pre-commit hook without more setup.
- Do every edit, test run, commit and push for the branch inside its worktree, and confirm `pwd` and `git branch --show-current` first.
- A parallel batch's sub-agents already get their own worktrees with `isolation: "worktree"` (`git-branching`); an orchestrator's own work follows this skill too.

## Clean up

Only when the merge is confirmed, not before. A worktree outlives its branch's merge, and one that still holds a branch checked out blocks deleting that branch, so the order matters:

1. `git worktree remove .claude/worktrees/<branch-slug>`
2. Delete the branch locally and on the remote.
3. `git worktree prune`
4. `git worktree list` shows only what is still in use.
