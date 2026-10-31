---
title: "npx tsc prints Version 6 although the project is on TypeScript 7"
description: "Two packages provide a tsc command and npm links the TypeScript 6 one, so the scripts call TypeScript 7 by its path."
group: "Project internals"
area: "Developing"
date: "2026-10-31"
status: "open"
order: 62
---

# `npx tsc` prints `Version 6` although the project is on TypeScript 7

**You see:** `npx tsc --version` or `node_modules/.bin/tsc --version` prints `Version 6.0.3`, although `typescript` in
`frontend/` and `server/` is 7.x. A script that runs a bare `tsc` builds and type-checks with TypeScript 6 and passes, so
nothing tells you it used the wrong compiler.

**Why:** `@typescript/typescript6` is a dev dependency at the root. The two storage guard tests and
`scripts/promise-misuse.mjs` need TypeScript's JavaScript compiler API, and TypeScript 7 does not have it. That package
brings `@typescript/old`, which is TypeScript 6 and also provides a `tsc` command. Two packages now provide `tsc`, and
npm links the one from `@typescript/old` into `node_modules/.bin`. npm does not promise which one it links.

**Do:** Run TypeScript 7 by its path, `node node_modules/typescript/bin/tsc` (`node ../node_modules/typescript/bin/tsc`
inside `frontend/` or `server/`). The build scripts and `scripts/podium-mod-typecheck.sh` already do, so keep them that
way. Import the compiler API from `@typescript/typescript6`, never from `typescript`. If `@typescript/typescript6` is
ever removed, a bare `tsc` is TypeScript 7 again and this page can go.

<!-- nav:start -->
---

Previous: [A frontend test fails now and then, with an edit put back or an element not found, and passes on the next run](frontend-test-fails-now-and-then-an-edit-is-lost-or-an-element-is-missing.md) · Up: [Gotchas](README.md)
<!-- nav:end -->
