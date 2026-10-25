---
title: "6. The report types are copied, and a test keeps them equal"
description: "The Report types are copied byte for byte into the mod and a test keeps the two equal, which is why the mod stays in this repo."
group: "Project internals"
number: 6
date: "2026-10-11"
status: "accepted"
order: 6
---

# 6. The report types are copied, and a test keeps them equal

**Decision.** The Report types live in `server/src/fleet/protocol.ts` and, byte for byte between markers, in
`mod/podium-reporter/hooks/protocol.ts`. `server/src/fleet/protocol.test.ts` compares the two.

**Why.** The mod's tests run in the hooks sandbox, which has no file system, so a mod test cannot read the
server's file. The comparison has to live where both files can be read (`docs/architecture/`, spec questions 1
and 2).

**Cost.** The mod and the server have to stay in one repo, or this check needs a replacement. This is why
the mod was not moved to a separate repo (entry 12).

<!-- nav:start -->
---

Previous: [5. Settings hooks as a reduced fallback](05-settings-hooks-as-a-reduced-fallback.md) · Up: [Decisions](README.md) · Next: [7. Cost is an estimate, except the session ledger](07-cost-is-an-estimate-except-the-session-ledger.md)
<!-- nav:end -->
