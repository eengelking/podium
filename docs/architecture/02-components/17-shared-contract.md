---
title: "Shared contract"
description: "Where the Report types live on the server and in the mod, and how a test keeps them identical."
group: "Project internals"
order: 17
---

# Shared contract

The Report types live in `server/src/fleet/protocol.ts` and, byte for byte between markers, in
`mod/podium-reporter/hooks/protocol.ts`. A test compares them (DECISIONS 6). `protocol.ts` must also stay free of Node imports, directly or through what it imports, because the UI imports it and the Vite dev server does not tree-shake (#551); a test walks its imports. The UI imports the view types from the
server's file. `docs/fixtures/report.sample.json` is the shared fixture.

<!-- nav:start -->
---

Previous: [Logging](16-logging.md) · Up: [Components](README.md) · Next: [Other server parts](18-other-server-parts.md)
<!-- nav:end -->
