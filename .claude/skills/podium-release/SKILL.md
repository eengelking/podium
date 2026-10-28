---
name: podium-release
description: What is specific to Podium when cutting a release or a hotfix - the files that carry the version, the release-candidate gate for this repo, what publishing means here, and the Haiku release check. Load this alongside github-release when the maintainer says to release or prepare a version, when you open a release-prep, release or hotfix branch, when you need the list of files a version bump touches, and when versions.test.ts or mod-version-check fails. Do not start a release unprompted; this skill is only for when the maintainer has decided one.
---

# Releasing Podium

The general sequence is `github-release`, read with its `resources/development-branch.md` (this repo has a `development` branch): the release-candidate gate, `release-prep/<version>` into `development`, the `development` to `main` release PR merged with a regular merge commit, the tag, the hotfix steps and the backport. Do not restate them here. This skill holds only what that skill cannot know about Podium. `PROJECT.md` holds the rules (one version for the whole product, feature PRs never bump it, the maintainer decides on a release).

Where this repo differs from the generic skill:

- **The release PR carries no `Closes #N`.** The issues closed when their own PRs merged (`PROJECT.md`, "Closing issues"). The hotfix PR into `main` does carry `Closes #N`; its backport carries `Refs #N`.
- **Publish is the docs site and nothing else.** There is no package registry and no container registry; users build the image with `podiumctl build`. The site deploys itself when `main` moves (`.github/workflows/docs-site.yml`), so the generic publish step has nothing to run.
- **After the release PR merges**, check the `Docs site` run on `main` is green and the new version is in the site's menu (`podium-docs-site`) before proposing the tag.
- **Branches are worktrees** (`podium-worktree`): `release-prep/<version>` from `origin/development`, a hotfix from `origin/main`.

## The gate for this repo

The generic gate, made concrete. On the tip of `development`:

- `npm test` and `npm run build` pass (CI runs both).
- `npm run standards:parity` passes: the standards must equal the app that is about to become `main` (CI runs it on a PR into `main`). If `[Unreleased]` has `Standards:` lines, load `podium-standards-update` in the release-prep PR and bring `docs/standards/` in line.
- The docs site builds: `node site/scripts/build.mjs` (the release PR's `Docs site` workflow runs it).
- If the mod changed since the last release, `npm run test:mod` and `npm run typecheck:mod` too. They need Claude Code installed and cannot run in CI.

## Files that change in the release-prep PR

All in the same commit, never as a follow-up after the tag. A hotfix changes the same files with a patch bump. `scripts/versions.test.ts` fails if the versions differ.

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

A hotfix that changes the UI also updates `docs/standards/` in the same PR (`podium-standards-update`).

## The release check

Before the release-prep PR is opened, start a fresh, non-fork subagent on Haiku (the Agent tool with `model: "haiku"` and no `subagent_type: "fork"`). Its prompt names the version and states its authority: "report a verdict; you do not have merge, tag or push authority, and you do not edit files." It checks that:

- every file in the table above carries the release version, and the versions agree with each other;
- `CHANGELOG.md` has a `[X.Y.Z]` section for exactly this version, dated, holding the changes that accumulated under `[Unreleased]`, with a fresh empty `[Unreleased]` above it and the two links at the bottom right;
- the grep for the old version string has been looked at, listing each hit that is not a known sample-data one;
- the atlas still matches the code: `docs/atlas/podium-atlas.html` carries the release version, every source file it names exists, every handler registered with `on(` in `mod/podium-reporter/hooks/register.ts` has a row in `docs/atlas/ATLAS.md` and every hook row there is still registered, and a number the atlas states (a default timing, a limit, a port, a count of pages or migrations) still equals the code, checked for each part an `[Unreleased]` entry touches;
- the docs site builds for every version (`node site/scripts/build.mjs`), and no link is broken;
- `npm test`, `npm run build` and `npm run standards:parity` pass, and the standards were brought in line when `[Unreleased]` has `Standards:` lines (`git diff --stat docs/standards` is not empty then).

It reports a short pass/fail list, with the file and line of each mismatch. Fix every failure and run the agent once more; if the second run still fails, stop and ask. A pass is a claim, not the check: run `npm test` and `npm run build` yourself too, as you do before any PR.
