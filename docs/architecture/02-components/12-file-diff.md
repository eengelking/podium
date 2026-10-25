---
title: "File diff"
description: "How a changed file's diff is captured by the mod, redacted, stored and shown in a modal."
group: "Project internals"
order: 12
---

# File diff

Files: `mod/podium-reporter/hooks/fileDiff.ts`, `diffRedact.ts`; `server/src/fleet/fileDiffs.ts`, `respondRoutes.ts`;
`frontend/src/fleet/components/FileDiffModal.tsx`, `FilesList.tsx`, `diffRows.ts`. Issue #319. The reasoning is in
DECISIONS 36.

**Flow.** The owner's browser calls `GET /api/fleet/respond/sessions/:id/files/diff?path=`. The route checks the
`file-diff` flag, the respond sign-in, that the signed-in name is the session's owner, and that the reporter said
`fileDiff: true`. It then calls `DiffBroker.ask`, which holds the request in memory for 15 seconds. The next reply to
the session's report lists it in `diffs`; the mod (`handleDiffs` in `register.ts`) reads it with `readFileDiff` and
answers `PUT …/diffs/:requestId`; the broker resolves the waiting request and drops its entry.

**Mod.** `readFileDiff` takes the path only if the Files list names it, refuses a withheld path without running git,
diffs against the same base as the list (`resolveRef`, shared with `readChanges`), strips the file headers, cuts at
2,000 lines or 200,000 bytes, then `redactDiff` replaces anything that looks like a secret. Cutting comes first, so
the redaction count is for what is sent.

**Tests.** The mod's tests need Claude Code (`npm run test:mod`), so CI cannot run them. The four that need no
engine (`diffRedact`, `fileDiff`, `git`, `transport`) also run under the server's vitest, through an alias for
`claude-code/testing` in `server/vitest.config.ts`, so SonarCloud's coverage gate sees the mod's pure modules.

**Server.** `DiffBroker` is the only holder of a diff, and only while a browser waits. The sign-in routes stay
available when only `file-diff` is on (`signInEnabled` in `respondRoutes.ts`); the respond routes still need their
own flags. `GET /respond/me` reports `enabled` for either feature, so the top bar offers the sign-in.

**Console.** `FilesList` decides with `diffAccess` whether a row is a button, a plain row with a line saying why, or
unchanged. `FileDiffModal` builds on `Modal` and draws `parseDiff` rows as text nodes, twice: two panes and one column.
A container query on the modal (`fleet.css`) shows the one that fits. Its loading dots step on the shared beat
(`useHeartbeat`), not a CSS animation.

<!-- nav:start -->
---

Previous: [Responding](11-responding.md) · Up: [Components](README.md) · Next: [Orchestrator messaging](13-orchestrator-messaging.md)
<!-- nav:end -->
