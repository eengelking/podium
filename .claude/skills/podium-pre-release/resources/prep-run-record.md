<!-- Template: the body of a release-prep PR. Copy it, replace <X.Y.0>, and fill every row.
     Results: passed (with the command's counts), fixed (with what), not run (with the reason) or failed (with the issue that tracks it).
     A step with no row was not done. A limited run says so (for example "SQLite only, PostgreSQL NOT RUN"). -->
## Release prep for <X.Y.0>

Squash-merge into `development`. The `development` to `main` release PR follows, and the tag waits for the maintainer's approval. This PR closes `#<prep issue>`.

### What changes
- <each versioned file that moved, `compat.ts` `max` when a minor or major, the atlas rail, footer, date and line counts>
- `CHANGELOG.md`: `[Unreleased]` is now `[<X.Y.0>] - <date>`, with a fresh empty `[Unreleased]` above it and the links updated. `changelog.d/` holds only its README.
- `dist/claudecode/` and `dist/opencode/` rebuilt with `npm run plugin:build:release`.
- <`docs/standards/` regenerated with `podium-standards-update`, or "no standards fragments">

### Run record

| # | Step | Result | Counts or reason |
|---|---|---|---|
| 1 | Start: every other milestone issue closed, branched from `origin/development` | | |
| 2 | Deprecations (`node scripts/check-deprecations.mjs`) | | |
| 3 | Changelog assembled, `[Unreleased]` renamed and dated | | |
| 4 | Versions, lockfile, old-version grep | | |
| 5 | `podium-standards-check`; `podium-standards-update` if needed; `npm run standards:parity` | | |
| 6 | `podium-patterns-check` | | |
| 7 | `podium-atlas-update`; `node scripts/atlas-functions.mjs --check` | | |
| 8 | `podium-docs-site`: `node site/scripts/build.mjs` | | |
| 9 | `podium-live-test` (model and harnesses), or "no harness-contract change" | | |
| 10 | `podium-e2e-update`; `npm run e2e` on each registered database; `node scripts/e2e-map.mjs` | | |
| 11 | `npm test`; `npm run build`; `scripts/test-db.sh` (each adapter, files and tests); `test:core`; each harness's `test:mod` and `typecheck:mod` | | |
| 12 | `dist/` rebuilt last; `npm run plugin:dist:check` | | |
| 13 | Archives: `scripts/podium-reporter-zip.mjs --expect-version` for each harness | | |
| 14 | Release check (fresh Haiku agent): verdict | | |
| 15 | PR trace check; `sonar analyze` on the changed files (say if `SKIPPED`) | | |

### Evidence checks (run by the main session; paste the output)

| Check | Expected | Output |
|---|---|---|
| `ls changelog.d` | `README.md` only | |
| `grep -rn "<old version>" --exclude-dir=node_modules --exclude-dir=.git .` | only the known sample-data hits | |
| `npm run plugin:dist:check` | passes | |
| `npm test -w server -- versions` (`scripts/versions.test.ts`, every versioned file agrees) | passes | |
| `git log origin/development..HEAD --oneline` and `git log HEAD..origin/development --oneline` | the prep commits only; nothing on `development` that this branch lacks | |
| `git diff --stat origin/development -- docs/standards` | not empty when `Standards:` lines were assembled | |

### Audit
Fresh Haiku agent, report-only: <verdict, and every row it could not confirm>.

Patterns: <entries the change relies on>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
