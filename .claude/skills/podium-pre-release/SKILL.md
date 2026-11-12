---
name: podium-pre-release
description: How a Podium milestone ends before its release - filing the milestone's closing issues (documentation review, dependency update, pre-release prep, release) from templates, running the pre-release prep, and proving afterward that every step ran. Load this when a milestone vX.Y is created or planned, when you file or edit its closing issues, when the maintainer says to start the pre-release prep or the documentation review, when you open a release-prep/<version> branch, and before the prep PR is opened to fill in and check its run record. For the files a version touches, the gate and the release itself, use podium-release.
---

# Podium pre-release

The release is the end of a milestone `vX.Y`. The last issues of the milestone are the same every time, so they are filed from templates and run in a fixed order. This skill holds the order, the templates and the run record. It restates nothing that `podium-release` owns (the version-file table, the gate, the release check, publishing); it points there.

## The closing issues of a milestone

Every milestone ends with these, in this order. Each one is a GitHub issue with the milestone `vX.Y`, the label `vX.Y` and the label named in the table.

| Order | Issue | Label | Template | Done when |
|---|---|---|---|---|
| 1 | Review all documentation for vX.Y | `documentation` | `resources/issue-docs-review.md` | Every doc read against the code; findings fixed or filed; fixes merged into `development` |
| 2 | Update dependencies for vX.Y | `dependencies` | none: it already exists for each release (#864 to #868 for v1.6 to v1.10); file one by copying the nearest release's issue only when it is missing | The dependency PR merged into `development` |
| 3 | Pre-release prep for vX.Y | `housekeeping` | `resources/issue-pre-release-prep.md` | The `release-prep/<version>` PR merged into `development` and its run record passes |
| 4 | Release vX.Y | `housekeeping` | `podium-release`'s `resources/issue-release.md` | `main` holds the release, tagged and published |

An issue starts only when every issue before it is merged. The documentation review starts after the last code commit of the milestone. The dependency update runs just before the prep, so a dependency patch needs no release of its own. The release is the maintainer's decision and is never started unprompted (`podium-release`).

### Filing them

1. Check that the milestone and the `vX.Y` label exist (`gh api repos/:owner/:repo/milestones`, `gh label list`). Create what is missing, with the description "Planned for release vX.Y".
2. Check for duplicates first (the dependency issue is the one most likely to exist already): `gh issue list --state all --search "<title words> vX.Y"`. Do not file one that exists.
3. For each issue in the table, copy its template to the scratchpad, replace every `<...>` placeholder (the templates list them at the top), and file it:

   ```bash
   gh issue create --title "<title>" --body-file <file> --label <label> --label vX.Y --milestone vX.Y
   ```

4. Read each filed issue back (`gh issue view <n>`) and check that no `<` placeholder is left, the title names the right version, and the label and the milestone are both set. Filing is not authorization to start any of them.
5. The issue bodies point at this skill and at `podium-release` for the steps. Do not paste their steps into an issue; the two would drift.

## Running the pre-release prep

The prep is one `release-prep/<version>` worktree branch and one PR into `development`, squash-merged, the last merge of the milestone into `development`. How a branch is made is `/eengelking:git-branching`; the files and the order of the bump are in `podium-release` ("Files that change in the release-prep PR"). Do these, in this order:

1. **Confirm the start.** Every other issue of the milestone, the documentation review and the dependency update included, is closed. `git fetch origin` and branch from `origin/development`.
2. **Deprecations.** `node scripts/check-deprecations.mjs` passes. A due removal is its own PR into `development` before this branch.
3. **Changelog.** `node scripts/changelog-assemble.mjs --check`, then without `--check`. Then rename `[Unreleased]`, add a fresh one and fix the links, as `podium-release` says.
4. **Versions.** Every row of `podium-release`'s version table, `npm install --package-lock-only`, then the grep for the old version string and a look at every hit.
5. **Standards.** `podium-standards-check` on the branch. `podium-standards-update` only when `changelog.d/` held `standards` fragments (they are assembled by now; see the `Standards:` lines) with the maintainer's approval. `npm run standards:parity` passes.
6. **Patterns.** `podium-patterns-check` on the branch.
7. **Atlas.** `podium-atlas-update`, or the `podium-atlas-keeper` agent, for the version, date and line counts. `node scripts/atlas-functions.mjs --check` passes.
8. **Docs site.** `podium-docs-site`: `node site/scripts/build.mjs` builds every version and no link breaks.
9. **Live test.** `podium-live-test` on every harness, when anything in the harness contract changed since the last release. Say the model and that it spends tokens before you start. A release that changed none says so.
10. **End to end.** `podium-e2e-update`, or the `podium-e2e-keeper` agent, then `npm run e2e` on every registered database with no failure and no retry, and `node scripts/e2e-map.mjs` reports the coverage map true.
11. **Tests.** `npm test`, `npm run build`, `scripts/test-db.sh` (every adapter, never `PODIUM_TEST_ONLY`), `npm run test:core`, and each harness's `test:mod:<harness>` and `typecheck:mod:<harness>`.
12. **Last: `dist/`.** `npm run plugin:build:release`, then `npm run plugin:dist:check`. Nothing else merges into `development` after this commit and before the PR merges, or `dist/` is stale again.
13. **Archives.** The zip check from `podium-release` for both harnesses.
14. **Release check.** `podium-release`'s release check, then a fresh, non-fork Haiku agent for the run record (below). Both are report-only; neither has merge, push or edit authority. A failing second run means stop and ask.
15. **PR.** `podium-pr-workflow`: the trace check, `sonar analyze` on the changed files, and the PR checks watched to the end. The PR body is the run record.

## The run record

The prep PR body is a filled copy of `resources/prep-run-record.md`. It has one row for every step above with a result: `passed` with the command's counts, `fixed` with what, `not run` with the reason, or `failed` with the issue number that tracks it. A step that was skipped is never written as passed, and a step with no row is a step that was not done. A limited run (`SQLite only, PostgreSQL NOT RUN`) says so in the row.

### Proving it

The author's own record is a claim, so check it:

- **The main session runs the evidence checks** in the record's last section itself (they are commands with an expected output) and pastes what they print.
- **A fresh, non-fork Haiku agent audits the record** against the branch. Its prompt states its authority: it reports a verdict, and has no push, merge or edit authority. It checks that every step has a row, that each `passed` row has counts, that the evidence commands give the expected output on the branch, and that nothing merged into `development` after the `dist/` build. A row it cannot confirm is a failure.
- **A failing audit means fix and run it once more.** A second failure means stop and ask the maintainer.

Only when the record is complete and the audit passes is the PR opened. The maintainer merges it; the release issue is the next unit of work and is not started by merging this one.
