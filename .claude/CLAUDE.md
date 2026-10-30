# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## Project Overview

What this project is, who it's for, and why it exists is in [`PROJECT.md`](PROJECT.md), which is imported below, so it is already in context. That file also holds this project's own rules (extra Do Nots, workflow overrides, skills, standards, release steps). They apply on top of this file. A rule there may add to this file and may override workflow mechanics (how a branch is made, what closes an issue, extra checks around a PR, release steps) when it says it overrides this file. It may not relax anything under Do Not; where the two conflict on that, this file wins.

@PROJECT.md

**If `/init` has been started, do not write project information into this file.** This file is the standard policy document and `/init` must leave it as it is. Put everything `/init` would produce (the overview, and any project-specific notes it finds) in `PROJECT.md` instead, creating that file if it doesn't exist. Not how it's built: that is `docs/architecture/`.

## Shortcuts

The operator uses shorthand in place of typing a full request out. Case-insensitive — treat any casing the same. Expand the shorthand below and act on it as if the full phrase had been typed. Add project- or user-specific entries as they come up.

| Shorthand | Expands to |
|---|---|
| `plmk` | "Please let me know if you have any questions or if I can provide any further context and/or information." |
| `wni` | "What is the next GitHub issue to resolve?" |
| `pri` | "Please review the following Github issue and begin implementation." |
| `prm` | "PR has been merged into its base branch. Confirm `state: MERGED`, close and verify each `Closes #N` issue (GitHub ignores it for a PR into `development`), remove the worktree, delete the branch locally and on the remote, prune, then check out the base branch and pull it." |
| `cii` | "Please review outstanding docs/ISSUES.md and create GitHub issues for anything not yet tracked. Let me know when done." |
| `pnb` | "Please process the next batch of queued items." |

## Do Not

- Edit directly on, push to, or merge a PR into `main` or `development` yourself — for any change, no matter how small (a one-line doc fix included) or how informal (no tracking issue). Changes reach either branch only through a PR, and merging is always the user's call, no exceptions. See "Always Branch First" below.
- Commit secrets, API keys, tokens, or credentials.
- Force-push, skip commit safety checks, or bypass signing without the user's explicit, in-the-moment approval.
- Delegate any task via a fork, no matter how narrow or read-only it looks — no exception.
- Start implementing an issue just because it (or you) filed it — filing and authorization are separate steps.
- Create a new standing doc when an existing one can hold the content.
- Document architecture in this file — use `docs/architecture/`.
- Record current-state facts or status narrative in this file — facts belong in `CHANGELOG.md`; narrative belongs in commit history, PR descriptions, or `docs/ISSUES.md`.
- Silently pick a reading, or "fix" it in passing, when code and `docs/spec/` disagree — flag the contradiction and ask.
- Re-invoke `/code-review` a second time on the same diff "to confirm" a fix. There's no defined stopping rule for a fix→review→fix cycle, and the review skill's own finder/verifier fan-out is not guaranteed to converge on a repeat run — it can spawn a large batch of sub-agents and stall indefinitely. Verify fixes by running the project's own test/lint suite directly instead (see the Review (pre-PR) row below); if that fails, stop and ask rather than looping back into another review round.

## Branching Model

Two workflows exist. Whether a `development` branch exists on the remote picks which one applies:

```bash
git ls-remote --exit-code --heads origin development
```

Exit 0 means the development-branch workflow; any other exit means the standard workflow. Creating `development` is the opt-in, and the GitHub default branch stays `main` so a plain clone gets released code.

- **Standard workflow** (no `development` branch): PRs merge into `main`, and each merge may be a release.
- **Development-branch workflow** (`development` exists):
  - `development` holds unreleased work and may be broken at any given time. Feature PRs target it and are squash-merged.
  - `main` only moves on a release. A release is a PR from `development` to `main`, merged with a regular merge commit, never squashed (squashing makes the branches diverge). That PR is the release-candidate gate: it is valid only if all tests pass, with no breaking tests, conditions, or regressions.
  - The version bump happens in the release PR, not in feature PRs. Feature PRs only add to `CHANGELOG.md`'s `[Unreleased]` section. The bump level comes from what accumulated there, per the SemVer rules in `/eengelking:github-release`.
  - An issue is closed when the PR that resolves it merges, not when a release ships. A feature, fix or batch-final PR into `development` carries `Closes #N` for each issue it resolves. `Closes #N` only fires for a PR into the default branch (`main`), and GitHub ignores it for a PR into `development`, so the agent closes each named issue itself once the merge is confirmed.
  - `Refs #N` only links a PR to an issue. It never closes one, and a PR that resolves an issue never uses it.
  - The `development` to `main` release PR closes nothing and carries no `Closes #N`. Its body names the version and quotes the CHANGELOG section.
  - A sub-agent's PR into a batch integration branch claims no `Closes #N`, because it would close the issue before the work reaches `development`. The batch-final PR carries them.
  - Hotfixes have two paths, chosen by whether `development` matches `main` (`git fetch origin && git diff --quiet origin/main origin/development` exits 0). If it matches, the fix is made on `development` like any other change and ships in the next release PR with a patch bump, with no cherry-pick. If it differs, the hotfix branches from `main`, goes to `main` by PR with a patch bump and `Closes #N`, and is then cherry-picked into `development` by a follow-up PR carrying `Refs #N`, when the user instructs it, so the branches don't drift. The split avoids a cherry-pick that does nothing useful.
  - The integration branch keeps its meaning: the throwaway branch an orchestrator creates for a parallel batch. It is not `development`. Here it is created off `development` and its final PR targets `development`.

