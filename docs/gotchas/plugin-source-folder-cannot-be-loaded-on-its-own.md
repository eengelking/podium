---
title: "The reporter will not load from plugin/claudecode, or a change does not show"
description: "The source imports plugin/core from outside its folder; run npm run plugin:dev:claudecode, which builds dist/claudecode and loads it, and rebuild after an edit."
group: "Project internals"
area: "Developing"
date: "2026-11-02"
status: "open"
order: 64
---

# The reporter will not load from plugin/claudecode, or a change does not show

**You see:** `claude --plugin-dir plugin/claudecode` or `claude plugin test plugin/claudecode` fails to find the shared code. Or you
loaded `dist/claudecode` and a change you made in `plugin/` is not in the session.

**Why:** The source imports the shared code from `plugin/core/`, outside its own folder, and a plugin may only import from inside its
folder. `scripts/plugin-build.mjs` copies `core` in and writes a self-contained `dist/<harness>/`, which is the folder that is
installed and zipped (DECISIONS 56). `claude --plugin-dir` does not rebuild it.

**Do:** Run `npm run plugin:dev:claudecode`. It builds `dist/claudecode` and starts `claude` with that folder loaded; the source folder
still cannot be loaded. Add `-- --watch` to rebuild after each edit, then run `/reload-plugins`. By hand it is `npm run plugin:build`
followed by `claude --plugin-dir /path/to/podium/dist/claudecode`, and the build runs again after each edit. `npm run plugin:dev:cleanup`
removes the output. `npm run test:mod` builds with the tests into `.build-test/` first, so it needs no separate step. If
the build says the folder is not self-contained, it names the import that leaves it. Both output folders are git-ignored.

Two edges of `plugin:dev`: npm swallows the first `--`, so `claude` arguments need a second one (`npm run plugin:dev:claudecode -- --watch -- --model sonnet`). And `--watch` uses a recursive `fs.watch`, which needs Node 20 or later on Linux; the session still needs `/reload-plugins` after each rebuild.

<!-- nav:start -->
---

Previous: [A script or a path expects the server's compiled files directly in server/dist](server-compiled-files-are-not-directly-in-server-dist.md) · Up: [Gotchas](README.md)
<!-- nav:end -->
