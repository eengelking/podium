---
title: "Blowouts 1x on a card that is nowhere near full"
description: "An automatic compaction after a quiet stretch is the likely cause; it is not a usage reset or an overflow."
group: "Project internals"
area: "What the console shows"
date: "2026-10-28"
status: "fixed"
fixed_in: "#803"
order: 58
---

# Blowouts 1x on a card that is nowhere near full

**You see:** A card, the orchestrator page or the Blowouts KPI shows one blowout, but the context bar is far from full and no usage limit was reached.

**Why:** Claude Code compacted the session on its own, most likely after a quiet stretch such as a prompt-cache timeout, while it waited on a background agent. Older reporters counted every automatic compaction as a blowout. It is not a usage reset and not an overflow. The cause is "likely" until the event's `idleMs` confirms a long idle gap.

**Do:** Update the reporter. From the next release an automatic compaction below 80% full is a `compact` event ("auto-compacted at 22%") and the count stays 0. A blowout already stored for a past session stays. To check a new one, open the event in the feed and read `idleMs` in its data.

<!-- nav:start -->
---

Previous: [A store call without await compiles and answers wrongly](a-store-call-without-await-compiles-and-answers-wrongly.md) · Up: [Gotchas](README.md)
<!-- nav:end -->
