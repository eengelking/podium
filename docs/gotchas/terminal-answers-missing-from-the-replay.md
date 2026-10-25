---
title: "A permission prompt or question I answered in the terminal is not in the replay"
description: "The replay marks only answers sent from Podium; read the tool's result to see what ran."
group: "Project internals"
area: "Session recording"
date: "2026-10-20"
status: "open"
order: 40
---

# A permission prompt or question I answered in the terminal is not in the replay

**You see:** The replay shows the tool call and its result, but no "Allowed a tool once" or "Answered a question" row.

**Why:** The replay marks only answers and approvals sent from Podium. The mod cannot see a permission prompt that was
answered in the terminal, and a question's result arrives as an object it cannot read as text.

**Do:** Read the tool's result: it shows what ran and whether it was refused. A decision row means someone answered from
Podium.

<!-- nav:start -->
---

Previous: [Record says "This session's reporter does not allow recording"](record-says-the-reporter-does-not-allow-recording.md) · Up: [Gotchas](README.md) · Next: [After /clear the recording is on a different session](recording-moves-to-a-new-session-after-clear.md)
<!-- nav:end -->
