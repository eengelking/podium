# Project

<!--
Everything specific to this project lives here, never in CLAUDE.md. CLAUDE.md is the standard
policy document, copied between projects as is; `/init` and any project update write to this file.
A section below may add to CLAUDE.md and may override its workflow mechanics, for this project. Say so
in the section ("this repo overrides ...") so the reader knows it is deliberate. It may not relax a
rule under CLAUDE.md's Do Not; that list always wins.
Delete a section that doesn't apply, or keep its heading with one line saying none. Don't leave
the TODO text in place.
This file says what and why: what the project is, its rules and constraints, and which skill to load
for an action. How to do something (steps, commands, checklists) lives in a skill under
`.claude/skills/`, loaded when the work needs it.
Not here: architecture (docs/architecture/), build/test/run commands (the `development-commands`
skill), current-state facts and status (CHANGELOG.md).
-->

## Read This First: All Database Access Goes Through the Storage Adapter

**This project reaches its database only through the storage layer. Every new database query goes through `Storage`, the object `openStorage` returns. Direct SQLite integration is NOT ALLOWED.**

SQLite is the default and, for now, the only adapter. Other databases (PostgreSQL, MariaDB and more) are planned, and each will be a new adapter behind the same interfaces. Code that calls SQLite directly would have to be rewritten for every one of them.

- Do not import `node:sqlite` or anything under `server/src/storage/sqlite/` from code outside that folder. Do not use `sqliteHandle` or `activityHandle`, and do not write raw SQL outside the adapter.
- A new query is a method on the store's async interface in `server/src/storage/types.ts`, implemented in the adapter and called through `Storage`.
- `server/src/storage/neutral.test.ts` fails if a file outside the adapter breaks this. A change that needs the test loosened to pass is wrong; stop and ask.
- **A database change is made in every adapter.** A new, changed or removed column, table, index, key or constraint is not done when the interface in `types.ts` and the row types in `rows.ts` are updated, because an interface creates nothing in any database. Each adapter carries its own schema change and its own migration, and the same case in `server/src/storage/contract.ts` must pass against each one. A store behavior that is new or changed gets its own `contract.ts` case, and a migration that rewrites existing rows gets an upgrade test in each adapter. A PR that changes the schema in one adapter and not the others is incomplete. While only one adapter exists on the branch, the PR body says no other adapter is affected.

How it is built is in [`docs/architecture/02-components/19-storage.md`](../docs/architecture/02-components/19-storage.md) and DECISIONS 48. Read the page before you touch a store.

## Project Overview

