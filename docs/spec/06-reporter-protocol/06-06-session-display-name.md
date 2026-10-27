---
title: "6.6 Session display name"
description: "How a session's display name is chosen, in priority order."
group: "Reference"
section: "6.6"
order: 6
---

# 6.6 Session display name

The first of these that applies, in priority order:

1. A name set with `/podium name <text>` (kept in `$.store` by session id).
2. The name Claude Code gives the session, such as one set with `/rename` (#322). This is the `session_title`
   that the `classic.SessionStart` and `classic.UserPromptSubmit` hooks carry, trimmed and clipped to 80
   characters, kept per session id and dropped when the id changes. A hook without a title leaves the last one
   in place, so a rename shows from the next prompt.
3. The title the Claude desktop app shows for the session (#595), read from the `name` of the entry in
   `claude agents --json` whose `sessionId` is the session's id, trimmed and clipped to 80 characters. It is read on
   the first git poll and about every 30 seconds after, and it counts only while no hook has carried a
   `session_title` for that id, so a Team or Enterprise login (which has Claude Code's guard skip the `classic.*`
   hooks) still gets a name. A missing `claude`, a failed command or a session the list does not hold changes nothing.
4. The `sessionName` option.
5. For a worktree, the last segment of the branch (`refactor/invoice-v2` gives `invoice-v2`) or of the
   worktree directory.
6. The repository directory's name.
7. `session-<first 6 of id>`.

<!-- nav:start -->
---

Previous: [6.5 Models, windows, prices](06-05-models-windows-prices.md) · Up: [6. The reporter protocol](README.md) · Next: [6.7 Reporting cadence](06-07-reporting-cadence.md)
<!-- nav:end -->
