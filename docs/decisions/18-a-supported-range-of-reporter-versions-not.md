---
title: "18. A supported range of reporter versions, not a protocol number"
description: "The server keeps a supported range of reporter versions and compares major.minor, instead of a protocol number, but someone must move the range."
group: "Project internals"
number: 18
date: "2026-10-12"
status: "accepted"
order: 18
---

# 18. A supported range of reporter versions, not a protocol number

**Context.** Issue #49 asked whether to follow `kubectl`, which allows a skew of one minor version, or to
add a protocol version that changes only with the report format.

**Decision.** The server keeps one range, `REPORTER_SUPPORT { min, max }`, of mod versions it reads
correctly (SPEC 6.8). It compares `major.minor` of each report's `reporter.version` and tells the reporter
in the reply.

- Below the range is `outdated`.
- Above it is `newer`.
- A version it cannot parse is `unknown` and never warns.

**Why.** A protocol number would warn less often, but `Report.v` already exists and has never needed to
change, and a warning that never fires is not much use. A range on the mod's own version:

- needs no new field on the wire,
- works for reporters that already send `reporter.version`,
- gives the opposite direction (a mod newer than the server) for free.

Ignoring the patch number keeps a mod-only fix from warning anyone.

**Cost.** Someone must move `min` or `max` when a change needs it. Forgetting `max` when a new mod minor
ships makes every up-to-date mod show `upgrade server`, and a test cannot catch that on its own. The release
steps are in `CONTRIBUTING.md` ("The mod version bump"), which says to move `max`.

<!-- nav:start -->
---

Previous: [17. Fleet cards keep a fixed width](17-fleet-cards-keep-a-fixed-width.md) · Up: [Decisions](README.md) · Next: [19. The changed-files list is a git diff against where the session started](19-the-changed-files-list-is-a-git-diff-against-where.md)
<!-- nav:end -->
