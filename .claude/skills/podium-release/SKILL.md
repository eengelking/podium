---
name: podium-release
description: What is specific to Podium when cutting a release or a hotfix - the files that carry the version, the release-candidate gate for this repo, what publishing means here, and the Haiku release check. Load this alongside github-release when the maintainer says to release or prepare a version, when you open a release-prep, release or hotfix branch, when you need the list of files a version bump touches, and when versions.test.ts or mod-version-check fails. Do not start a release unprompted; this skill is only for when the maintainer has decided one.
---

# Releasing Podium

The general sequence is `github-release`, read with its `resources/development-branch.md` (this repo has a `development` branch): the release-candidate gate, `release-prep/<version>` into `development`, the `development` to `main` release PR merged with a regular merge commit, the tag, the hotfix steps and the backport. Do not restate them here. This skill holds only what that skill cannot know about Podium. `PROJECT.md` holds the rules (one version for the whole product, feature PRs never bump it, the maintainer decides on a release).

Where this repo differs from the generic skill:

- **Publish is the docs site, the `plugin-dist` branch and the reporter archive.** There is no package registry and no container registry; users build the image with `podiumctl build`. The site deploys itself when `main` moves (`.github/workflows/docs-site.yml`), so the generic publish step has nothing to run. There are two archives: `podium-reporter-<version>.zip` (#835), zipped from the built `dist/claudecode/`, and `podium-opencode-<version>.zip` (#857), zipped from `dist/opencode/` with `--harness opencode` (its manifest is `package.json`; `release.yml` builds both by `node scripts/plugin-build.mjs claudecode opencode`, and compares each against its folder on `plugin-dist`). The Claude one is made like this (run `npm run plugin:build:release` first, not `npm run plugin:build`, which stamps the dev build and the zip script refuses a stamped folder) by `scripts/podium-reporter-zip.mjs` and attached by `.github/workflows/release.yml`, which runs when the `vX.Y.Z` tag is pushed and fails if the mod's version is not the tag's. `release.yml` also runs `scripts/plugin-dist-compare.mjs`, which fails unless the zip's files and bytes equal `dist/claudecode/` on the `plugin-dist` branch. The branch is published by `plugin-dist.yml` on the push of the release PR to `main` (DECISIONS 58), which may still be running when the tag is pushed, so the script waits for a commit naming the tag's source commit. If that run published nothing because the tree was already seeded at this version, it compares with the branch tip when its version equals the tag's. After the release PR merges, check the `Plugin dist` run is green and that `plugin-dist` has the new commit. The nightly prerelease carries its own copy, built the same way and publishing no branch, named `podium-reporter-<version>-nightly-<date>.zip` and `podium-opencode-<version>-nightly-<date>.zip`.
- **Tag, then release, then check the asset.** Push the tag and make the GitHub Release right after (`release.yml` waits up to 30 minutes for it). Then check the `Release asset` run is green and `gh release view vX.Y.Z --json assets` lists `podium-reporter-X.Y.Z.zip` and `podium-opencode-X.Y.Z.zip`. If it is missing, re-run the workflow from the Actions tab (`workflow_dispatch`, with the tag).
- **After the release PR merges**, check the `Docs site` run on `main` is green and the new version is in the site's menu (`podium-docs-site`) before proposing the tag.

## The gate for this repo

The generic gate, made concrete. On the tip of `development`:

- `npm test` and `npm run build` pass (CI runs both).
- `npm run standards:parity` passes: the standards must equal the app that is about to become `main` (CI runs it on a PR into `main`). If `[Unreleased]` has `Standards:` lines, load `podium-standards-update` in the release-prep PR and bring `docs/standards/` in line.
- `npm run e2e` passes: the whole end-to-end suite, in containers, with no failure and no retry (the `E2E` workflow also runs on the release PR into `main`, on the self-hosted runners; run it locally first, since a failing spec stops a release).
- The docs site builds: `node site/scripts/build.mjs` (the release PR's `Docs site` workflow runs it).
- If the reporter (`plugin/core/` or any `plugin/<harness>/`) changed since the last release, `npm run test:core` and each harness's `test:mod:<harness>` and `typecheck:mod:<harness>` too (today `claudecode`). The harness pairs need that harness's CLI installed and cannot run in CI.

## Files that change in the release-prep PR

All in the same commit, never as a follow-up after the tag. A hotfix changes the same files with a patch bump. `scripts/versions.test.ts` fails if the versions differ.

| File | What changes |
|---|---|
| `CHANGELOG.md` | Rename `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD` and add a fresh empty `[Unreleased]` above it. Update the two links at the bottom (`[Unreleased]` compares `vX.Y.Z...HEAD`; `[X.Y.Z]` points at the release) |
| `package.json`, `server/package.json`, `frontend/package.json` | `version`, all three the new release number |
| `package-lock.json` | Run `npm install --package-lock-only` so its entries follow the manifests |
| `plugin/claudecode/.claude-plugin/plugin.json` (and the version file of any other harness that has one) | `version`, the same release number |
| `plugin/claudecode/hooks/register.ts` | `VERSION`, equal to `plugin.json` |
| `plugin/opencode/package.json` and `plugin/opencode/version.ts` | `version` and `VERSION`, the same release number (`scripts/versions.test.ts` fails if they differ from each other or from the root) |
| `docs/atlas/podium-atlas.html` | The version in the rail ("Reads from the repo at vX.Y.Z") and in the footer ("at version X.Y.Z"); the line counts under "How much is tested", the chart and its table, and the "Counted from the repository on" date, when the release changed much code (`podium-atlas-update`) |
| `server/src/fleet/compat.ts` | On a new **minor or major** only: move `max` in both entries of `REPORTER_SUPPORT` (`podium-reporter-claudecode` and `podium-reporter-opencode`) to the release's `MAJOR.MINOR.0`, or the server tells every up-to-date reporter it is newer than the server supports (SPEC 6.8; `scripts/versions.test.ts` fails for either) |

Then grep the repo for the old version string and look at every hit before assuming the table is complete. Known hits that are sample data and do not change: `docs/fixtures/report.sample.json`, the fixtures in `server/src/fleet/*.test.ts`, `docs/gotchas/`, `plugin/claudecode/hooks/scripted.ts`, the simulator's `0.1.0-sim`, and the manifest example in `docs/spec/`.

`plugin/core/` ships inside every harness, so a change only in `plugin/core/` (not in a `*.test.ts`) changes the reporter: `mod-version-check.yml` requires a `plugin.json` bump for it, and the bump level follows what `[Unreleased]` says. A new harness under `plugin/` adds a row to the table above, a `REPORTER_SUPPORT` entry of its own in `compat.ts` (#852; no entry means no version warning), and a line in `scripts/versions.test.ts`'s harness list if it keeps its version somewhere other than `.claude-plugin/plugin.json` or `package.json`.

A hotfix that changes the UI also updates `docs/standards/` in the same PR (`podium-standards-update`).

## The release check

Run `github-release`'s `resources/release-check.md` (a fresh, non-fork Haiku subagent before the release-prep PR is opened, authority stated in its prompt). It covers the generic checks: the versions agree, the CHANGELOG section and links, the old-version grep, documented numbers, the docs build, tests and the build. Give it the version-file table above as "every file that carries the version", and add these Podium checks:

- the atlas still matches the code: `docs/atlas/podium-atlas.html` carries the release version, every source file it names exists, every handler registered with `on(` in `plugin/claudecode/hooks/register.ts` has a row in `docs/atlas/ATLAS.md` and every hook row there is still registered, and a number the atlas states (a default timing, a limit, a port, a count of pages or migrations) still equals the code, checked for each part an `[Unreleased]` entry touches;
- the archive matches the version: `npm run plugin:build:release` (not `npm run plugin:build`, whose dev stamp the zip script refuses), then `node scripts/podium-reporter-zip.mjs --out <tmpdir> --expect-version X.Y.Z` succeeds and names `podium-reporter-X.Y.Z.zip`, and the same with `--harness opencode` names `podium-opencode-X.Y.Z.zip` (so the tag to come will match the archives `release.yml` builds);
- every built harness carries the product version: after `npm run plugin:build:release`, each harness's manifest `version` (`.claude-plugin/plugin.json`; `package.json` for opencode) equals the root `package.json` `version` (`scripts/plugin-publish.mjs` refuses a mismatch when it publishes, so catch it here, before the release PR) and no built folder holds `.claude-plugin/dev-build.json`;
- `plugin-dist` is consistent with the release: `git fetch origin plugin-dist` and `git show origin/plugin-dist:dist/claudecode/.claude-plugin/plugin.json` give the previous release's version, or this one when the branch was seeded from the release-candidate branch (#927), and never a version above the one being released;
- the docs site builds for every version (`node site/scripts/build.mjs`), and no link is broken;
- the end-to-end suite passed on the tip of `development` (`npm run e2e`, run locally), and `node scripts/e2e-map.mjs` reports the coverage map true;
- `npm run standards:parity` passes, and the standards were brought in line when `[Unreleased]` has `Standards:` lines (`git diff --stat docs/standards` is not empty then).

Fix every failure and run the agent once more; if the second run still fails, stop and ask. Run `npm test` and `npm run build` yourself too.
