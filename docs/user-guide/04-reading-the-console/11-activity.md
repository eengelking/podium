---
title: "Activity"
description: "Read the Activity panel, which lists what just happened, and jump to the session it is about."
group: "Getting started"
order: 11
---

# Activity

The right panel lists what just happened, newest first, 12 at a time. Click a row to jump to the session and agent it is
about. Rows for sessions that have ended are greyed out.

| Row | When |
|---|---|
| Yellow, "Waiting for your approval." or "Waiting for your input." | A session is waiting on you (a permission prompt or a question). A chip under it names the tool, such as `Bash` or `AskUserQuestion`. Once the session moves on, the row turns plain and reads "Waited for your approval." |
| Blue, for example "Waiting for 1 background shell to finish." | A session is idle on background work. A chip names the kind of work (`shell`, `agent`, `wake-up`) |
| Plain sentence, such as "Session ended (cleared)." | A turn that ended after a failing call, a session ending or starting, or an agent seen only by settings hooks |

<!-- nav:start -->
---

Previous: [One session](10-one-session.md) · Up: [Reading the console](README.md) · Next: [Answering a session from Podium](12-answering-a-session-from-podium.md)
<!-- nav:end -->
