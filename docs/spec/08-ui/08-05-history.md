---
title: "8.5 History"
description: "What the History page (#/history) shows and does: day picker, table, paging, opened session, empty and error states, sign-in and narrow layout."
group: "Reference"
section: "8.5"
order: 5
---

# 8.5 History

History is the console page at `#/history` that lists the sessions that ended or were dropped on one day, and opens
any of them as a read-only orchestrator page built from the rows the server stored. It reads
`GET /api/fleet/history` ([7.1](../07-server/07-01-endpoints.md)) for the list and `GET /api/fleet/sessions/:id`
for an opened session. The frame it shares with the other pages (top bar, info row, theme) is in
[8.1](08-01-what-the-ui-must-do.md); this page owns the rest. The tests are
`frontend/src/fleet/history.test.tsx`, `historyRecording.test.tsx` and `historySignIn.test.tsx`.

## 8.5 The page

- The browser tab's title is "Podium history". The page has one `h1`, "History", which is visually hidden; an
  opened session's own name is the `h1` instead.
- The page draws the shared top bar with its page pill reading "History" and no History button
  ([8.1](08-01-what-the-ui-must-do.md)), then the info row. The info row says "Past sessions. Read-only: built
  from what the server stored. Cost is an estimate, not a bill." and carries the shortcuts switch and the theme
  picker at its right end.
- Below the info row is the day's list. When a session is open, the list gives way to that session (below) and
  comes back on Back.
- Nothing on this page changes a session: it has no respond controls, no Remove and no drag.

## The day picker

- A date input labelled "Day" picks the day. It opens on today in the browser's local time. Choosing a date loads
  that day and goes back to page 1; clearing the input is ignored.
- A day is the local calendar day. A session belongs to the day on which it ended or was dropped.
- To the right of the picker, once a day has loaded, a caption reads "N sessions ended", where N is the whole
  day's count (`total`), not the rows on the page. It reads "1 sessions ended" for one.
- The server keeps sessions for 30 days after they end ([7.2](../07-server/07-02-database.md)), so a day older than
  that is empty.

## The table

- One row per session, newest ended first, with these columns in order:

  | Column | Shows |
  |---|---|
  | Session | The session's name, a button that opens it. When the row carries a recording, a second line, below. |
  | Project | The working folder, in the monospace face. |
  | Model | The model chip. |
  | Ended | The time of day it ended, `HH:MM:SS` local. |
  | Duration | `M:SS` under an hour, `Hh MMm` under a day, then `Dd HHh`. |
  | Est. cost | The estimated cost in dollars, or "n/a" for a model with no price. |
  | Blowouts | The count, or "–" for none. |
  | Agents | The number of agents it launched. |
  | End reason | The reason it ended, or "–" when none was recorded, then the `/clear` lines, below. |

  Number columns align right.
