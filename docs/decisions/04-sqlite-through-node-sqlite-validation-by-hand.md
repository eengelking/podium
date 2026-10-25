---
title: "4. SQLite through node:sqlite, validation by hand"
description: "Storage is SQLite through the built-in node:sqlite and reports are validated by hand, with no new dependency but a validator to maintain."
group: "Project internals"
number: 4
date: "2026-10-11"
status: "accepted"
order: 4
---

# 4. SQLite through `node:sqlite`, validation by hand

**Decision.** Storage is SQLite via Node's built-in `node:sqlite`. Every report is validated by hand in
`protocol.ts` instead of with a schema library.

**Why.** There is no native build step and no new runtime dependency, which is plenty for one machine. The
spec allows no other runtime dependency without a written reason. A hand-written check also lets it clamp
long strings and strip control characters instead of rejecting a whole report (`docs/architecture/`, spec
questions 4 to 6).

**Cost.** The validator is code to maintain. `node:sqlite` is loaded through `process.getBuiltinModule`
because vitest cannot resolve the `sqlite` specifier, and Podium needs Node 24.

<!-- nav:start -->
---

Previous: [3. Full snapshots plus unacknowledged events](03-full-snapshots-plus-unacknowledged-events.md) · Up: [Decisions](README.md) · Next: [5. Settings hooks as a reduced fallback](05-settings-hooks-as-a-reduced-fallback.md)
<!-- nav:end -->
