<!-- Template: the release issue of a milestone, the last issue in it.
     Placeholders to replace: <X.Y> (the milestone, such as 1.6) and <X.Y.0> (the version, such as 1.6.0).
     File: gh issue create --title "Release v<X.Y>: merge development into main, tag and publish" --body-file <file> --label housekeeping --label v<X.Y> --milestone v<X.Y>
     Filing it is not authorization to start it: a release is the maintainer's decision. -->
**Type:** other
**Reference:** `podium-release` and `podium-pre-release` (project skills); `/eengelking:github-release`; `.claude/PROJECT.md` (Releases)

## Context

The last issue of milestone v<X.Y>. The pre-release prep issue is done and its `release-prep/<X.Y.0>` PR is merged into `development`. This issue moves `development` into `main` and cuts v<X.Y.0>.

## Requirements

- Start only when the maintainer decides `development` is a release candidate. Do not start it unprompted.
- Open a PR from `development` to `main`, merged by the maintainer with a regular merge commit, never squashed. Its body names <X.Y.0> and quotes the `CHANGELOG.md` section (its entry headlines when the section is too long for a PR body, with a link). It carries no `Closes #N`.
- Before the PR is opened, the release check (`podium-release`, "The release check") passes, and `npm test` and `npm run build` pass when run by hand.
- Every check on the PR passes, including `npm run plugin:dist:check`, `mod-version-check`, `Docs site`, and the `E2E` workflow on every database, with `E2E summary` showing none skipped.
- After the merge: check `dist/claudecode/.claude-plugin/plugin.json` on `main` has <X.Y.0>, the marketplace entry points at `dist/claudecode` (the maintainer moves it), the `Docs site` run on `main` is green and the new version is in the menu.
- With the maintainer's approval, tag `v<X.Y.0>` and publish the GitHub Release with the CHANGELOG section as its notes. Check the `Release asset` run is green and `gh release view v<X.Y.0> --json assets` lists `podium-reporter-<X.Y.0>.zip` and `podium-opencode-<X.Y.0>.zip`.
- Close the v<X.Y> milestone after checking every issue in it is closed.

## Definition of Done

- `main` holds <X.Y.0>, tagged and released, with both archives attached.
- `git fetch origin && git diff --quiet origin/main origin/development` exits 0.
- The docs site shows <X.Y.0>, and the milestone is closed with no open issue.
- A `documentation-sync` pass has run against every commit in this issue's branch (stale, invalid, or missing doc coverage) — see the `documentation-sync` skill.

## Out of Scope

- Version bumps, changelog assembly and the pre-release checks (the prep issue).
- A hotfix after the release, which is its own issue and PR.

## Validation

- `gh pr checks <PR> --watch` passes on the release PR.
- `gh release view v<X.Y.0>` shows both archives.
- The `git diff --quiet` check above.

## Checklist

- [ ] The maintainer confirms `development` is a release candidate
- [ ] Release check passed; release PR opened from `development` to `main`, every check green
- [ ] Merged by the maintainer with a merge commit, not a squash
- [ ] `plugin.json` on `main`, marketplace entry and docs site checked
- [ ] Tag `v<X.Y.0>` approved and pushed; GitHub Release published; both archives attached
- [ ] The v<X.Y> milestone closed
- [ ] `documentation-sync` pass completed (Definition of Done)
