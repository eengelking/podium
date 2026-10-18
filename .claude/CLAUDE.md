# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## Project Overview

Podium is a live fleet console for Claude Code. It shows every session running on one machine in one
browser tab: each orchestrator's model, effort, plan, the agents it launched, what they cost, how full
their context windows are, why anything failed, and which git branch it works in. It is for someone who
runs several Claude Code sessions and agents at once and wants to see what they are doing and costing
without watching each terminal. Podium watches, and it can also answer a session that waits on its person
(a question, a plan, a tool's permission prompt, a message, `/clear` or `/compact`), only where the Admin and the
session's owner have both turned that on. It never types into a terminal or changes a session's permission rules.

It ships as a server and UI (this repo, run with `podiumctl` in a Podman container or as a plain Node
process) and a reporter mod, `podium-reporter`, installed from `eengelking-marketplace`. `docs/SPEC.md` is
the source of truth for intended behavior; `docs/ARCHITECTURE.md` records how it was built.

## Shortcuts

The operator uses shorthand in place of typing a full request out. Case-insensitive — treat any casing the same. Expand the shorthand below and act on it as if the full phrase had been typed. Add project- or user-specific entries as they come up.

| Shorthand | Expands to |
|---|---|
| `plmk` | "Please let me know if you have any questions or if I can provide any further context and/or information." |
| `wni` | "What is the next GitHub issue to resolve?" |
| `pmm` | "PR has been merged to main." |
| `cii` | "Please review outstanding docs/ISSUES.md and create GitHub issues for anything not yet tracked. Let me know when done." |
| `pnb` | "Please process the next batch of queued items." |

## Do Not

- Edit directly on, push to, or merge a PR into `main` or `development` yourself — for any change, no matter how small (a one-line doc fix included) or how informal (no tracking issue). Changes reach either branch only through a PR, and merging is always the user's call, no exceptions. See "Always Branch First" below.
- Commit secrets, API keys, tokens, or credentials.
- Force-push, skip commit safety checks, or bypass signing without the user's explicit, in-the-moment approval.
- Hard-code a color, or author a mockup or any UI with a `:root` block of its own. Colors are tokens from `frontend/src/fleet/tokens.css`. See "UI Standards".
- Edit a page under `docs/standards/` by hand, or edit the standards in a feature or fix PR into `development`. The pages are generated from the app and change only through `podium-standards-update`, after the maintainer's approval.
- Delegate any task via a fork, no matter how narrow or read-only it looks — no exception.
- Start implementing an issue just because it (or you) filed it — filing and authorization are separate steps.
- Create a new standing doc when an existing one can hold the content.
- Document architecture in this file — use `docs/ARCHITECTURE.md`.
- Record current-state facts or status narrative in this file — facts belong in `CHANGELOG.md`; narrative belongs in commit history, PR descriptions, or `docs/ISSUES.md`.
- Silently pick a reading, or "fix" it in passing, when code and `docs/SPEC.md` disagree — flag the contradiction and ask.
- Re-invoke `/code-review` a second time on the same diff "to confirm" a fix. There's no defined stopping rule for a fix→review→fix cycle, and the review skill's own finder/verifier fan-out is not guaranteed to converge on a repeat run — it can spawn a large batch of sub-agents and stall indefinitely. Verify fixes by running the project's own test/lint suite directly instead (see the Review (pre-PR) row below); if that fails, stop and ask rather than looping back into another review round.

## Branching Model

Two workflows exist. Whether a `development` branch exists on the remote picks which one applies:

```bash
git ls-remote --exit-code --heads origin development
```

Exit 0 means the development-branch workflow; any other exit means the standard workflow. Creating `development` is the opt-in, and the GitHub default branch stays `main` so a plain clone gets released code.

This repo has a `development` branch, so it uses the development-branch workflow. Every PR goes **branch → `development` → `main`**.

- `development` holds unreleased work and may be broken at any given time. Feature and fix PRs target it and are squash-merged.
- `main` only moves on a release or a hotfix. A release is a PR from `development` to `main`, merged with a regular merge commit, never squashed (squashing makes the branches diverge). That PR is the release-candidate gate: it is valid only if all tests pass, with no breaking tests, conditions, or regressions.
- The version bump happens in a `release-prep/<version>` PR into `development`, not in feature PRs. Feature PRs only add to `CHANGELOG.md`'s `[Unreleased]` section. The bump level comes from what accumulated there, per the SemVer rules in `github-release`. See Releases.
- Hotfixes branch from `main`, go to `main` by PR, and bump the patch version. The fix is then cherry-picked into `development` by a follow-up PR, when the user instructs it, so the branches don't drift.
- The integration branch is the throwaway branch an orchestrator creates for a parallel batch. It is not `development`. It is created off `development` and its final PR targets `development`.

GitHub's default branch stays `main` on purpose. Do not change it.

**Closing issues (this repo overrides the skills here).** The installed skills say feature PRs use `Refs #N` and the release PR carries `Closes #N`. This repo does the opposite:

- A feature, fix or batch-final PR into `development` carries `Closes #N` for the issues it resolves, and the issue is closed when that PR merges. GitHub only acts on closing keywords for a PR into the default branch, so it will not do this by itself: after confirming the merge, close each issue with `gh issue close <N> --comment "Fixed in #<PR>; ships with the next release."` (the `pmm` step). Say in the issue that the change is on `development` and ships with the next release.
- The `development` to `main` release PR closes nothing and carries no `Closes #N`. Its body names the version and quotes the CHANGELOG section.
- The exception is a hotfix. The hotfix PR into `main` carries `Closes #N`, which GitHub honors because `main` is the default branch. Its backport PR into `development` carries `Refs #N`.
- A sub-agent's PR into a batch integration branch still claims no `Closes #N`.

Below, "the base branch" means `development` if it exists and `main` otherwise. Procedure lives in `git-branching`, `github-pr-merge`, `github-issue-workflow`, and `github-release`.

## Always Branch First

Before the first `Edit` or `Write` of *any* change to this repo — check the current branch. If it's `main` or `development`, create or switch to a working branch before touching a single file. Fork from the base branch (from `main` for hotfixes). This holds regardless of size ("just a typo fix"), formality ("no issue for this, just drafting"), or how the request was phrased ("draft a revised README" is still a change once you start writing it to disk) — the decision to skip a tracking issue and the decision to skip a branch are unrelated, and only the first is ever legitimate. See `git-branching` for the mechanics, including the pre-commit hook that backstops this rule technically rather than relying on memory alone. The hook should block commits on both `main` and `development`.

## Skills

Procedural detail — the *how* behind the rules this file states — lives in skills, loaded on demand rather than carried in every session's context. "Orchestrator" means whichever agent is coordinating a piece of work (driving a single issue end to end, or running a parallel batch); "sub-agent" means an agent it spawned to do a scoped piece of that work. For a single issue worked solo, there's only one agent, so both columns apply to it.

| Skill | Load it when... | Orchestrator | Sub-agent |
|---|---|---|---|
| `git-branching` | Creating any branch — for an issue, a sub-agent, or a batch integration branch | Creates the batch integration branch (if parallel) | Branches off the base branch (solo work) or off the integration branch (parallel batch) |
| `github-pr-merge` | Opening a PR; running any merge command; proposing a release tag | Reviews and merges a sub-agent's PR into the integration branch; never merges into `main` or `development` | Opens its own PR; never merges any PR itself |
| `github-release` | Cutting a release: when the maintainer decides `development` is a release candidate (see Releases) | Runs the release steps | N/A — releases aren't a sub-agent's job |
| `github-issue-filing` | Filing issues — grouping related reports, checking for duplicates | Runs standalone, on explicit request | Same as orchestrator |
| `github-issue-workflow` | Starting, resuming, or closing GitHub-issue-tracked work | Decides sequencing and whether a parallel batch applies | Follows the same checklist/Validation discipline within its own issue |
| `documentation-sync` | Before committing any change. Writing or changing a doc also follows "Writing docs" in `CONTRIBUTING.md` | Runs the batch-wide consolidation commit (if parallel) | Keeps its own PR's changes in sync |
| `documentation-bootstrap` | Backfilling or topping up a project's missing doc set (bulk scaffolding, not a single commit's worth of sync) | Runs the doc-type selection pass, sets the sequencing rule, and runs the parallel batch (integration branch, post-bootstrap validation) | Writes its one assigned doc type per the orchestrator's sequencing rule; no merge authority |
| `development-commands` | Running tests/lint, starting the app for UI review, seeding a database | Yes | Yes |
| `git-safety` | Force-push, skipping commit checks, secrets review | Yes | Yes |
| `podium-standards-check` (project, `.claude/skills/`) | Doing any UI work: a screen, component, mockup, CSS, color or wording; and before opening a PR that touches `frontend/` or `mockup/`. Also for a platform audit | Runs it on the branch before the PR; may run the `podium-ui-auditor` agent for a read-only audit | Runs it on its own change; reports deviations, edits no standard |
| `podium-standards-update` (project, `.claude/skills/`) | A standard must change: in the `release-prep/<version>` PR when `[Unreleased]` has `Standards:` lines, in a hotfix that changes the UI, or when the maintainer approves a change | Runs it in release-prep and hotfix PRs | N/A, never a sub-agent's job |
| `retrospective` | Asked for a retrospective, or "what went well/could be improved," after nontrivial or multi-agent work | Yes | Yes |

