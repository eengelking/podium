---
title: "59. The built plugins are tracked in dist/ on main and checked on every PR into main (#983)"
description: "dist/ is committed in the release-prep PR, a check fails any PR into main whose dist/ is not a clean build, and the marketplace follows main."
group: "Project internals"
number: 59
date: "2026-11-04"
status: "accepted"
order: 59
---

# 59. The built plugins are tracked in dist/ on main and checked on every PR into main (#983)

*Supersedes 58 (#927): the built plugins are no longer published to a `plugin-dist` branch. Amends 12 and 56 in the places named below.*

**Context.** A marketplace plugin is copied from git, so the built `dist/<harness>/` has to exist in git. Entry 58 put it on a
separate branch that a workflow wrote after every merge to `main`. That kept build output out of the source branches, but it needed
a bot with write access, a branch to protect, a manual seed before the first release, a script that refused a dev-stamped tree,
and a release job that waited for the branch to catch up before it could compare the archive. It also left a gap that no order
of steps could close: `mod/podium-reporter` left `main` with the release, and the marketplace entry could not be moved to the
new place until the release had made it exist.

`main` moves only on a release (CLAUDE.md, Branching Model), so a release is already the moment the build is final. The root
`dist/` was git-ignored only because it once also held the desktop release zip, which now goes to `dist-zips/`.

**Decision.**

- **`dist/` is tracked.** It holds `dist/claudecode/` and `dist/opencode/`, the same built folders as before. The
  `release-prep/<version>` PR into `development` rebuilds it with `npm run plugin:build:release`, after the version bump, and
  commits it. Feature and fix PRs never touch it, so on `development` it holds the last release's build until the next
  release-prep. `main` only ever receives a release (or a hotfix) with its final build, and everything on `main` is final.
- **The build starts clean.** A build that names no harness empties the whole output folder first, so a file the source no
  longer produces cannot stay in `dist/`. A build that names a harness replaces only that harness's folder.
  `emptyDir` refuses the repo root, a folder above it, `plugin/`, `.git` and anything inside or holding them.
- **A check gates `main`.** `scripts/plugin-dist-check.mjs` (`npm run plugin:dist:check`) plans each harness's tree in memory with the
  build's own code and compares the file list and the bytes with `dist/`. It also fails on a folder or file in `dist/` that is no
  harness's build, on a dev stamp, and on a built version that is not the product's. `ci.yml` runs it on a PR into `main` and on a
  push to `main`, so a stale or hand-edited `dist/` cannot merge, and a hotfix PR is held to the same rule. It writes nothing and
  needs a reproducible build, which the build has always been: files in name order, a fixed mode, no timestamps.
- **A developer's build goes elsewhere.** `--dev-stamp` (`npm run plugin:build`, `npm run plugin:dev`) now builds into
  `dist-dev/`, which is git-ignored, so the tracked `dist/` never shows a local edit and a stamp cannot be committed by a stray
  `git add -A`. `npm run plugin:dev:cleanup` removes `dist-dev/`, `.build-test/` and `dist-zips/`, and never `dist/`. Claude Code is
  run from a checkout with `claude --plugin-dir dist-dev/claudecode`. This amends 56.
- **The marketplace follows `main`.** The entry in `eengelking-marketplace` is `git-subdir` with `path: dist/claudecode`, no `ref`
  and no `sha`, which is what the `mod/podium-reporter` entry was. A release reaches an installed copy as a new commit on `main`
  with a bumped version in `plugin.json`. The maintainer moves the pointer in the skills repo at the moment the release is cut,
  so the window in which a new install would fail is seconds. This amends 12. OpenCode installs from
  `git+https://github.com/eengelking/podium.git#main::path:dist/opencode`.
- **The release zip.** It is unchanged in purpose: Claude Desktop installs a plugin only from an archive (#835), and a nightly
  stays a GitHub prerelease with its zip. `release.yml` now runs the check, zips the tracked `dist/` without rebuilding it, and
  `scripts/plugin-dist-compare.mjs` fails the release when a zip differs from `dist/<harness>/` in the tag's checkout. There is
  nothing to wait for. The nightly builds into its own throwaway checkout and never changes the tracked `dist/`.
- **Gone.** `plugin-dist.yml`, `scripts/plugin-publish.mjs`, the `plugin-dist` branch, the manual seed, and the branch-protection
  setting that entry 58 listed as a cost.

**Why.** One place holds the source of truth, and it is `main`. The check does what the publish job's tests did, before the merge
instead of after it, and a failing check blocks the release instead of leaving the marketplace on an older commit. Nothing writes to a
branch behind the maintainer's back, and the cutover needs no seeding.

**Alternatives.** Keeping `plugin-dist` and seeding it from a `release-candidate/*` branch before the release closes the gap, but
only with a manual push, and it keeps the bot, the protection setting and the wait. Pinning the marketplace by `sha` would need an
edit for every release.

**Cost.** Built files are in the repo and in the release PR's diff, about the size of the reporter's source twice over, and they add
to history at each release. The release PR is the only PR that changes them, so the review noise stays in one place. A commit that
lands on `development` after release-prep makes `dist/` stale, and the check fails the release PR until release-prep is redone.
Code scanning sees each reporter file twice, once in `plugin/` and once in `dist/`; see `sonar-project.properties` for what is
excluded from coverage and duplication. Entry 12's rule that a plugin fix needs a version bump to reach users still holds.
