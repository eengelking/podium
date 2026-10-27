# Contributing

Thanks for considering a contribution to Podium. This doc covers what belongs here, how to set up, how to
propose a change, and how it gets merged.

## What belongs in this repo

Podium shows every Claude Code session on one machine in one browser tab. This repo holds the whole thing:
the reporter mod (`mod/podium-reporter/`), the server (`server/`), the UI (`frontend/`), `podiumctl` and the
container image.

A change fits if it makes Podium better at watching sessions. Some things are out on purpose, and
`docs/spec/` ("Non-goals") lists them:

- **Answers only when asked.** Podium never types into a terminal, stops or starts an agent, or changes a
  session's permission rules. It can answer a session that waits on its person, but only where the Admin and
  the session's owner both turn that on.
- **One server you run.** No hosted service, accounts or cloud sync. Several people can report to it, each
  with their own token.
- **No billing accuracy.** Cost is an estimate and the UI says so.

If your idea needs one of those, open an issue and say why before writing code.

## Setting up

You need Node 24 and npm. The mod's own tests and type check also need Claude Code installed.

```sh
git clone https://github.com/eengelking/podium.git && cd podium
npm install
npm run dev          # server on http://127.0.0.1:4317, Vite UI on http://localhost:5173
npm run podium:sim -- --sessions 5 --chaos    # fake sessions, in a second terminal
```

To try the mod in a real session, load it from your checkout:

```sh
claude --plugin-dir /path/to/podium/mod/podium-reporter
```

## Checks to run

```sh
npm test               # server, UI, simulator and podiumctl tests (vitest)
npm run test:coverage  # the same tests with coverage; writes server/coverage and frontend/coverage (lcov, gitignored); slower, so its test timeout is 20 s
npm run build          # UI and server build, scripts type-check
npm run test:mod       # the mod's tests (needs Claude Code)
npm run typecheck:mod  # the mod against Claude Code's plugin API declarations (needs Claude Code)
npm run podium:smoke   # end to end: server, simulator, SSE, directly and through Vite
scripts/podium-soak.sh --help   # load and restart check
scripts/gpu-sample.sh --help    # sample the Mac's GPU load while a tab is open (macOS)
scripts/agent-context-audit.sh --help  # compare each agent's Tokens with its own transcript
scripts/agent-tokens-sample.sh --help  # log a running agent's Tokens over time
scripts/podium-peers-e2e.sh --help     # orchestrator messaging with real Claude Code sessions in tmux (costs model usage)
node scripts/page-shot.mjs --help      # load a page at a set width (400 px) in headless Chrome, save a PNG, optionally run JavaScript in it
node scripts/podium-peers-seed.mjs --help  # seed a throwaway server with a person, reporters and messages to look at
```

`page-shot.mjs` is how to see a UI change at a narrow width in the built app. Start a throwaway server on its own port and database
(`PORT=4391 PODIUM_DB=/tmp/x.sqlite PODIUM_TOKEN=secret node server/dist/index.js` after `npm run build`), seed it, and run
`node scripts/page-shot.mjs --url 'http://127.0.0.1:4391/#/me/reporters' --width 400`. It needs Chrome or Chromium and Node 22 or later.

`frontend/src/fleet/a11y.axe.test.tsx` runs axe-core over the console's pages and the standards pages inside `npm test`. A new page or a
big new state gets a case there. It cannot judge contrast or target size, which need a real layout; scan those in a browser (inject
`axe.min.js` in a page and run it in each theme and mode) when a change touches color or size. A violation that is known goes in its
`KNOWN` list with the issue that tracks it, and comes out when it is fixed.

CI runs `npm test` and `npm run build` on every PR into `development` or `main`, on the project's self-hosted runners (`runs-on: [self-hosted, Linux, X64]`; a PR from a fork uses GitHub's `ubuntu-latest`); a job waits in the queue when none is free. It cannot run the two mod checks, because the runners
have no Claude Code, so run those yourself when you touch the mod.

Two scanners also run on PRs, and after a merge to `development` or `main`: SonarCloud (`.github/workflows/sonar.yml`, quality gate and coverage on new code) and CodeQL
(`.github/workflows/codeql.yml`, the `security-extended` queries; results are under Security > Code scanning). Neither runs on
your machine. Fix what they flag in your PR.

