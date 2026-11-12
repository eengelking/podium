<!-- Template: the documentation review issue of a milestone.
     Placeholders to replace: <X.Y> (the milestone, such as 1.6).
     File: gh issue create --title "Review all documentation for v<X.Y> after the last code commit, before merging development into main" --body-file <file> --label documentation --label v<X.Y> --milestone v<X.Y> -->
**Type:** documentation
**Reference:** `podium-pre-release` and `podium-release` (project skills); `docs/`, `README.md`, `CONTRIBUTING.md`, `docs/atlas/`

## Context

The first of the closing issues of milestone v<X.Y> (`podium-pre-release`). Code keeps landing until the last feature or fix PR merges into `development`, so a page that was right when its PR was written can be stale once the whole set is in. This review runs after that last code commit and before the pre-release prep.

## Requirements

- Start only after the last code commit of v<X.Y> has merged into `development`.
- Read `README.md` first, top to bottom, against the code and `[Unreleased]`: what the product is, which harnesses it supports and how to install each reporter, the quick start, the documentation table and its links (`podium-release`, "The gate for this repo"). Then `CONTRIBUTING.md` and every page under `docs/`.
- Look for stale, invalid, missing or contradicting content, dead links and citations, and numbers the docs quote (versions, counts, defaults, limits). Check `docs/spec/`, `docs/architecture/`, `docs/atlas/`, `docs/e2e/COVERAGE.md` and `docs/DEPRECATIONS.md` against each other and the code. Where code and `docs/spec/` disagree, flag it and ask; do not pick a reading.
- Fix what is wrong in a PR into `development`, or file an issue for anything too large for this pass. `docs/standards/` is never edited by hand.

## Definition of Done

- Every page was read against the code, and every finding is fixed or filed.
- The fixes are merged into `development`.
- `npm test` and the docs site build pass.
- A `documentation-sync` pass has run against every commit in this issue's branch (stale, invalid, or missing doc coverage) — see the `documentation-sync` skill.

## Out of Scope

- Rewording for style alone, or restructuring the docs folders.
- Changing code, intended behavior or the design standards.

## Validation

- `npm test` (stale indexes, frontmatter, dead citations)
- `node site/scripts/build.mjs`
- `node scripts/atlas-functions.mjs --check`

## Checklist

- [ ] The last v<X.Y> code commit is merged into `development`
- [ ] `README.md` read and fixed
- [ ] `CONTRIBUTING.md` and every page under `docs/` read against the code
- [ ] Findings fixed or filed as issues
- [ ] Fixes merged into `development`
- [ ] `documentation-sync` pass completed (Definition of Done)
