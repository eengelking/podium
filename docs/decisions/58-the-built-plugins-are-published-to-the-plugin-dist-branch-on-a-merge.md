---
title: "58. The built plugins are published to the plugin-dist branch on a merge to main (#927)"
description: "The marketplace pins ref plugin-dist and path dist/claudecode, plugin-dist.yml publishes each release there, and the release zip is checked against it."
group: "Project internals"
number: 58
date: "2026-11-02"
status: "accepted"
order: 58
---

# 58. The built plugins are published to the plugin-dist branch on a merge to main (#927)

*Amends 12: the plugin is still in this repo and listed from `eengelking-marketplace`, but the listing points at built output on a branch, not at a source folder on `main`.*

**Context.** A marketplace plugin is copied from git at a ref, so the built `dist/<harness>/` has to exist in git somewhere. `dist/`
is git-ignored on `main` and `development`. Entry 12's listing, with no `ref`, followed `main`, and `mod/podium-reporter` no longer
exists there.

**Decision.**

- **Where it is published.** `.github/workflows/plugin-dist.yml` runs on a push to `main` and on `workflow_dispatch`. It runs
  `npm test` and `npm run build`, builds every harness with `scripts/plugin-build.mjs`, and runs `scripts/plugin-publish.mjs`,
  which commits the built `dist/` as a new commit on top of the `plugin-dist` branch. It never force-pushes and never touches
  `main` or `development`. A tree equal to the branch's publishes nothing, so a rerun is safe. The job checks out with
  `persist-credentials: false`, so no token sits in `.git/config` while the tests run, and only the publish step gets the token,
  handed to git through `GIT_CONFIG_*` environment variables for that step alone (never in a URL or a config file). A failing step publishes nothing
  and the marketplace keeps serving the last good commit. `main` moves only on a release, so a merge to `main` is a release.
  The script refuses a source ref other than `main` or `release-candidate/*`, and refuses `main`, `development` and `master` as the
  target. A manual run may name another target branch, which is how it is tested without touching `plugin-dist`. The dev stamp
  (56) is never written here, and the script refuses a tree that has one.
- **How the marketplace points at it.** The entry in `eengelking-marketplace` is `git-subdir` with `ref: plugin-dist` and `path:
  dist/claudecode`, and no `sha`. The product and the reporter are versioned together and `plugin.json` pins the version, so
  a release reaches an installed copy as a new commit on `plugin-dist` with a bumped version, with no edit to the marketplace.
  The marketplace change is #928, and what an installed copy does on update is checked there.
- **The release zip.** `release.yml` builds `podium-reporter-<version>.zip` into `dist-zips/` (git-ignored, and never `dist/`, which
  holds the build trees) from the same build, and `scripts/plugin-dist-compare.mjs` fails the release when its file list or bytes
  differ from `dist/claudecode/` on `plugin-dist`. The tag can be pushed before the publish run finishes, so the script waits for
  a `plugin-dist` commit whose message names the tag's source commit, for up to 900 seconds by default (`release.yml` passes the
  same). After a grace period of 300 seconds it compares with the branch tip instead, when that tip's `plugin.json` version
  equals the tag's, because the cutover below makes the release's own run publish nothing (the seed already holds that tree).
- **No nightly branch.** A nightly stays a GitHub prerelease with its zip. It builds through the same script and publishes no
  branch.
- **The cutover order.** `mod/podium-reporter` leaves `main` at the first release that contains #927, and an entry with no
  `ref` follows `main`. So the restructure merges into `development`; a `release-candidate/*` branch is cut from `main` with
  only the restructure applied, and `plugin-dist` is seeded from it with `workflow_dispatch`; the marketplace change (#928)
  merges and an install from it is checked; then the release PR merges and its own run publishes. The seed and the release
  carry the same version.

**Why.** A dedicated branch of build output keeps built files out of `main` and `development`, and a plain `ref` is the smallest
marketplace change that never has to be edited again. Pinning by `sha` would need an edit for every release.

**Cost.** The workflow asks for `contents: write` on that job only, but nothing in the code lets the bot push to `plugin-dist`
or stops a force-push to it. That is a repository setting (the branch's protection) that the maintainer has to configure, and the
publish fails until it is. A release has a step that is easy to forget: check that the seed and the release agree. Entry 12's rule that a plugin fix needs a version bump to reach
users still holds.

<!-- nav:start -->
---

Previous: [57. The report types and the shared reporter code live once, in plugin/core (#927)](57-the-report-types-and-shared-reporter-code-live-once-in-plugin-core.md) · Up: [Decisions](README.md)
<!-- nav:end -->