SonarCloud cannot see the mod's own tests, because they run only inside Claude Code, so a line added to
`mod/podium-reporter/hooks/register.ts` counts as uncovered. Put new mod logic in a plain module beside it that imports
nothing from the engine (see `place.ts`, which takes what it needs from `$` as an argument), test it from `scripts/` with vitest,
and keep `register.ts` to a few lines of glue. `server/vitest.config.ts` measures `mod/podium-reporter/hooks/*.ts` for this.

### The nightly

`.github/workflows/nightly.yml` publishes a snapshot of `development` every day at 06:00 UTC (and on demand, from the Actions
tab, with Run workflow). It checks out `development`, runs `npm test` and `npm run build`, and only if both pass creates the tag
`nightly-YYYY-MM-DD` and a GitHub **prerelease** with a source tarball of that commit. Then it deletes every earlier `nightly-*`
release and tag, so one nightly exists at a time. A day with no new commit on `development`, or a red `development`, publishes
and deletes nothing. A nightly is unreleased and may be broken. It is never marked latest, so `releases/latest` and the in-app
update notice still point at the newest `vX.Y.Z` release.

To try it, download the tarball from the [Releases page](https://github.com/eengelking/podium/releases) (the one marked
Pre-release), unpack it, and run `npm ci --ignore-scripts && npm run build`, or `podiumctl build` for the container. The
`schedule:` trigger only runs from the default branch, so the workflow starts running when it reaches `main` with a release.

When you fix a bug in code, add a test that fails for the right reason first, then fix it.

## Proposing a change

Open an issue first for anything non-trivial (a new feature, a behavior change, a change to the report
format). A small, obvious fix, such as a typo or a broken link, can go straight to a PR.

`docs/spec/` is the source of truth for intended behavior. If your change makes the code differ from it,
the spec wins unless the maintainer agrees to change the spec. Say so in the PR and expect that to be its
own conversation. Other docs should link to the spec section instead of restating it.

### Where things are documented

| Doc | Owns |
|---|---|
| `README.md` | Orientation, quick start and the table of docs |
| `docs/SERVER.md` | Running the server: `podiumctl`, several people on one server, server settings |
| `docs/REPORTER.md` | The reporter mod: install, options, what leaves a session |
| `docs/user-guide/` | Using the console, day-to-day |
| `docs/MESSAGING.md` | Orchestrator messaging from start to finish: how the parts fit, setup, rights, limits, troubleshooting, the end-to-end test |
| `docs/REPLAY.md` | Session recording and replay from start to finish: consent, what is captured, the notice, storage, limits, access, the replay, the measurement |
| `docs/spec/` | Intended behavior and requirements |
| `docs/architecture/` | How it was built, departures from the spec, verification, known issues |
| `docs/decisions/` | Why a significant choice was made |
| `docs/gotchas/` | Sharp edges that are easy to hit |
| `docs/PERFORMANCE.md` | What Podium costs to run at four fleet sizes, how to measure it again (`scripts/podium-perf*`), and the ranked findings of the performance audit |
| `docs/COMMUNITY.md` | The Discord server: how to join it, and how the maintainer sets it up and keeps it safe. Also the docs site's domain: its DNS record and renewal |
| `docs/standards/` | How the UI looks and is built: tokens, components, patterns, voice, accessibility. Generated from the app, never edited by hand |
| `docs/atlas/ATLAS.md` | A table of every part of Podium and every reporter hook, and where each runs. `docs/atlas/podium-atlas.html` is its interactive companion |
| `docs/DEMO.md` | A script for showing Podium to other people |
| `docs/templates/` | The page templates (guide, reference, internals, and the index, entry, section and chapter pages of a split topic). Copy one to start a page; the rules are under "Writing docs" |
| `CHANGELOG.md` | One entry per release |

Update the docs that describe your change in the same PR, and add a line under `[Unreleased]` in
`CHANGELOG.md` for anything a user would notice.