Podium is a live fleet console for Claude Code. It shows every session running on one machine in one
browser tab: each orchestrator's model, effort, plan, the agents it launched, what they cost, how full
their context windows are, why anything failed, and which git branch it works in. It is for someone who
runs several Claude Code sessions and agents at once and wants to see what they are doing and costing
without watching each terminal. Podium watches, and it can also answer a session that waits on its person
(a question, a plan, a tool's permission prompt, a message, `/clear` or `/compact`), only where the Admin and the
session's owner have both turned that on. It never types into a terminal or changes a session's permission rules.

It ships as a server and UI (this repo, run with `podiumctl` in a Podman container or as a plain Node
process) and a reporter mod, `podium-reporter`, installed from `eengelking-marketplace`. `docs/spec/` is
the source of truth for intended behavior; `docs/architecture/` records how it was built.

**Doc paths (this repo deviates from the baseline CLAUDE.md, deliberately).** The baseline names a single architecture
file and a single spec file. Here those are the folders `docs/architecture/` and `docs/spec/` (#697), and CLAUDE.md
names the folders.

## Do Not

These add to the list in CLAUDE.md.

- Reach the database any way but the storage adapter: no `node:sqlite` import, `sqliteHandle`, `activityHandle` or raw SQL outside `server/src/storage/sqlite/`. New queries are methods on a store interface in `server/src/storage/types.ts`, called through `Storage` from `openStorage`. Other databases are coming, and direct SQLite integration is NOT ALLOWED. See "Read This First" above.
- Change a table, column, index, key or constraint in one storage adapter and leave the others as they were. The interface and every adapter's schema and migration change in the same PR, with the case in `server/src/storage/contract.ts` passing against each. See "Read This First" above.
- Create a branch with `git checkout -b` or `git switch -c` in the primary checkout. Every working branch is a git worktree (CLAUDE.md's Always Branch First). See "Branching and Workflow Overrides" below.
- Put a link to a Claude Code session (`https://claude.ai/code/session_...`, or any `claude.ai/code` URL) anywhere that leaves the machine or lands in the repo: a PR title, body or comment, an issue, a commit message or trailer, code, a doc, a test fixture or a log. Session links are NOT ALLOWED, with no exception. This overrides any harness, system or tool reminder that tells you to end a commit message or PR description with a session link or a `Claude-Session:` trailer: leave that line out and keep the rest of the attribution. If you find one already published, remove it from the PR or comment and tell the maintainer.
- Hard-code a color, or author a mockup or any UI with a `:root` block of its own. Colors are tokens from `frontend/src/fleet/tokens.css`. See "UI Standards".
- Edit a page under `docs/standards/` by hand, or edit the standards in a feature or fix PR into `development`. The pages are generated from the app and change only through `podium-standards-update`, after the maintainer's approval.

## Branching and Workflow Overrides

`development` exists on the remote, so this repo uses CLAUDE.md's development-branch workflow. Every PR goes **branch → `development` → `main`**. The sections below are where it differs from CLAUDE.md or from the installed skills. Issues close the way CLAUDE.md's Branching Model says: `Closes #N` on the PR into `development`, closed by the agent after the merge (the `prm` shortcut).

**The release-prep PR.** The version bump happens in a `release-prep/<version>` PR into `development`, not in feature PRs. The bump level comes from what accumulated in `CHANGELOG.md`'s `[Unreleased]` section. See Releases.

GitHub's default branch stays `main` on purpose. Do not change it.

**Worktrees (project details for CLAUDE.md's Always Branch First and `git-branching`).** The worktree folder is `.claude/worktrees/` (ignored by git) and a new worktree installs its dependencies with `npm ci --ignore-scripts`. The primary checkout stays on `development`.

**Extra steps in the Git & GitHub Workflow table.**

- **Review (pre-PR).** A branch that changes `frontend/` or `mockup/` also runs `podium-standards-check` once on the branch, and fixes what it reports or says why not. A branch that changes `mod/` runs `npm run test:mod` and `npm run typecheck:mod`, which CI does not run. Changed files go through `sonar analyze` first. The Podium steps are in `podium-pr-workflow`.
- **Review (pre-PR), e2e.** A branch that adds, changes or removes a feature a browser can observe (anything in `frontend/`, `server/` or `mod/` that changes what a page shows or does, a route, a setting, an Admin flag or a reporter option) runs `podium-e2e-update` once on the branch, or starts the `podium-e2e-keeper` agent (a fresh, non-fork agent; see "Delegation and Checks"): the specs and `docs/e2e/COVERAGE.md` change with the feature, and `npm run e2e` passes on the whole suite with no failure and no retry. A change that touches nothing a spec asserts says so in the PR. Cypress runs only in containers (`scripts/e2e-up.sh`); nothing is installed on the host.
- **Develop → PR.** `plugin.json`/manifest version bumps do not happen here, and neither do edits to `docs/standards/`: a UI change the maintainer approved adds a `Standards:` line under `[Unreleased]` instead.
- **PR trace check.** Before a PR is opened, and again after any edit to its title or body, a fresh Haiku subagent checks the PR for session links and other traces that should not be published. The same agent also runs the adapter parity check when the PR touches `server/src/storage/`. See "Delegation and Checks" below and `podium-pr-workflow`.
- **Verify (post-PR).** After opening the PR, and after every push to it, run `gh pr checks <PR> --watch` and report each check pass or fail. After 3 fix attempts on the same failure, stop and give the user the cause, what was tried, and the options. See `github-pr-merge`.
- **Release.** A release is the `development` to `main` PR, prepared by a `release-prep/<version>` PR into `development` and checked by a Haiku agent before the release PR is opened; the tag follows the merge and waits for the maintainer's approval. See Releases.
- **Hotfix.** A hotfix that changes the UI updates `docs/standards/` in the same PR. See Releases.

## Skills

These apply on top of the table in CLAUDE.md. All of them live in `.claude/skills/`. A rule in this file says what and why; the skill named for the action says how, so load it when its trigger applies.

| Skill | Load it when... | Orchestrator | Sub-agent |
|---|---|---|---|
| `podium-pr-workflow` (project, `.claude/skills/`) | Alongside `github-pr-merge`: before opening a PR, after every push to it, when a check or the SonarCloud gate fails, and for any change under `mod/` | Runs the Podium pre-PR checks and trace-check patterns; `github-pr-merge` runs the rest | Runs the pre-PR checks on its own change; never merges |
| `podium-release` (project, `.claude/skills/`) | The maintainer decides on a release; a `release-prep/<version>`, release or hotfix branch; the list of files a version touches; `versions.test.ts` or `mod-version-check` fails; a hotfix backport | Runs the release steps and the release check | N/A, never a sub-agent's job |
| `podium-standards-check` (project, `.claude/skills/`) | Doing any UI work: a screen, component, mockup, CSS, color or wording; and before opening a PR that touches `frontend/` or `mockup/`. Also for a platform audit | Runs it on the branch before the PR; may run the `podium-ui-auditor` agent for a read-only audit | Runs it on its own change; reports deviations, edits no standard |
| `podium-standards-update` (project, `.claude/skills/`) | A standard must change: in the `release-prep/<version>` PR when `[Unreleased]` has `Standards:` lines, in a hotfix that changes the UI, or when the maintainer approves a change | Runs it in release-prep and hotfix PRs | N/A, never a sub-agent's job |
| `podium-atlas-update` (project, `.claude/skills/`) | A change is structural or architectural: a new, removed or renamed part, reporter hook or timer, route, middleware, table, listener or port, deployment mode, flow, consent option or Admin flag, a changed default the atlas quotes, or a moved file it names. Also in the `release-prep/<version>` PR for the version and line counts, and when `node scripts/atlas-functions.mjs --check` or its test fails | Runs it on the branch before the PR, or has the `podium-atlas-keeper` agent run it | Reports a structural change it made and leaves the atlas to the orchestrator unless it was assigned the atlas |
| `podium-e2e-update` (project, `.claude/skills/`) | A feature is added, changed or removed: anything in `frontend/`, `server/` or `mod/` that changes what a page shows or does, a route, a setting, an Admin flag or a reporter option, a label, a control, a state or a default; before the PR for it is opened; and when `npm run e2e` fails or a spec is to be added, changed or removed | Runs it on the branch before the PR, or has the `podium-e2e-keeper` agent run it (a fresh, non-fork agent, with its authority stated in its prompt); runs the whole suite to green | Reports a behavior change it made and leaves the specs to the orchestrator unless it was assigned them; never edits another sub-agent's spec files |
| `podium-docs-site` (project, `.claude/skills/`) | Writing, adding or moving any page in `docs/` (templates, frontmatter, generated indexes, citations), or working on the docs site (`site/`, published at podium.engelking.dev from `docs/`): previewing it, fixing a link the build rejects, changing its look, or when `docs-site.yml` fails | Yes | Yes, for a change it makes to the site or to a doc's place in the menu |

CLAUDE.md's `documentation-sync` row also applies "Writing docs" in `CONTRIBUTING.md` to any doc you write or change.

## Working Style

These add to CLAUDE.md's Working Style.

- **For a UI change that includes a narrow layout, the real run is `scripts/page-shot.mjs`** (see "UI Standards"). It adds to CLAUDE.md's "Verify with real runs".
- **Any change under `mod/` runs `npm run test:mod` and `npm run typecheck:mod` before the PR, not only at release.** Neither runs in CI, so nothing else will catch a mod regression until the release gate does. A failure that is not new still goes to the maintainer as an issue; the release gate allows no known failure. Report the result in the PR body, and never report a `typecheck:mod` that could not run as passing (`podium-pr-workflow`).
- **Leave no worktree behind.** On top of CLAUDE.md's "Leave no mess behind", remove the worktree before deleting the branch once its merge is confirmed.
- **Run `sonar analyze` on the files you changed before opening a PR**, so a fix does not start a loop with the SonarCloud quality gate. When the analysis comes back `[SKIPPED]`, say so rather than calling the files clean. The gate needs 80% coverage on new lines: every line you add or edit needs a test that reaches it, or leave the line alone (`podium-pr-workflow`, with the rules to write code that does not trip).
- **Every doc page starts from a template in `docs/templates/`** and carries `title`, `description` and `group` frontmatter. One term for one thing: the app is the **console**, its page of cards is the **wall**. The big docs are folders of small pages (#697, DECISIONS 45), whose indexes are generated, and a citation such as "SPEC 6.8" or "DECISIONS 37" never changes. Do not reword moved text. `npm test` fails on stale indexes, bad frontmatter or a dead citation (`podium-docs-site`).
- **A structural or architectural change updates the atlas in the same PR.** The atlas is `docs/atlas/podium-atlas.html` and `docs/atlas/ATLAS.md`, and both change together. Load `podium-atlas-update` before opening the PR, or start the `podium-atlas-keeper` agent (a fresh, non-fork agent; see "Delegation and Checks") and review what it changed. A change that touches nothing the atlas states needs no update, and the PR says so. `npm test` fails if the atlas and the code disagree on a function, a hook or the version.

## UI Standards

The design system is `docs/standards/` (open `index.html`): tokens, themes, every component rendered from the app with its states, patterns, voice, accessibility and process. It is generated from the app on `main` and a test fails if it differs, so it says what production does. The rules in it bind every agent and every person, and they win over the global `frontend-design` and `dataviz` skills where they disagree.

- **Before any UI work**, read the page you need (`components.html` for what exists, `patterns.html` for the rule, `tokens.html` for a color) and load `podium-standards-check`. Run it again on your change before the PR.
- **A mockup comes first** for a new screen, component, pattern or visible change (the global rule), and it links `frontend/src/fleet/tokens.css`. It does not carry a `:root` block. It shows light and dark and a narrow width, and the maintainer accepts it before any code.
- **Check the built UI at 400 px and 1440 px with `scripts/page-shot.mjs`**, for any change to `frontend/` that has a narrow layout and for a width-specific bug, after the mockup is accepted and the code is written. It is the only way that works here, and it must point at a throwaway server, never the maintainer's own. Start it as `development-commands` describes (`throwaway-server.md`, `ui-screenshots.md`) and seed it with `scripts/podium-peers-seed.mjs`. The Chrome extension's window resize does nothing, an iframe is refused, and `chrome --headless --screenshot` never finishes because the page holds `/api/fleet/stream` open.
- **Colors are tokens** from `tokens.css`, the one place a color token is defined. `npm test` fails on a hard-coded color that is not on `docs/standards/deferred.json`, on a `var(--x)` nothing defines, and on a theme below the contrast targets.
- **Collapse and open controls are `EdgeTab`** (`.edge-tab`), the one pill the top bar, the KPI rows, the Plan / Files fold and both panes use (#626). A new control that hides or shows something uses it with a placement class and does not draw its own button.
- **Reuse a component or class that exists.** A new component or pattern is added to the standards in the PR that introduces it, never invented inside one feature.
- **The wall-notice rules**: bottom of the wall, an X, a confirmation that points to Admin > Settings, an on/off switch there, and errors are never notices. The rest of the patterns (paging, status shape plus word plus color, consent, the primary button, copy, empty states) are on `patterns.html`.
- **Changing a standard** is the maintainer's decision. A feature or fix PR into `development` does not edit the standards. If the maintainer approved a change to a token, a component, a variant or a pattern rule, it adds a `Standards:` line under `[Unreleased]` in `CHANGELOG.md` that names the change and the approval (write the line only for an approved change, never to ask for approval). A UI change that changes no standard, such as one more notice in the existing stack, needs no line. Either way the `release-prep/<version>` PR brings the pages in line using `podium-standards-update`, and `npm run standards:parity` failing on `development` because a sample now shows the change is expected until then.
- **A checkup** of the whole app (deviations, and what no standard covers) is the read-only `podium-ui-auditor` agent. Spawn it as a fresh, non-fork agent and state its authority: it reports and does not edit, commit or merge.

## Releases

`github-release` (with its development-branch resource) owns the steps, and `podium-release` owns what is specific to this repo: the gate, the files a version touches, what publishing means here and the release check. These are the rules that are this repo's own.

- **One version for the whole product.** Podium and `podium-reporter` share one `MAJOR.MINOR.PATCH`, the way Kubernetes versions its parts together. Every versioned file carries the same number at all times; `scripts/versions.test.ts` fails if any of them differ. Releases 0.2.0 to 0.14.3 were cut retroactively at the commit where the reporter's version changed.
- **Feature PRs never bump the version.** A feature or fix PR into `development` adds its entry under `[Unreleased]` and leaves every versioned file alone, including the mod's `plugin.json` (installed copies update at the next release). CI's `mod-version-check` runs on PRs into `main`, so it checks the release PR.
- **A release is the maintainer's decision that `development` is a release candidate.** Do not start one unprompted, and do not open the release PR with a known failure; `development` may be broken between releases.
- **The bump level is chosen by what the `[Unreleased]` entries change, never by an issue's label:** an `enhancement` that only removes unused code or tidies internals is a patch, and one that adds behavior a person can see is a minor. A minor release may include breaking changes only before 1.0.0.
- **The release is published as the docs site and one archive.** The archive is `podium-reporter-<version>.zip`, attached to the GitHub Release of each `vX.Y.Z` tag by `release.yml` and, as `podium-reporter-<version>-nightly-<date>.zip`, to each nightly prerelease by `nightly.yml`. Claude Desktop installs a plugin only from an archive (#835). `scripts/podium-reporter-zip.mjs` builds it. There is no package registry and no container registry.
- **The release PR carries no `Closes #N`** (CLAUDE.md's Branching Model), and the tag waits for the maintainer's approval.

## Delegation and Checks

These add to CLAUDE.md's Delegation & Sub-agents. Each check below is a fresh, non-fork subagent, however small the check looks.

- **The PR trace check** runs on Haiku (the Agent tool with `model: "haiku"` and no `subagent_type: "fork"`) after the branch is pushed and before the PR is opened, and again after any edit to the title or body. Its authority is stated in its prompt: it reports a verdict and has no merge, push or edit authority. It looks for session links, secrets, author-machine paths and addresses, instructions addressed to a reader, and logs or screenshots that show any of them. A pass is a claim, not the check: the main session also greps for it. A failing second run means stop and ask. The generic prompt is in `github-pr-merge` (`resources/pr-trace-check.md`); the Podium patterns and the grep are in `podium-pr-workflow`.
- **The adapter parity check** is a second job for the same Haiku agent as the trace check (one agent and one prompt, so the check is not skipped for cost), with the same report-only authority. When the PR changes anything under `server/src/storage/`, it lists the adapters that exist, confirms that every change to the storage interface reached each of them, and runs each adapter's tests. An adapter with a missing update, a failing test or a skipped suite is a failure. A pass is a claim, not the check: the main session runs the same tests itself. The steps and the prompt are in `podium-pr-workflow`.
- **The atlas keeper.** `podium-atlas-keeper` edits the two atlas files and `CHANGELOG.md`'s `[Unreleased]` line for them, and nothing else; it does not commit, push or merge. State that authority in its prompt, name the branch and the worktree, and do not edit the atlas files yourself while it runs, because two writers on one file corrupt it. It is never a fork. Read its report and the diff before committing.
- **The e2e keeper.** `podium-e2e-keeper` edits the e2e files (`e2e/`, `scripts/e2e-*`, `docs/e2e/COVERAGE.md`) and the `data-testid` attributes a spec needs, runs the whole suite and reports; it does not commit, push or merge, and it installs nothing on the host. State that authority in its prompt, name the branch and the worktree, and do not edit the e2e files yourself while it runs. It is never a fork. Read its report, the diff and the run's counts before committing.
- **The release check** runs on Haiku, as a fresh non-fork subagent, before the release-prep PR is opened. It reports a verdict and has no merge, tag or push authority, and edits no files. A pass is a claim, not the check: the main session runs `npm test` and `npm run build` itself too. A failing second run means stop and ask. The generic checklist is in `github-release` (`resources/release-check.md`); the Podium checks are in `podium-release`.
