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

<!-- nav:start -->
---

Previous: [Logging](16-logging.md) · Up: [Components](README.md) · Next: [Other server parts](18-other-server-parts.md)
<!-- nav:end -->
