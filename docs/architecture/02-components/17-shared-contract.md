---
title: "Shared contract"
description: "Where the Report types live: once, in plugin/core, imported by the server, the UI and every reporter."
group: "Project internals"
order: 17
---

# Shared contract

The Report types, limits and helpers live once, in `plugin/core/protocol.ts` (DECISIONS 57, which replaced the byte copy of DECISIONS 6).
The server, the UI and every reporter import that file. `server/src/fleet/protocol.ts` re-exports it and adds the view types the server
sends to the UI and the validator. There is no second copy and no test that compares two.

`protocol.ts` must stay free of Node imports, directly or through what it imports, because the UI imports it and the Vite dev server does not tree-shake (#551); a test (`server/src/fleet/protocol.browser.test.ts`) walks its imports. Code that needs Node (transport, redaction, the machine id) is in other files of `plugin/core/` that the UI never imports.

`plugin/core/` is shared code and never imports a harness (`plugin/claudecode/`, `plugin/opencode/`), and one harness never imports the other; `server/src/plugin.test.ts` checks it (DECISIONS 56). The build (`scripts/plugin-build.mjs`) copies `core` into each `dist/<harness>/`, so an installed reporter has it inside its own folder.
`docs/fixtures/report.sample.json` is the shared fixture.

The Report has two versions (SPEC 6.2, #850). `validateReport` in `server/src/fleet/protocol.ts` reads `v: 1` with the closed lists Claude Code needs and `v: 2` with the `harness` and `capabilities` blocks and free strings for effort, plan source and agent kind. `harnessOf` in `protocol.ts` names the harness of either; the ingest refuses (`HarnessConflict`, a 409 from the route) a report that names another harness than the one stored for its session id. The reporter's transport (`plugin/core/transport.ts`) turns the two refusals a person can act on, an older server's 400 at `$.v` and that 409, into a notice instead of the bare status.

<!-- nav:start -->
---

Previous: [Logging](16-logging.md) · Up: [Components](README.md) · Next: [Other server parts](18-other-server-parts.md)
<!-- nav:end -->
