---
name: podium-pr-workflow
description: What is specific to Podium around a pull request - the pre-PR checks (mod tests, sonar analyze, UI, atlas, docs) and the Podium additions to the PR trace check. Load this alongside github-pr-merge before opening any PR, after every push to an open PR, when a PR check or the SonarCloud gate fails, and when you change a PR's title or body. Use it for any change under mod/ (the mod tests do not run in CI), for the `sonar analyze` run, and for the Haiku trace-check subagent's Podium patterns.
---

# Opening a PR in Podium

`github-pr-merge` owns the sequence: static analysis, the trace check, opening the PR, the conflict check and `gh pr checks --watch` after every push, closing the issues after the merge, and cleanup. `PROJECT.md` holds the rules (no session links, no version bumps in feature PRs, the maintainer merges). This skill holds only what that skill cannot know about Podium.

## Before the PR

1. **Mod changes.** A change under `mod/` runs `npm run test:mod` and `npm run typecheck:mod`. Neither runs in CI (they need Claude Code installed), so nothing else catches a mod regression until the release gate does. Report the result in the PR body.
   - When `test:mod` shows failures, compare against a clean `development` (or the last release tag) before calling them yours or not yours, and say which.
   - A failure that is not new still goes to the maintainer: file an issue rather than carry it silently into a release (the release gate allows no known failure).
   - If `typecheck:mod` cannot find `claude-code.d.ts`, say so in the PR; do not report it as passing.
2. **`sonar analyze`** on the files you changed (`development-commands`, `sonar-analysis.md`, has the command, the skipped-analysis wording, the 80% coverage gate and the rules to avoid). This repo's history: `typescript:S6324`, `replaceAll`, `Number.parseInt` (#366) and a first push that failed the gate at 44% for untested log call sites (#367).
3. **UI branch.** A branch that changes `frontend/` or `mockup/` runs `podium-standards-check` once on the branch and fixes what it reports or says why not. Check the built narrow layout with `scripts/page-shot.mjs` (`development-commands`, `ui-screenshots.md`; `PROJECT.md`, "UI Standards").
4. **Atlas.** A structural or architectural change loads `podium-atlas-update`, or has the `podium-atlas-keeper` agent run it (a fresh, non-fork agent; do not edit the atlas files while it runs). Read its report and the diff before committing. A change that touches nothing the atlas states needs no update, and the PR says so.
5. **Docs.** `documentation-sync`, plus `podium-docs-site` for a doc page.
6. **`/code-review` once** for a code change, per CLAUDE.md's Review row.

## The PR trace check, Podium patterns

Run the check in `github-pr-merge`'s `resources/pr-trace-check.md` (a fresh, non-fork Haiku subagent, authority stated in its prompt). Give it these patterns as well:

- a link to a Claude Code session (`claude.ai/code/session_` followed by an id), or a `Claude-Session:` trailer, in the title, body, a commit message or the diff. This is a Do Not and is always a failure. The words that name the pattern in `PROJECT.md` or this skill are not a hit; an actual id is;
- a `pdm_` token, or the contents of a reporter config file;
- the scratchpad path, among the author-machine paths.

A pass is a claim, not the check. Also run this over the commit messages, the title and body file, and the diff, and expect no output (in a PR that edits the rule itself, the lines of the rule are the only hits allowed):

```bash
git log <base>..HEAD --format=%B | grep -nE 'claude\.ai/code|session_[A-Za-z0-9]{10,}'
grep -nE 'claude\.ai/code|session_[A-Za-z0-9]{10,}' <body-file>
git diff <base>...HEAD | grep -nE 'claude\.ai/code|session_[A-Za-z0-9]{10,}'
```

## After the PR is open

The SonarCloud quality gate is one of the checks. For a failing gate, read the PR's open issues. After the user merges, `github-pr-merge` closes the issues and cleans up; this repo's issue comment is `Fixed in #<PR>; ships with the next release.`
