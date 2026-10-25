---
title: "The status line says \"refused: session belongs to someone else\""
description: "The server refuses reports for a session owned by another person; quit Claude Code and start a new session."
group: "Project internals"
area: "Reporters and machines"
date: "2026-10-15"
status: "open"
order: 13
---

# The status line says "refused: session belongs to someone else"

**You see:** `podium-reporter: podium v0.14.2 refused: session belongs to someone else` (your version will differ).
The server logs a `report.conflict` warning for the same session id every 5 to 10 seconds.

**Why:** The session is stored as owned by one person (Admin, say) and the mod is now sending as another. The server
refuses with a 409 (#209), and is right to. Whether the mod should keep a session's identity through a settings change,
a reload and a clear is not decided.

**Do:** Quit Claude Code and start a new session, as in [I changed my reporter settings and a running session did not change who it reports as](running-session-keeps-its-old-identity.md). The message clears at the next accepted report.

<!-- nav:start -->
---

Previous: [I changed my reporter settings and a running session did not change who it reports as](running-session-keeps-its-old-identity.md) · Up: [Gotchas](README.md) · Next: [podiumctl start fails with "port N ... is already in use"](podiumctl-start-port-already-in-use.md)
<!-- nav:end -->
