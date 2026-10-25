---
title: "After /clear the recording is on a different session"
description: "/clear gives the session a new id and the recording carries over; replay the first part from the old page and the rest from the new one."
group: "Project internals"
area: "Session recording"
date: "2026-10-20"
status: "open"
order: 41
---

# After `/clear` the recording is on a different session

**You see:** After `/clear` the old session's recording reads stopped, with no one named, and the new session shows it
recording.

**Why:** `/clear` gives the session a new id. The server carries a running recording over to the new session, with the same
starter and start time, and stops the old one. The owner's consent is not carried: the new session's own report must state
that `sessionRecording` is on.

**Do:** Replay the first part from the old session's page and the rest from the new one. If the new session says the
reporter does not allow recording, turn the option on for that machine.

<!-- nav:start -->
---

Previous: [A permission prompt or question I answered in the terminal is not in the replay](terminal-answers-missing-from-the-replay.md) · Up: [Gotchas](README.md) · Next: [An Admin style does nothing, or looks like the fleet page's](admin-style-does-nothing-or-looks-like-the-fleet-page.md)
<!-- nav:end -->