## Working Style

- **Prefer acting to asking** when the request and the codebase together make the right move obvious; ask when you're genuinely blocked — ambiguous intent, a decision only the user can make, or a destructive/hard-to-reverse action.
- **Verify with real runs, not just lint/build.** A passing type-check or test suite verifies correctness, not that the feature actually works. Where practical, run the thing and exercise the change before calling it done — and say so explicitly when you can't (no way to run the app, no browser access, etc.) rather than implying it was checked.
- **Leave no mess behind.** Stop dev servers you started, close browser tabs you opened, delete branches once their merge is confirmed. A task isn't finished just because the code is right — clean up the process/session state too. Validate the cleanup completed successfully and left no orphans behind.
- **Run `sonar analyze` on the files you changed before opening a PR**, so a fix does not start a loop with the SonarCloud quality gate: `sonar analyze --file <path> [--file <path> ...] 2>&1 | tail -40`. It always runs the secrets scan; the code analysis can come back `[SKIPPED]` ("Vortex analysis is not available on this connection"), and when it does, say so rather than calling the files clean. Whether or not it runs, write the fix so it does not trip a rule of its own: no control characters in a regex literal (`typescript:S6324`), `replaceAll` over `replace` with a global regex, and `Number.parseInt`/`Number.NaN` over the globals (#366). The gate also needs 80% coverage on new lines, and `sonar analyze` does not measure that: every line you add or edit needs a test that reaches it, or leave the line alone (#367's first push failed the gate at 44% for untested log call sites).
- **Don't let a stale run fool you.** If you changed code, restart whatever's serving it before treating its behavior as evidence. Testing against cached/stale state produces false confidence.
- **If this project has a `docs/NON_NEGOTIABLES.md`, read it before starting any task.** Its constraints are absolute — they don't get traded away for convenience, ever.
- **Prefer a fresh session per PR or unit of work** rather than accumulating context across many PRs in one long-running session. A long session replays its whole accumulated transcript every turn; starting fresh per PR keeps that small instead of letting it compound.
- **When fixing a bug in code, first write a test that reproduces the failure and confirm it fails for the expected reason, before writing the fix.** A test only ever run against the fixed code doesn't prove it would have caught the regression. This applies to code fixes specifically — it doesn't apply to documentation or other non-code changes.
- **When waiting on a background agent or task, wait for it properly rather than repeatedly checking its status in a loop.** Polling — check, wait a bit, check again — burns tokens re-sending the whole conversation on every check, for no benefit over a real blocking wait. This is a real, recurring waste, not a hypothetical: an orchestrator managing sub-agents or background work is exactly where this loop tends to happen.
- **Before writing a one-off helper script, check whether `scripts/` already has one that does the job** (if it exists — otherwise create it). Run the candidate with `--help`/`-h` to confirm what it does rather than assuming from its name. If nothing fits, write the new script into `scripts/`, give it a `--help`/`-h` flag, and keep it there rather than deleting it once the task is done — a future agent solving the same problem should find it instead of re-writing it from scratch.

## UI Standards

The design system is `docs/standards/` (open `index.html`): tokens, themes, every component rendered from the app with its states, patterns, voice, accessibility and process. It is generated from the app on `main` and a test fails if it differs, so it says what production does. The rules in it bind every agent and every person, and they win over the global `frontend-design` and `dataviz` skills where they disagree.

- **Before any UI work**, read the page you need (`components.html` for what exists, `patterns.html` for the rule, `tokens.html` for a color) and load `podium-standards-check`. Run it again on your change before the PR.
- **A mockup comes first** for a new screen, component, pattern or visible change (the global rule), and it links `frontend/src/fleet/tokens.css`. It does not carry a `:root` block. It shows light and dark and a narrow width, and the maintainer accepts it before any code.
- **Colors are tokens** from `tokens.css`, the one place a color token is defined. `npm test` fails on a hard-coded color that is not on `docs/standards/deferred.json`, on a `var(--x)` nothing defines, and on a theme below the contrast targets.
- **Reuse a component or class that exists.** A new component or pattern is added to the standards in the PR that introduces it, never invented inside one feature.
- **The wall-notice rules**: bottom of the wall, an X, a confirmation that points to Admin > Settings, an on/off switch there, and errors are never notices. The rest of the patterns (paging, status shape plus word plus color, consent, the primary button, copy, empty states) are on `patterns.html`.
- **Changing a standard** is the maintainer's decision. A feature or fix PR into `development` does not edit the standards. It adds a `Standards:` line under `[Unreleased]` in `CHANGELOG.md` naming the approved change, and the `release-prep/<version>` PR brings the standards in line using `podium-standards-update`. `npm run standards:sync` regenerates the pages and `npm run standards:parity` must then pass with no differences.
- **A checkup** of the whole app (deviations, and what no standard covers) is the read-only `podium-ui-auditor` agent. Spawn it as a fresh, non-fork agent and state its authority: it reports and does not edit, commit or merge.

## Git & GitHub Workflow

Order of operations for any tracked change. The policy is the invariant that holds regardless of mechanics; the skill covers the how.

| Phase | Policy | Skill |
|---|---|---|
| Start | Branch first, synced from current `main` (standard) or `development` (development-branch workflow). | `git-branching` |
| Review (pre-PR) | Applies only when the branch changes code (logic, scripts, config with behavioral effect) — a docs/prose-only diff (`CLAUDE.md`, `CHANGELOG.md`, `README.md`, comments) has no code for `/code-review` to check and skips this row entirely; a mixed branch still runs it, scoped to the code files. When it applies, run `/code-review` on the branch **exactly once** before opening the PR, then apply its findings with `--fix` (or explicitly defer/note larger, out-of-scope suggestions with reasoning) — never loop back into a second automated round to "confirm" the fixes. Verification of the fixed code is the orchestrator's own job, done directly against the project's real test/lint commands (`development-commands`), not by re-invoking the skill. A branch that changes `frontend/` or `mockup/` also runs `podium-standards-check` once on the branch, and fixes what it reports or says why not. If that verification passes, move on to the PR; if it fails, stop and ask the user rather than re-running review. This caps the process at one review round plus one orchestrator-run verification pass — see "Do Not" for why a second round is off the table. Reserve post-PR `--comment`/`ultra` review for a genuinely separate pass (e.g. a deeper multi-agent review, or a check the user explicitly wants visible as PR comments), never as a stand-in for pre-PR confirmation. | `code-review`, `development-commands` |
| Develop → PR | The PR targets the base branch; `plugin.json`/manifest version bumps do not happen here, and neither do edits to `docs/standards/`: a UI change the maintainer approved adds a `Standards:` line under `[Unreleased]` instead. Changes land via PR; the user reviews and merges. Once a change — issue-tracked or informal — is complete, has been through pre-PR review above, and passes its relevant checks, commit, push, and open the PR without waiting for a separate go-ahead; that's normal completion of the work, not a separate action to confirm. Opening a PR is still a stopping point, not a launchpad — it doesn't authorize starting the next unit of work unprompted, and merging remains the user's call, always. | `github-pr-merge` |
| Verify (post-PR) | After opening the PR, and after every push to it, run `gh pr checks <PR> --watch` (it blocks until every check, SonarCloud's gate included, finishes). Report it the same way each time: one line per check as `name: pass\|fail`, a link for each failure, then a verdict (all green or N failing). On a failure, find out why (`gh run view --log-failed`; for the SonarCloud gate, the PR's open issues), fix it, push, and run the check again. After 3 fix attempts on the same failure, stop and give the user the cause, what was tried, and the options. | `github-pr-merge` |
| Merge & cleanup | A branch is deleted only after its merge is confirmed, not assumed. Feature PRs into `development` are squash-merged. | `github-pr-merge` |
| Release | A release is the `development` to `main` PR described in "Branching Model", a step the user triggers, never a side effect of merging feature work. It is prepared by a `release-prep/<version>` PR into `development` and checked by a Haiku agent before the release PR is opened; the tag follows the merge and waits for the maintainer's approval. See Releases. | `github-release` |
| Hotfix | Branch from `main`, PR to `main`, bump the patch version, then cherry-pick into `development` by follow-up PR when the user instructs it. | `github-release`, `git-branching` |
| Dangerous git actions | See Do Not — a prior approval doesn't carry forward to the next instance. | `git-safety` |
| Committing | Review staged changes for anything sensitive before committing, especially in files that don't look like they'd contain any. If a secret is committed anyway, treat it as compromised and flag it to the user for rotation rather than just removing it from the latest commit. | `git-safety` |
| Remote access | The `gh` CLI is available and authenticated — use it for PRs, issues, and other GitHub operations rather than assuming it's missing. If a `git push`/`fetch`/`clone` fails with an SSH error (e.g. `git@github.com: Permission denied (publickey)`), that means this environment's SSH key isn't set up for GitHub — switch the affected remote to HTTPS (`git remote set-url origin https://github.com/<owner>/<repo>.git`) and retry, rather than treating it as a dead end or asking the user to fix SSH first. | — |

**Versioning:** If this repo opts into `spec-writing`'s Staged-DAG weight class, add a line here mapping each stage gate to the release version it produces (e.g. G-0 → `v0.1.0`, G-1 → `v0.2.0`, …) — that mapping is the one fact specific to this repo. The mechanics (independently verifying a gate before treating it as passed, what to bump and where, tagging) are `github-release`'s and `spec-writing`'s job to know, not this file's — load them when a gate task merges rather than re-deriving the steps here. Projects using Flat or Phased spec classes, or no `spec-writing` spec at all, don't need this row.

## Releases

`github-release` owns the steps. This is what is specific to this repo.

- **Verify first:** `npm test` and `npm run build` (CI runs both), and `npm run standards:parity` (CI runs it on a PR into `main`): the standards must equal the app that is about to become `main`. If the mod changed, also `npm run test:mod` and `npm run typecheck:mod`, which need Claude Code installed and cannot run in CI.
- **Publish:** nothing. There is no package registry and no container registry; users build the image with `podiumctl build`. Skip the skill's publish step.
- **Tag and GitHub Release:** `vMAJOR.MINOR.PATCH`, annotated, from `main` after the release PR has merged; tag the merge commit. The release notes are the CHANGELOG section verbatim. Propose the tag and wait for approval; never push one unprompted.
- **One version for the whole product.** Podium and `podium-reporter` share one `MAJOR.MINOR.PATCH`, the way Kubernetes versions its parts together. Every file in the table below carries the same number at all times; `scripts/versions.test.ts` fails if any of them differ. Releases 0.2.0 to 0.14.3 were cut retroactively at the commit where the reporter's version changed.
- **Feature PRs never bump the version.** A feature or fix PR into `development` adds its entry under `[Unreleased]` and leaves every file in the table alone, including the mod's `plugin.json` (installed copies update at the next release). CI's `mod-version-check` runs on PRs into `main`, so it checks the release PR.
- **A release is the maintainer's decision that `development` is a release candidate.** Do not start one unprompted. Release-candidate gate: `npm test` and `npm run build` pass on the tip of `development` (and `npm run test:mod` and `npm run typecheck:mod` if the mod changed since the last release), and the release PR's CI is green. `development` may be broken between releases; fix it with ordinary PRs, and do not open the release PR with a known failure.
- **The bump level comes from `[Unreleased]`.** Read everything that accumulated since the last release (a hotfix counts as one, so the base is the newest tag on `main`). Any breaking entry is a major release, otherwise any new behavior (`feat:`) is a minor release, otherwise a patch. Choose by what the entries change, never by an issue's label: an `enhancement` that only removes unused code or tidies internals is a patch, and one that adds behavior a person can see is a minor. Entries that change only documentation, comments, CI or chores ride along and do not justify a release alone. Never infer major from how big the diff feels; when it is unclear whether a change is a patch or a minor, or breaking at all, ask. A minor release may include breaking changes only before 1.0.0.
- **Release sequence.**
  1. Verify `development` (the gate above).
  2. Branch `release-prep/<version>` from `development`; in one commit, change every file in the table. If `[Unreleased]` has `Standards:` lines, load `podium-standards-update` in that PR and bring `docs/standards/` in line with the code that is about to become `main`. Open a PR into `development`, to be squash-merged. Run the release check below before opening it.
  3. After the user merges it, open `development` to `main`. The body says it is to be merged with a regular merge commit and not squashed, names the version and quotes the CHANGELOG section. It carries no `Closes #N`; the issues closed when their own PRs merged. Check the merge dropdown before merging, since `gh pr merge` remembers the last method.
  4. After the user merges that, sync `main` and `development`, propose the tag and wait for approval.
- **Hotfixes.** Branch `hotfix/<n>-<slug>` from `main`, write the failing test first, fix, bump the patch version in every file in the table and add a `[X.Y.Z]` section to `CHANGELOG.md` (a hotfix never moves `[Unreleased]`). A hotfix that changes the UI updates `docs/standards/` in the same PR (`podium-standards-update`). PR into `main`; the user merges, then tag as above. The backport waits for the user to say so: branch `hotfix/<n>-<slug>-backport` from `development`, `git cherry-pick -x` every commit, keep the hotfix's CHANGELOG section below `[Unreleased]`, and put `Closes #N` in that PR. If a release-prep PR is already merged but unreleased, stop and ask how to order them.

Everything below changes in the release-prep PR, in the same commit, never as a follow-up after the tag:

| File | What changes |
|---|---|
| `CHANGELOG.md` | Rename `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD` and add a fresh empty `[Unreleased]` above it. Update the two links at the bottom (`[Unreleased]` compares `vX.Y.Z...HEAD`; `[X.Y.Z]` points at the release) |
| `package.json`, `server/package.json`, `frontend/package.json` | `version`, all three the new release number |
| `package-lock.json` | Run `npm install --package-lock-only` so its entries follow the manifests |
| `mod/podium-reporter/.claude-plugin/plugin.json` | `version`, the same release number |
| `mod/podium-reporter/hooks/register.ts` | `VERSION`, equal to `plugin.json` |
| `server/src/fleet/compat.ts` | On a new **minor or major** only: move `max` in `REPORTER_SUPPORT` to the release's `MAJOR.MINOR.0`, or the server tells every up-to-date mod it is newer than the server supports (SPEC 6.8) |

Then grep the repo for the old version string and look at every hit before assuming the table is complete. Known hits that are sample data and do not change: `docs/fixtures/report.sample.json`, the fixtures in `server/src/fleet/*.test.ts`, `docs/GOTCHAS.md`, `mod/podium-reporter/hooks/scripted.ts`, the simulator's `0.1.0-sim`, and the manifest example in `docs/SPEC.md`.

**The release check.** Before the release-prep PR is opened, the main session starts a fresh, non-fork subagent on Haiku (the Agent tool with `model: "haiku"` and no `subagent_type: "fork"`) to check that the release is ready. Its prompt names the version and states its authority: "report a verdict; you do not have merge, tag or push authority, and you do not edit files." It checks that:

- every file in the table carries the release version, and the versions agree with each other;
- `CHANGELOG.md` has a `[X.Y.Z]` section for exactly this version, dated, holding the changes that accumulated under `[Unreleased]`, with a fresh empty `[Unreleased]` above it and the two links at the bottom right;
- the grep for the old version string has been looked at, listing each hit that is not a known sample-data one;
- `npm test`, `npm run build` and `npm run standards:parity` pass, and the standards were brought in line when `[Unreleased]` has `Standards:` lines (`git diff --stat docs/standards` is not empty then).

It reports a short pass/fail list, with the file and line of each mismatch. The main session fixes every failure and runs the agent once more; if the second run still fails, stop and ask. A pass is a claim, not the check: the main session runs `npm test` and `npm run build` itself too, as it does before any PR.

## Issue Management

| Phase | Policy | Skill |
|---|---|---|
| Filing | Group related reports under one issue by root cause rather than one per symptom — but split back out when a report actually bundles more than one distinct Definition of Done. | `github-issue-filing` |
| Working | Work one open issue at a time by default — closing one, even by a merged PR, doesn't authorize starting the next unprompted — unless the user has deliberately scoped a parallel batch, in which case an orchestrator may run multiple issues at once via sub-agents (the batch's final PR targets the base branch). Each sub-agent stays scoped to its own issue's files; never let one touch a shared, single-section file (e.g. `CHANGELOG.md`'s `[Unreleased]` section, this file's own status content) — independent agents editing the same lines is a guaranteed conflict. | `github-issue-workflow` |
| Starting | When told to start an issue (e.g. "review issue N and begin work"), maintain a live task list via TaskCreate/TaskUpdate for the entire duration of the work — every step, including any sub-agents to be spawned — with no exceptions. This is always visible progress tracking, not optional bookkeeping. If TaskCreate/TaskUpdate aren't available in the session (they're off by default on some models), don't fall back to informal status updates — ask the user for permission to add `CLAUDE_CODE_ENABLE_TODO_TOOLS: "1"` to `~/.claude/settings.json`'s `env` block, make the edit once approved, and confirm the tools are now available before proceeding. | `github-issue-workflow` |

## Delegation & Sub-agents

- **Scope a sub-agent's authority to what you actually asked it to do.** A sub-agent asked to research or review should not commit, push, or open/merge a PR on its own initiative — those actions belong to the coordinating session unless explicitly delegated.
- **The release check is a fresh agent too.** It runs on Haiku, reports a verdict and nothing else, and is never a fork, however small the check looks (see Releases, "The release check").
- **A forked agent inherits its parent's entire conversation** — full context and full authority, including merge permissions — whether or not the task you gave it needs any of that (see Do Not). This has already caused real incidents (an unauthorized merge, corrupted files from forks racing on the same working directory). "It's just read-only," "it's just reviewing one PR," "the prompt only asked for one thing" — none of these make a fork safe; a fork's authority isn't bounded by what its prompt asked for. Use a fresh, non-fork sub-agent for every delegated step instead — reviewing a PR, running a validation pass, even read-only research. When you spawn it, state its authority explicitly in the prompt ("report a verdict; you do not have merge authority for this"), not just its scope — scope alone doesn't bound what an agent can decide to do.

## Commands

How to build, test, lint, and run this project is procedural — it belongs in a skill, not here. _See skill: `development-commands`._
