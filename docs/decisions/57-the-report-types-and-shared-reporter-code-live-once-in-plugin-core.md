---
title: "57. The report types and the shared reporter code live once, in plugin/core (#927)"
description: "The server, the UI and every reporter import one protocol.ts from plugin/core, so the byte copy and its test are gone."
group: "Project internals"
number: 57
date: "2026-11-02"
status: "accepted"
order: 57
---

# 57. The report types and the shared reporter code live once, in plugin/core (#927)

*Supersedes 6: there is no second copy and no test comparing two.*

**Context.** Entry 6 kept the Report types in `server/src/fleet/protocol.ts` and, byte for byte, in the mod, with a test
comparing them, because a mod test could not read the server's file. A second reporter would have needed a third copy, and
the copy was hidden from the duplication scan by `sonar.cpd.exclusions`.

**Decision.** The Report types, limits and helpers live in `plugin/core/protocol.ts`. The server (`server/src/fleet/protocol.ts`
re-exports them and adds the view types and the validator), the UI and every reporter import that file. The byte-for-byte
copy, its comparison test and the `sonar.cpd.exclusions` entry are removed. The rest of the shared reporter code (transport,
failures, redaction, plan, machine id, build and git helpers) is in `plugin/core/` as well.

**Why.** The build (56) puts `core` inside each plugin, so a reporter can import it and still install on its own. With one
file there is nothing to keep equal. The mod and the server no longer have to share a repo for this reason, though they still
do for entry 12's other reasons.

**Constraint kept.** `plugin/core/protocol.ts` stays free of Node imports, directly and through what it imports, because the UI
imports it (#551). Code that needs Node (transport, redaction, machine id) is in other files that the UI never imports. A test
walks the imports.

**Cost.** A change to the wire format is one edit that both the server and every reporter pick up, so a reporter's version
and the server's range (SPEC 6.8) have to be thought about together.

<!-- nav:start -->
---

Previous: [56. The reporters live in plugin/, with a shared core and a folder per harness, and are built into dist/ (#927)](56-the-reporters-live-in-plugin-with-a-core-and-a-folder-per.md) · Up: [Decisions](README.md) · Next: [58. The built plugins are published to the plugin-dist branch on a merge to main (#927)](58-the-built-plugins-are-published-to-the-plugin-dist-branch-on-a-merge.md)
<!-- nav:end -->