- Recording line (#353). A row whose session has a recording the viewer may open has a link under the name,
  "recording kept until `<time>`", or "recording kept" when it is not known until when. It opens the session, where the
  recording is. It is shown to the session's owner and to an Admin only, and only while the `session-recording` flag
  is on ([7.1](../07-server/07-01-endpoints.md); [8.1](08-01-what-the-ui-must-do.md)).
  When the person signs in or out, the day is read again, so the line follows the sign-in.
- `/clear` lines (#206). A session that continues after a `/clear` has, under its end reason, "continued in
  `<first 8 characters of the id>`", which opens the session that went on. A session that began from one has "after
  /clear of `<first 8 characters of the id>`", which opens the earlier one. Each is on its own line, so neither is
  cut off, and each opens its session like the name does.
- Cells do not wrap, except the `/clear` lines and the recording line, which wrap to the width.

## Paging

- A pager under the table (#195) reads "Showing A to B of N" (announced as a status), then "Rows per page" with 25,
  50 or 100 (default 50), Previous, "Page P of Q" and Next. Previous is disabled on page 1 and Next on the last page.
  The page size is the same set the server accepts ([7.1](../07-server/07-01-endpoints.md)).
- Changing the rows per page goes back to page 1, as does changing the day.
- The count comes from the server's `total`, and the server builds only the page asked for (#273). While the next
  page of the same day loads, the table on screen stays; a change of day shows "Loading…" in its place.
- When the address names a page past the end, the server answers with the last page and the address follows it.
- The list's place is kept in the address: `#/history?day=YYYY-MM-DD&page=N&size=N`, with `&open=<session id>` while a
  session is open. A reload, a shared link and the browser's Back button therefore land on the same list. An address
  with a missing or invalid day uses today; an invalid page uses 1 and an invalid size 50. Changing the day, page or
  size replaces the current entry; opening a session adds one, so Back returns to the list on the same page.

## An opened session

- A session opens in place of the list, from its name, a recording line or a `/clear` line. Its page is the
  orchestrator page ([8.1](08-01-what-the-ui-must-do.md)) built from the stored rows, with the
  last state the server held: an ended session shows the Done band and all its agents done. It has the agent tree and
  an agent's detail in a right panel (labelled "Agent detail"); the orchestrator row opens its own detail.
- Above it, "← Back to `<day>`" returns to the list. If the session was opened from the list it does what the
  browser's Back button does, so the list shows the page it was on; if the page was loaded from an address with
  `open=`, it clears `open` from the address.
- While it loads the page says "Loading the session…". A session the server no longer holds says "Could not load
  that session (not found)." and any other failure "Could not load that session (HTTP N)." The browser's Back button returns to the list.
- The page is read-only. It has no respond, ask, plan or message controls, because it is built with responding
  off. Its recording layer, **Open replay** and **Delete recording**, shows when the session has a recording, for the
  session's owner and an Admin ([8.1](08-01-what-the-ui-must-do.md)). It shows the Resume and Fork
  cells of the facts row, since an opened ended session offers them as any ended session does
  ([8.1](08-01-what-the-ui-must-do.md)).
- On an opened session the Activity feed's refusal line ends "Sign in if that is you.", because this page does not
  know whether the viewer is signed in ([8.1](08-01-what-the-ui-must-do.md)). The top bar's Sign in is the way.

## Empty, loading and error states

- Loading the day: "Loading…".
- A day with no sessions: "No sessions ended on `<day>`.", with no table and no pager. The caption reads "0 sessions
  ended".
- The server cannot be reached or answers an error: "Cannot reach the Podium server (`<reason>`). Start it with
  `npm run dev`." The caption and the pager are not shown. Choosing another day asks again.
- A failed list never shows a stale table from another day.

## Who can see what

- The list needs no sign-in: any viewer who can open the console sees every ended session's summary row.
- Two things depend on who is looking: the recording line and the opened session's recording layer (the session's
  owner or an Admin), and stored Activity history ([8.1](08-01-what-the-ui-must-do.md)), which only the owner or an
  Admin may read.
- The top bar's **Sign in** is shown only while at least one thing needs it: responding, file diffs, peer messaging,
  stored Activity history or session recording is on. With all of them off there is no Sign in and the page does not
  ask who is signed in. Its dialog's wording follows what is on ([8.1](08-01-what-the-ui-must-do.md)).
- A viewer who signs in or out sees the day read again, so rows gain or lose the recording line at once.

## Narrow widths

- No horizontal scroll of the page at 400 px ([8.4](08-04-accessibility-and-responsiveness.md)). The table scrolls
  sideways inside its own container, and the pager's controls wrap onto further lines.
- Below 1040 px the opened session's right panel stacks under the main column in place of beside it, at the full
  width.
- Every control, the day input, the table's links, the pager's select and buttons and Back, is a real input or button
  with a visible focus ring ([8.4](08-04-accessibility-and-responsiveness.md)).

## Related

- [8.1 What the UI must do](08-01-what-the-ui-must-do.md): the shell, the orchestrator page and session recording that History reuses.
- [7.1 Endpoints](../07-server/07-01-endpoints.md): `GET /api/fleet/history` and the row it returns.
- [5.8 Session identity and /clear restarts](../05-mod-api/05-08-session-identity-clear-restarts.md): why a row can carry `clearedFrom` and `clearedInto`.

<!-- nav:start -->
---

Previous: [8.4 Accessibility and responsiveness](08-04-accessibility-and-responsiveness.md) · Up: [8. The UI](README.md)
<!-- nav:end -->