Below, "the base branch" means `development` if it exists and `main` otherwise. Procedure lives in `/eengelking:git-branching`, `/eengelking:github-pr-merge`, `/eengelking:github-issue-workflow`, and `/eengelking:github-release`.

## Always Branch First

Before the first `Edit` or `Write` of *any* change to this repo — check the current branch. If it's `main` or `development`, create the working branch as a git worktree under `.claude/worktrees/` (inside the repo, never beside it) before touching a single file. Fork from the base branch (from `main` for a hotfix only when `development` differs from it). This holds regardless of size ("just a typo fix"), formality ("no issue for this, just drafting"), or how the request was phrased ("draft a revised README" is still a change once you start writing it to disk) — the decision to skip a tracking issue and the decision to skip a branch are unrelated, and only the first is ever legitimate. See `/eengelking:git-branching` for the mechanics, including the pre-commit hook that backstops this rule technically rather than relying on memory alone. The hook should block commits on both `main` and `development`.

## Skills

Procedural detail — the *how* behind the rules this file states — lives in skills, loaded on demand rather than carried in every session's context. "Orchestrator" means whichever agent is coordinating a piece of work (driving a single issue end to end, or running a parallel batch); "sub-agent" means an agent it spawned to do a scoped piece of that work. For a single issue worked solo, there's only one agent, so both columns apply to it.

| Skill | Load it when... | Orchestrator | Sub-agent |
|---|---|---|---|
| `/eengelking:git-branching` | Creating any branch (every working branch is a git worktree) — for an issue, a sub-agent, or a batch integration branch | Creates the batch integration branch (if parallel) | Branches off `main` (solo work) or off the integration branch (parallel batch) |
| `/eengelking:github-pr-merge` | Opening a PR (after static analysis and the trace check); watching its checks; running any merge command; closing issues and cleaning up after a merge; proposing a release tag | Reviews and merges a sub-agent's PR into the integration branch; never merges into `main` | Opens its own PR; never merges any PR itself |
| `/eengelking:github-release` | Cutting an actual release once a PR has merged `main` to a releasable state, including the pre-release check and hotfixes | Runs the release steps | N/A — releases aren't a sub-agent's job |
| `/eengelking:github-issue-filing` | Filing issues — grouping related reports, checking for duplicates | Runs standalone, on explicit request | Same as orchestrator |
| `/eengelking:github-issue-workflow` | Starting, resuming, or closing GitHub-issue-tracked work | Decides sequencing and whether a parallel batch applies | Follows the same checklist/Validation discipline within its own issue |
| `/eengelking:documentation-sync` | Before committing any change, and when deciding whether a rule belongs in `CLAUDE.md` or a procedure in a skill | Runs the batch-wide consolidation commit (if parallel) | Keeps its own PR's changes in sync |
| `/eengelking:documentation-bootstrap` | Backfilling or topping up a project's missing doc set (bulk scaffolding, not a single commit's worth of sync) | Runs the doc-type selection pass, sets the sequencing rule, and runs the parallel batch (integration branch, post-bootstrap validation) | Writes its one assigned doc type per the orchestrator's sequencing rule; no merge authority |
| `/eengelking:development-commands` | Installing, testing, building, analyzing or running a project: tests, lint and static analysis, builds and dev servers, containers, a throwaway server or database, UI screenshots, end-to-end scripts, docs-site builds | Yes | Yes |
| `/eengelking:git-safety` | Force-push, skipping commit checks, secrets review | Yes | Yes |
| `/eengelking:retrospective` | Asked for a retrospective, or "what went well/could be improved," after nontrivial or multi-agent work | Yes | Yes |
| `/eengelking:documentation-voice-guide` | Writing any user-facing or project prose (README, docs, commit messages, PR descriptions, issue bodies) | Yes | Yes |
| `/eengelking:spec-writing` | Drafting or overhauling the spec (`docs/spec/`), or breaking a spec or large feature down into dependency-ordered GitHub issues | Yes | N/A |

