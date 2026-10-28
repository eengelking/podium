---
name: podium-release
description: Cut a Podium release or a hotfix - the release-candidate gate, the release-prep/<version> PR, the list of files that carry the version, the development-to-main release PR, the tag, the hotfix and its backport, and the Haiku release check. Load this when the maintainer says to release or prepare a version, when you open a release-prep, release or hotfix branch, when you need the list of files a version bump touches, when versions.test.ts or mod-version-check fails, and when a hotfix needs a backport. Do not start a release unprompted; this skill is only for when the maintainer has decided one.
---

# Releasing Podium

`github-release` owns the general steps; this is what is specific to this repo. `PROJECT.md` holds the rules: one version for the whole product, feature PRs never bump it, a release is the maintainer's decision, and how the bump level is chosen. This skill is the sequence.

## Verify first (the release-candidate gate)

- `npm test` and `npm run build` pass on the tip of `development` (CI runs both).
- `npm run standards:parity` passes: the standards must equal the app that is about to become `main` (CI runs it on a PR into `main`).
- The docs site builds: `node site/scripts/build.mjs` (the release PR's `Docs site` workflow runs it).
- If the mod changed since the last release, `npm run test:mod` and `npm run typecheck:mod` too. They need Claude Code installed and cannot run in CI.
- The release PR's CI is green. `development` may be broken between releases; fix it with ordinary PRs, and do not open the release PR with a known failure.

## Sequence

1. Verify `development` (the gate above).
2. Branch `release-prep/<version>` from `development` as a worktree (`podium-worktree`). In one commit, change every file in the table below. If `[Unreleased]` has `Standards:` lines, load `podium-standards-update` in that PR and bring `docs/standards/` in line with the code that is about to become `main`. Run the release check below, then open a PR into `development`, to be squash-merged.
3. After the user merges it, open `development` to `main`. The body says it is to be merged with a regular merge commit and not squashed, names the version and quotes the CHANGELOG section. It carries no `Closes #N`; the issues closed when their own PRs merged. Check the merge dropdown before merging, since `gh pr merge` remembers the last method.
4. After the user merges that, check the `Docs site` run on `main` is green and the new version is in the site's menu (the site builds on every push to `main`; see `podium-docs-site`), sync `main` and `development`, propose the tag and wait for approval.

**Publish** is the docs site and nothing else. There is no package registry and no container registry; users build the image with `podiumctl build`. The site deploys itself when `main` moves (`.github/workflows/docs-site.yml`), so the `github-release` publish step has nothing to run; confirm the deploy instead.

**Tag and GitHub Release:** `vMAJOR.MINOR.PATCH`, annotated, from `main` after the release PR has merged; tag the merge commit. The release notes are the CHANGELOG section verbatim. Propose the tag and wait for approval; never push one unprompted.

## Files that change in the release-prep PR

All in the same commit, never as a follow-up after the tag. `scripts/versions.test.ts` fails if the versions differ.

| File | What changes |
|---|---|
| `CHANGELOG.md` | Rename `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD` and add a fresh empty `[Unreleased]` above it. Update the two links at the bottom (`[Unreleased]` compares `vX.Y.Z...HEAD`; `[X.Y.Z]` points at the release) |
| `package.json`, `server/package.json`, `frontend/package.json` | `version`, all three the new release number |
| `package-lock.json` | Run `npm install --package-lock-only` so its entries follow the manifests |
| `mod/podium-reporter/.claude-plugin/plugin.json` | `version`, the same release number |
| `mod/podium-reporter/hooks/register.ts` | `VERSION`, equal to `plugin.json` |
| `docs/atlas/podium-atlas.html` | The version in the rail ("Reads from the repo at vX.Y.Z") and in the footer ("at version X.Y.Z"); the line counts under "How much is tested", the chart and its table, and the "Counted from the repository on" date, when the release changed much code (`podium-atlas-update`) |
| `server/src/fleet/compat.ts` | On a new **minor or major** only: move `max` in `REPORTER_SUPPORT` to the release's `MAJOR.MINOR.0`, or the server tells every up-to-date mod it is newer than the server supports (SPEC 6.8) |

Then grep the repo for the old version string and look at every hit before assuming the table is complete. Known hits that are sample data and do not change: `docs/fixtures/report.sample.json`, the fixtures in `server/src/fleet/*.test.ts`, `docs/gotchas/`, `mod/podium-reporter/hooks/scripted.ts`, the simulator's `0.1.0-sim`, and the manifest example in `docs/spec/`.

## Hotfixes

1. Branch `hotfix/<n>-<slug>` from `main` as a worktree (`podium-worktree`, base `origin/main`).
2. Write the failing test first, then fix.
3. Bump the patch version in every file in the table and add a `[X.Y.Z]` section to `CHANGELOG.md`. A hotfix never moves `[Unreleased]`.
4. A hotfix that changes the UI updates `docs/standards/` in the same PR (`podium-standards-update`).
5. PR into `main` with `Closes #N`; the user merges, then tag as above.
6. The backport waits for the user to say so: branch `hotfix/<n>-<slug>-backport` from `development`, `git cherry-pick -x` every commit, keep the hotfix's CHANGELOG section below `[Unreleased]`, and put `Refs #N` in that PR.

If a release-prep PR is already merged but unreleased, stop and ask how to order them.

## The release check

Before the release-prep PR is opened, start a fresh, non-fork subagent on Haiku (the Agent tool with `model: "haiku"` and no `subagent_type: "fork"`; a fork would inherit merge authority). Its prompt names the version and states its authority: "report a verdict; you do not have merge, tag or push authority, and you do not edit files." It checks that:

- every file in the table above carries the release version, and the versions agree with each other;
- `CHANGELOG.md` has a `[X.Y.Z]` section for exactly this version, dated, holding the changes that accumulated under `[Unreleased]`, with a fresh empty `[Unreleased]` above it and the two links at the bottom right;
- the grep for the old version string has been looked at, listing each hit that is not a known sample-data one;
- the atlas still matches the code: `docs/atlas/podium-atlas.html` carries the release version, every source file it names exists, every handler registered with `on(` in `mod/podium-reporter/hooks/register.ts` has a row in `docs/atlas/ATLAS.md` and every hook row there is still registered, and a number the atlas states (a default timing, a limit, a port, a count of pages or migrations) still equals the code, checked for each part an `[Unreleased]` entry touches;
- the docs site builds for every version (`node site/scripts/build.mjs`), and no link is broken;
- `npm test`, `npm run build` and `npm run standards:parity` pass, and the standards were brought in line when `[Unreleased]` has `Standards:` lines (`git diff --stat docs/standards` is not empty then).

It reports a short pass/fail list, with the file and line of each mismatch. Fix every failure and run the agent once more; if the second run still fails, stop and ask. A pass is a claim, not the check: run `npm test` and `npm run build` yourself too, as you do before any PR.