A change to the UI also follows the standards in `docs/standards/`, and starts with a mockup that links
`frontend/src/fleet/tokens.css` instead of carrying a `:root` block. A PR into `development` does not edit the standards,
the same way it does not bump the version. If the maintainer approved a change to a token, a component, a variant or a pattern rule,
add a line that starts `Standards:` under `[Unreleased]` that names the change and the approval. A change that changes no
standard needs no line. Either way the release-prep PR brings the standards in line (`npm run standards:sync`, then
`npm run standards:parity` must pass), so parity can fail on `development` until then. A PR into `main` is valid only if parity passes.

### Writing docs

These apply when you write a new doc or change an existing one. People and agents follow the same rules.

**Structure**

- Each fact has one owning doc (the table above). Everywhere else, link to it instead of restating it.
- A file over about 100 lines opens with a contents list. Keep heading depth consistent.
- Keep paragraphs under about 8 lines. Put reference material in tables, procedures in numbered lists and
  commands in code blocks.
- Do not add a new standing doc when an existing one can hold the content.

**The page template**

Every page in `docs/` follows one template, so a reader going from one page to the next sees the same structure.
`docs/templates/` has a starting file for each kind of page. Copy the one that fits and fill it in. The three below are the page kinds:

| Template | Use it for | Group |
|---|---|---|
| `docs/templates/guide.md` | A task a reader does: set up, run, configure | Getting started, Running it |
| `docs/templates/reference.md` | Facts a reader looks up: fields, settings, rules | Reference |
| `docs/templates/internals.md` | How it was built, why, what goes wrong | Project internals |

**When a page splits, and how**

Split a page along its sections when its sections are topics a reader looks up or links to on their own, or when it is a log
that gains an entry with every change. Keep a page whole when it is one task read from start to finish (`SERVER.md`,
`REPORTER.md`, `MESSAGING.md`, `REPLAY.md`). Line count is a hint and not the rule: a page of 400 lines that is one procedure stays
whole, and a short log still splits. A section that is itself a set of subsections, and long, splits again.

- **One folder per split topic** under `docs/`: `docs/spec/`, `docs/decisions/`, `docs/gotchas/`, `docs/architecture/`,
  `docs/user-guide/`. A folder holds a `README.md` and one page per section, entry or subsection. A section that splits
  again is a subfolder with its own `README.md`.
- **`README.md` is the index.** GitHub shows a folder's `README.md` under its file list, so a reader who opens the folder lands
  on the overview. It keeps the topic's opening (what it is, who it is for) and ends with a list of its pages between
  `<!-- entries:start -->` and `<!-- entries:end -->`. Each page ends with a previous / up / next footer between
  `<!-- nav:start -->` and `<!-- nav:end -->`. Both are generated from the pages' frontmatter: run
  `node scripts/build-doc-indexes.mjs` after you add, rename or reorder a page. `npm test` fails when they are out of date.
- **File names** start with a zero-padded number when the order matters (`07-01-endpoints.md`) so the folder lists in
  reading order on GitHub. A gotcha has no number and is ordered by `order`.
- **Frontmatter** is the page's own, plus: `order` (a number, the reading order inside its folder), optionally `sidebar_label` (a
  shorter name for the site's menu when the title is long), and for an entry
  `number`, `date` and `status` (a decision), `area`, `date` and `status` (a gotcha), or `section` (a spec page, the string
  other docs cite, such as `"7.7"`). A README's `entries` says how its list is drawn: `list`, `table` or `by-area`.
- **A new decision or gotcha is one new file** from `docs/templates/decision-entry.md` or `gotcha-entry.md`, then
  `node scripts/build-doc-indexes.mjs`. No other page changes.
- **Citations keep working.** "SPEC 6.8" and "DECISIONS 37" name a page by its `section` or `number`, and never change.
  `node scripts/check-doc-refs.mjs` (also in `npm test`) fails on a citation no page answers to and on a reference to the old
  single-file paths (the five old files are short stubs that point at the folders, for links from outside the repo).
- **Moved text is not reworded.** Only headings, frontmatter, links and the generated parts change.

