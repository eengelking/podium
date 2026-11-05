---
title: "56. The reporters live in plugin/, with a shared core and a folder per harness, and are built into dist/ (#927)"
description: "plugin/core holds shared code, plugin/claudecode and plugin/opencode hold one harness each, and a build writes a self-contained dist/<harness>/."
group: "Project internals"
number: 56
date: "2026-11-02"
status: "accepted"
order: 56
---

# 56. The reporters live in plugin/, with a shared core and a folder per harness, and are built into dist/ (#927)

*Supersedes the rename plan in 55 (#854): `mod/` becomes `plugin/`, not `reporters/`, and it happens before the second reporter.*

**Context.** The Claude Code reporter was `mod/podium-reporter/`, installed as the plain source tree. A second reporter (#855)
needs the same transport, failure, redaction and plan code. A marketplace installs only the plugin's own folder, and an import
that leaves it is refused, so shared code outside the folder cannot ship. Entry 55 planned `mod/` to `reporters/` with
`reporters/claude-code/`. The maintainer chose a different layout for #927.

**Decision.**

- **The layout.** `plugin/core/` holds the code every harness shares (the report types, transport, failures, redaction, plan,
  machine id and the git and build helpers). `plugin/claudecode/` holds only what is specific to Claude Code (the hooks, the
  manifest, the engine's types). `plugin/opencode/` holds what is specific to OpenCode and is a placeholder until #855.
  `mod/` is gone.
- **The direction of imports.** A harness folder may import `core`. `core` never imports a harness, and one harness never imports
  the other. `server/src/plugin.test.ts` fails when one does.
- **The build.** `scripts/plugin-build.mjs` writes `dist/<harness>/` (tracked on `main` since 60): the manifest, a generated `hooks/hooks.json`,
  and the source tree kept as it is under `plugin/<harness>/` and `plugin/core/`, with no import rewritten. It fails when the
  result is not self-contained. Each `dist/<harness>/` is a complete plugin that needs nothing outside itself, and the release
  archive is a zip of the same folder. `--with-tests` keeps the test files (`npm run test:mod:claudecode` builds that way into
  `.build-test/`), and `--check` only runs the self-containment check on a folder that is already built.
- **The dev stamp.** `npm run plugin:build` passes `--dev-stamp`, which writes `.claude-plugin/dev-build.json` (the commit, its
  tag and whether the tree had edits), so a reporter run from a checkout still shows `Dev: <commit>`. The script alone stamps
  nothing, and CI never stamps. A stamped build goes to the git-ignored `dist-dev/` (60), and `scripts/podium-reporter-zip.mjs` and
  `scripts/plugin-dist-check.mjs` refuse a folder that has the stamp, so a developer's build cannot be committed or zipped by mistake.
- **Running Claude Code from a checkout.** Claude Code is run against the built folder, `claude --plugin-dir dist-dev/claudecode`
  after `npm run plugin:build`, not against the source. `npm run plugin:dev:claudecode` does both steps (#927).

**Why.** A built folder is the only shape that satisfies the marketplace's containment rule while sharing one copy of the
code. Naming the folder for what it is (a plugin for a harness) fits OpenCode as well as Claude Code, where `mod/` named one
harness's mechanism. Doing it before #855 means the second reporter imports `core` and never copies it.

**Alternatives.** `reporters/claude-code/` (entry 55): the same layout under a different name, with the shared code still
undecided. Bundling `core` into one file per harness: rejected because the source tree can be read as it ships and the build
needs no tool beyond Node.

**Cost.** Running a reporter from a checkout needs a build first. The built tree duplicates `core` once per harness.

<!-- nav:start -->
---

Previous: [55. Reporters are keyed by machine and reporter name, the report gains a v2, and mod/ becomes reporters/ (#854)](55-reporters-are-keyed-by-machine-and-reporter-name-and-report.md) · Up: [Decisions](README.md) · Next: [57. The report types and the shared reporter code live once, in plugin/core (#927)](57-the-report-types-and-shared-reporter-code-live-once-in-plugin-core.md)
<!-- nav:end -->