**Project-specific skills.** This project may have skills of its own that apply on top of the ones above. They are listed in the [Skills section of `PROJECT.md`](PROJECT.md#skills). Read that section before starting work and load the skills it names when their trigger applies.

## Working Style

- **Prefer acting to asking** when the request and the codebase together make the right move obvious; ask when you're genuinely blocked — ambiguous intent, a decision only the user can make, or a destructive/hard-to-reverse action.
- **Verify with real runs, not just lint/build.** A passing type-check or test suite verifies correctness, not that the feature actually works. Where practical, run the thing and exercise the change before calling it done — and say so explicitly when you can't (no way to run the app, no browser access, etc.) rather than implying it was checked.
- **Leave no mess behind.** Stop dev servers you started, close browser tabs you opened, delete branches once their merge is confirmed. A task isn't finished just because the code is right — clean up the process/session state too. Validate the cleanup completed successfully and left no orphans behind.
- **Don't let a stale run fool you.** If you changed code, restart whatever's serving it before treating its behavior as evidence. Testing against cached/stale state produces false confidence.
- **If this project has a `docs/NON_NEGOTIABLES.md`, read it before starting any task.** Its constraints are absolute — they don't get traded away for convenience, ever.
- **Prefer a fresh session per PR or unit of work** rather than accumulating context across many PRs in one long-running session. A long session replays its whole accumulated transcript every turn; starting fresh per PR keeps that small instead of letting it compound.
- **When fixing a bug in code, first write a test that reproduces the failure and confirm it fails for the expected reason, before writing the fix.** A test only ever run against the fixed code doesn't prove it would have caught the regression. This applies to code fixes specifically — it doesn't apply to documentation or other non-code changes.
- **When waiting on a background agent or task, wait for it properly rather than repeatedly checking its status in a loop.** Polling — check, wait a bit, check again — burns tokens re-sending the whole conversation on every check, for no benefit over a real blocking wait. This is a real, recurring waste, not a hypothetical: an orchestrator managing sub-agents or background work is exactly where this loop tends to happen.
- **Before writing a one-off helper script, check whether `scripts/` already has one that does the job** (if it exists — otherwise create it). Run the candidate with `--help`/`-h` to confirm what it does rather than assuming from its name. If nothing fits, write the new script into `scripts/`, give it a `--help`/`-h` flag, and keep it there rather than deleting it once the task is done — a future agent solving the same problem should find it instead of re-writing it from scratch.

## Git & GitHub Workflow

Order of operations for any tracked change. The policy is the invariant that holds regardless of mechanics; the skill covers the how.

| Phase | Policy | Skill |
|---|---|---|
| Start | Branch first, synced from current `main` (standard) or `development` (development-branch workflow). | `/eengelking:git-branching` |
| Review (pre-PR) | Applies only when the branch changes code (logic, scripts, config with behavioral effect) — a docs/prose-only diff (`CLAUDE.md`, `CHANGELOG.md`, `README.md`, comments) has no code for `/code-review` to check and skips this row entirely; a mixed branch still runs it, scoped to the code files. When it applies, run `/code-review` on the branch **exactly once** before opening the PR, then apply its findings with `--fix` (or explicitly defer/note larger, out-of-scope suggestions with reasoning) — never loop back into a second automated round to "confirm" the fixes. Verification of the fixed code is the orchestrator's own job, done directly against the project's real test/lint commands (`/eengelking:development-commands`), not by re-invoking the skill. If that verification passes, move on to the PR; if it fails, stop and ask the user rather than re-running review. This caps the process at one review round plus one orchestrator-run verification pass — see "Do Not" for why a second round is off the table. Reserve post-PR `--comment`/`ultra` review for a genuinely separate pass (e.g. a deeper multi-agent review, or a check the user explicitly wants visible as PR comments), never as a stand-in for pre-PR confirmation. | `code-review`, `/eengelking:development-commands` |
| Develop → PR | The PR targets the base branch; in the development-branch workflow, `plugin.json`/manifest version bumps do not happen here. Changes land via PR; the user reviews and merges. Once a change — issue-tracked or informal — is complete, has been through pre-PR review above, and passes its relevant checks, commit, push, and open the PR without waiting for a separate go-ahead; that's normal completion of the work, not a separate action to confirm. Opening a PR is still a stopping point, not a launchpad — it doesn't authorize starting the next unit of work unprompted, and merging remains the user's call, always. | `/eengelking:github-pr-merge` |
| Merge & cleanup | A branch is deleted only after its merge is confirmed, not assumed. Feature PRs into `development` are squash-merged. | `/eengelking:github-pr-merge` |
| Release (if applicable) | A deliberate step after a PR merges, never an automatic side effect of merging — ask if it's unclear whether this project does releases at all. In the development-branch workflow, a release is the `development` to `main` PR described in "Branching Model", a step the user triggers, never a side effect of merging feature work. | `/eengelking:github-release` |
| Hotfix (development-branch workflow only) | If `development` matches `main`, fix it on `development` like any other change and ship it in the next release PR with a patch bump, with no cherry-pick. If it differs, branch from `main`, PR to `main` with a patch bump and `Closes #N`, then cherry-pick into `development` by follow-up PR carrying `Refs #N` when the user instructs it. This avoids a cherry-pick that does nothing useful. | `/eengelking:github-release`, `/eengelking:git-branching` |
| Dangerous git actions | See Do Not — a prior approval doesn't carry forward to the next instance. | `/eengelking:git-safety` |
| Committing | Review staged changes for anything sensitive before committing, especially in files that don't look like they'd contain any. If a secret is committed anyway, treat it as compromised and flag it to the user for rotation rather than just removing it from the latest commit. | `/eengelking:git-safety` |
| Remote access | The `gh` CLI is available and authenticated — use it for PRs, issues, and other GitHub operations rather than assuming it's missing. If a `git push`/`fetch`/`clone` fails with an SSH error (e.g. `git@github.com: Permission denied (publickey)`), that means this environment's SSH key isn't set up for GitHub — switch the affected remote to HTTPS (`git remote set-url origin https://github.com/<owner>/<repo>.git`) and retry, rather than treating it as a dead end or asking the user to fix SSH first. | — |

**Versioning:** If this repo opts into `/eengelking:spec-writing`'s Staged-DAG weight class, add a line here mapping each stage gate to the release version it produces (e.g. G-0 → `v0.1.0`, G-1 → `v0.2.0`, …) — that mapping is the one fact specific to this repo. The mechanics (independently verifying a gate before treating it as passed, what to bump and where, tagging) are `/eengelking:github-release`'s and `/eengelking:spec-writing`'s job to know, not this file's — load them when a gate task merges rather than re-deriving the steps here. Projects using Flat or Phased spec classes, or no `/eengelking:spec-writing` spec at all, don't need this row.

## Issue Management

| Phase | Policy | Skill |
|---|---|---|
| Filing | Group related reports under one issue by root cause rather than one per symptom — but split back out when a report actually bundles more than one distinct Definition of Done. | `/eengelking:github-issue-filing` |
| Working | Work one open issue at a time by default — closing one, even by a merged PR, doesn't authorize starting the next unprompted — unless the user has deliberately scoped a parallel batch, in which case an orchestrator may run multiple issues at once via sub-agents (the batch's final PR targets the base branch). Each sub-agent stays scoped to its own issue's files; never let one touch a shared, single-section file (e.g. `CHANGELOG.md`'s `[Unreleased]` section, this file's own status content) — independent agents editing the same lines is a guaranteed conflict. | `/eengelking:github-issue-workflow` |
| Starting | When told to start an issue (e.g. "review issue N and begin work"), maintain a live task list via TaskCreate/TaskUpdate for the entire duration of the work — every step, including any sub-agents to be spawned — with no exceptions. This is always visible progress tracking, not optional bookkeeping. If TaskCreate/TaskUpdate aren't available in the session (they're off by default on some models), don't fall back to informal status updates — ask the user for permission to add `CLAUDE_CODE_ENABLE_TODO_TOOLS: "1"` to `~/.claude/settings.json`'s `env` block, make the edit once approved, and confirm the tools are now available before proceeding. | `/eengelking:github-issue-workflow` |

## Delegation & Sub-agents

- **Scope a sub-agent's authority to what you actually asked it to do.** A sub-agent asked to research or review should not commit, push, or open/merge a PR on its own initiative — those actions belong to the coordinating session unless explicitly delegated.
- **A forked agent inherits its parent's entire conversation** — full context and full authority, including merge permissions — whether or not the task you gave it needs any of that (see Do Not). This has already caused real incidents (an unauthorized merge, corrupted files from forks racing on the same working directory). "It's just read-only," "it's just reviewing one PR," "the prompt only asked for one thing" — none of these make a fork safe; a fork's authority isn't bounded by what its prompt asked for. Use a fresh, non-fork sub-agent for every delegated step instead — reviewing a PR, running a validation pass, even read-only research. When you spawn it, state its authority explicitly in the prompt ("report a verdict; you do not have merge authority for this"), not just its scope — scope alone doesn't bound what an agent can decide to do.

## Commands

How to build, test, lint, and run this project is procedural — it belongs in a skill, not here. _See skill: `/eengelking:development-commands`._
