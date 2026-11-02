---
title: "A script or a path expects the server's compiled files directly in server/dist"
description: "Since #927 the compiled server is in server/dist/server/src/; start it with server/dist/index.js and find folders with serverDir, not a count of dots."
group: "Project internals"
area: "Running the server"
date: "2026-11-02"
status: "open"
order: 63
---

# A script or a path expects the server's compiled files directly in server/dist

**You see:** A script or a piece of code that reads `server/dist/fleet/...` or `server/dist/tls...` finds nothing, or a path built
with a fixed number of `..` from a compiled file lands in the wrong folder.

**Why:** The server build also compiles `plugin/core/protocol.ts`, the one copy of the report types (DECISIONS 57). TypeScript then
keeps the repository's layout, so the server's files are in `server/dist/server/src/` and the shared file is in
`server/dist/plugin/core/`. `server/dist/index.js` is written by `server/build-entry.mjs` and only imports the real entry, so
`node server/dist/index.js` and the container's `CMD` are unchanged.

**Do:** Start the server with `node server/dist/index.js`. In server code, find the package or the repository with `serverDir` and
`repoRoot` from `server/src/serverRoot.ts`, which walk up to the `package.json`, instead of counting `..`, because the count differs
between `src/` and `dist/`.

<!-- nav:start -->
---

Previous: [npx tsc prints Version 6 although the project is on TypeScript 7](npx-tsc-says-version-6-but-the-project-is-on-typescript-7.md) · Up: [Gotchas](README.md) · Next: [The reporter will not load from plugin/claudecode, or a change does not show](plugin-source-folder-cannot-be-loaded-on-its-own.md)
<!-- nav:end -->
