<!-- Template: the pre-release prep issue of a milestone.
     Placeholders to replace: <X.Y> (the milestone, such as 1.6) and <X.Y.0> (the version, such as 1.6.0).
     File: gh issue create --title "Pre-release prep for v<X.Y>: versions, final checks and the last merge into development" --body-file <file> --label housekeeping --label v<X.Y> --milestone v<X.Y> -->
**Type:** other
**Reference:** `podium-pre-release` (the steps and the run record) and `podium-release` (the files, the gate and the release check), both project skills; `.claude/PROJECT.md` (Releases)

## Context

The issue before the last of milestone v<X.Y>. Every other v<X.Y> issue, the documentation review and the dependency update included, is merged. This issue gets `development` ready to ship and is the final merge of the milestone into `development`. The release is the next issue.

## Requirements

- Do every step in `podium-pre-release`, "Running the pre-release prep", in its order, on one `release-prep/<X.Y.0>` worktree branch, and open one PR into `development` (squash-merged by the maintainer).
- The PR body is a filled `resources/prep-run-record.md` from `podium-pre-release`: one row for every step, with counts, or the reason it was not run.
- The record passes the evidence checks run by the main session and the audit by a fresh, non-fork Haiku agent with report-only authority.
- Nothing merges into `development` between the `dist/` rebuild and the merge of this PR.

## Definition of Done

- The `release-prep/<X.Y.0>` PR is merged into `development`, and `development` has no known failing test, check or regression.
- Every versioned file carries <X.Y.0>, `CHANGELOG.md` has a dated `[<X.Y.0>]` section with a fresh empty `[Unreleased]` above it, `changelog.d/` holds only its `README.md`, and `dist/` equals a clean build.
- The run record has no row without a result, and its audit passed.
- A `documentation-sync` pass has run against every commit in this issue's branch (stale, invalid, or missing doc coverage) — see the `documentation-sync` skill.

## Out of Scope

- Merging `development` into `main`, tagging and publishing. That is the release issue.
- New features or fixes. A finding that is not trivial is filed as its own issue, and the maintainer decides whether it blocks v<X.Y>.

## Validation

- `npm test`, `npm run build`, `npm run plugin:dist:check`, `npm run standards:parity`
- `scripts/test-db.sh` on every adapter, and `npm run e2e` on every registered database
- `node scripts/atlas-functions.mjs --check`, `node site/scripts/build.mjs`
- The evidence checks in the run record

## Checklist

- [ ] All other v<X.Y> issues merged
- [ ] The steps of `podium-pre-release` done, each with a row in the run record
- [ ] The run record's evidence checks pass, and the Haiku audit passed
- [ ] PR opened into `development` and merged by the maintainer
- [ ] `documentation-sync` pass completed (Definition of Done)
