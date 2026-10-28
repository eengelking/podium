---
title: "The Activity section says to turn on activityFeed, but the option is on"
description: "A session reads its podium-reporter options once, when it starts; run /reload-plugins in it after turning an option on."
group: "Project internals"
area: "Connecting the mod"
date: "2026-10-27"
status: "open"
order: 57
---

# The Activity section says to turn on `activityFeed`, but the option is on

**You see:** An orchestrator's Activity section reads "Recent tool calls and text appear here while the orchestrator works" and asks you to turn on the `activityFeed` option. The option is on in `/plugin configure`, and the Admin's Activity feed switch is on.

**Why:** The reporter reads its options once, when the plugin loads in a session. A session that started before you turned `activityFeed` on keeps reporting it as off, and the console shows what the session last reported. The Admin's switch is a separate check and has a different message ("The activity feed is turned off by the Admin").

**Do:**

1. In that session, run `/reload-plugins`. The session reports the option as on in its next report.
2. Reopen the Activity section. A session that is already running when you change any reporter option needs the same reload.

<!-- nav:start -->
---

Previous: [My session's name is the folder, and background tasks, notifications and permission answers are missing](session-name-is-the-folder-and-classic-hooks-are-skipped.md) · Up: [Gotchas](README.md) · Next: [A store call without await compiles and answers wrongly](a-store-call-without-await-compiles-and-answers-wrongly.md)
<!-- nav:end -->
