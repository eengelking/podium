---
title: "Record says \"This session's reporter does not allow recording\""
description: "The reporter's sessionRecording option is off by default; turn on Allow session recording on that machine."
group: "Project internals"
area: "Session recording"
date: "2026-10-20"
status: "open"
order: 39
---

# Record says "This session's reporter does not allow recording"

**You see:** You chose a session and pressed Start recording, and the dialog or the layer says the reporter does not
allow recording. Nothing is recorded.

**Why:** The third yes answer is the reporter's `sessionRecording` option on the machine the session runs on, and it is
off by default. The browser cannot turn it on, on purpose.

**Do:** On that machine, in Claude Code, run `/plugin configure podium-reporter@eengelking-marketplace`, or in the Claude
desktop app open Settings > Plugins > Podium-Reporter > Settings, and turn on **Allow session
recording**, then start the recording again. Capture begins at the next reply, so allow a few seconds.

<!-- nav:start -->
---

Previous: [My reporters is missing after signing in with the admin secret](my-reporters-missing-after-admin-sign-in.md) · Up: [Gotchas](README.md) · Next: [A permission prompt or question I answered in the terminal is not in the replay](terminal-answers-missing-from-the-replay.md)
<!-- nav:end -->