The templates for these pages are `topic-index.md` (the folder's `README.md`), `decision-entry.md`, `gotcha-entry.md`,
`spec-section.md` and `chapter.md` (a part of a guide or of the architecture). A fact that a page states is stated once.

- **Frontmatter.** The first lines of the file are a block between two `---` lines with three fields, all required:
  `title` (the name in the menu and in search results), `description` (one sentence, under 160 characters, that says what
  the page gives the reader) and `group` (exactly one of `Getting started`, `Running it`, `Reference`,
  `Project internals`). The site menu puts a page in the group it names here. Put a value in double quotes when it has a
  colon or a quote in it. `docs/standards/` is generated and has none. `docs/templates/` is exempt from the check.
- **The opening.** One `#` heading, then a paragraph that says what the page covers and who it is for, in that order. If
  the page leaves a neighbouring topic to another page, say which. A page over about 100 lines follows with a `Contents:`
  list.
- **Headings.** `##` for sections and `###` for subsections. Do not go deeper, and do not skip a level. Write headings as
  sentence case, and as the thing the reader wants ("Run it with podiumctl"), not as a label ("Overview").
- **Steps.** A numbered list, one action per step, with the command in its own code block and the language named. Say
  what the reader should see when a step worked.
- **Commands and examples.** Always in a fenced code block. Show the shortest example that is true, and use the same
  placeholder (`<host>`, `<token>`) wherever it appears.
- **Warnings.** A `> **Warning:**` quote, only for a step that loses data or exposes something. Everything else is
  ordinary prose.
- **Tables.** For facts that come in sets: settings, fields, options. A header row, the same columns in every table of that
  kind, and a default in its own column.
- **Links.** Relative links with the file name (`[Server](SERVER.md#built-in-tls)`), never a full URL to a doc in this
  repo. They work on GitHub and on the site. Link the first mention of another page's topic, not every mention.
- **Terms.** One word for one thing. The app is the **console**, its page of cards is the **wall**, a Claude Code
  session is a **session**, and the main agent in it is the **orchestrator**. Use the words the app shows, then check
  `docs/user-guide/` before you coin another.

To check a page against the template, run `node scripts/check-doc-frontmatter.mjs` (it also runs in `npm test`), then
read the page's opening and headings against the list above. The script checks the frontmatter only; the rest is a
read.

**Shapes**

- `docs/gotchas/`: every entry has **You see**, **Why** and **Do**, in that order.
- `docs/decisions/`: every entry has Context, Decision, Why, Alternatives and Cost, leaving out a part only
  when there is nothing to say for it.
- `docs/spec/`: section numbers are cited from other docs, code comments and issues. Do not renumber or
  rename a numbered heading. Add unnumbered subheadings inside a section instead.

**Before you open the PR**

1. Check that the page has its frontmatter (`node scripts/check-doc-frontmatter.mjs`), that its folder's index is current
   (`node scripts/build-doc-indexes.mjs`) and that the headings other files link to still exist:
   `node scripts/check-doc-links.mjs` reports any broken relative link or `#anchor`.
2. Search for citations of anything you renamed, such as `SPEC 6.8`, in docs, code comments and open issues
   (`node scripts/check-doc-refs.mjs` checks the ones in this repository).
3. If a doc disagrees with `docs/spec/`, do not pick a reading. Say so in the PR and ask.
4. Reread for the voice rules below.

**Preview the docs site**

The docs are also published as a site (`site/`, at podium.engelking.dev). A docs change shows up there when `main` moves, so check
how it builds before you open the PR. `site/` is its own project and is not an npm workspace:

```sh
cd site && npm ci --ignore-scripts          # once
cd .. && node site/scripts/build.mjs --latest-only
python3 -m http.server -d site/out 4400     # open http://127.0.0.1:4400/
```

The build fails on a broken link between pages. A new page inside a split topic's folder is found from its folder and its `order`. A new page or topic elsewhere needs a line in `site/docs-nav.mjs`, or it is not published. The
`podium-docs-site` skill (`.claude/skills/`) has the rest, including how older versions are built from their git tags.

### The mod version bump

Do not bump the version in a feature or fix PR, including one that changes the mod (anything under
`mod/podium-reporter/` other than its tests). Add a line under `[Unreleased]` in `CHANGELOG.md` and leave the
version files alone. The maintainer decides when `development` is ready to release. A release-prep PR into
`development` then sets one number in `plugin.json`, `VERSION` in `mod/podium-reporter/hooks/register.ts`, the three
`package.json` files and the lockfile (`npm install --package-lock-only`), and renames `[Unreleased]`; a test checks
that they all match. Installed copies of the mod only update when that number changes. A `development` to `main`
PR carries the release, and CI (the "Mod version bump check" workflow in `.github/workflows/mod-version-check.yml`)
fails it if the mod changed and the number did not. The maintainer tags the release after it merges. `.claude/PROJECT.md`,
"Releases", has the full list of files and how the bump level is chosen.

If the bump is a new minor version, also move `max` in `REPORTER_SUPPORT` (`server/src/fleet/compat.ts`) to
that version. Otherwise the server tells every up-to-date mod it is newer than the server supports. Raise
`min` only when the server stops reading older reports correctly. SPEC 6.8 has the rule.

### The report format

The mod and the server share one set of report types, copied between `<protocol:begin>` and
`<protocol:end>` markers in `server/src/fleet/protocol.ts` and `mod/podium-reporter/hooks/protocol.ts`. A
test compares them. Change both together.

### Voice

Write docs and PR text like a person wrote them: say the thing plainly, no em-dashes, no marketing filler,
no formulaic constructions. Reread what you wrote once before opening the PR.

## Branching, PRs and merging

> **Open your PR against `development`, not `main`.** GitHub's default branch is `main`, so a fresh clone
> starts on `main` and the "New pull request" button proposes `main` as the base. Both are the wrong
> starting point for a change. `main` holds released code and moves only when the maintainer cuts a release.
> `development` holds unreleased work, and every change lands there first.

Every change lands on a branch, never directly on `development` or `main`, however small. If you work from a
fork, fork the repo, then branch from `development`, not from the `main` your clone starts on:

```sh
git clone https://github.com/<you>/podium.git && cd podium
git fetch origin development
git checkout -b <your-branch-name> origin/development
git config core.hooksPath scripts/hooks   # refuses a commit made on main or development
```

If you have push access, skip the fork and branch from a current `development` in the main repo
(`git checkout development && git pull`, then `git checkout -b <your-branch-name>`).

When the change is ready, open the PR with the base set to `development`:

```sh
gh pr create --base development
```

On github.com, change the "base" dropdown from `main` to `development` before you click "Create pull request".
If you opened it against `main` by mistake, use the "Edit" button next to the PR title to change the base; no
need to close it and start over. A CI check ("PR target check") fails any PR into `main` that is not a release or a hotfix from this repo, so a wrong base shows up as a red check.

Say in the PR body that it is to be squash-merged. This repo keeps one commit per PR on `development`, however
many commits your branch has. The PR template has a checklist. Put `Closes #N` in the body for the issue the PR
resolves; the maintainer closes the issue when the PR merges, because GitHub only closes issues for a PR into `main`.

Two kinds of PR go to `main`, and the maintainer opens both: a release (`development` into `main`, merged with a
regular merge commit and never squashed) and a hotfix (branched from `main`, then cherry-picked back into
`development`). If you think a fix cannot wait for the next release, say so on the issue instead of opening it
against `main`.

Only the maintainer merges PRs into `development` or `main`, however small the change looks. Open the PR and wait for
review.

## Filing issues

Bug reports and proposals both go through GitHub issues, and the templates ask for what is useful. Check
for an existing issue first. If you are reporting several problems with one cause, one issue is more
useful than one per symptom.

For a bug report, paste the output of `/podium` along with `podiumctl status`. Run `/podium` inside the
Claude Code session that shows the problem (it is a Claude Code command, not a shell one like `podiumctl`).
It shows the connection state, the `Versions:` line and the report counts, so we can tell whether the mod is
connected, refused (HTTP 401) or out of step with the server. It does not print your token, but check what you
paste and remove any token or other secret before posting.

**Security problems are different.** Please do not open a public issue for a suspected vulnerability.
Follow [SECURITY.md](.github/SECURITY.md) and report it privately.

By taking part you agree to follow the [Code of Conduct](.github/CODE_OF_CONDUCT.md).
