---
title: "8.1 What the UI must do"
description: "The UI's requirements, one line each, from the page frame through the Admin pages, responding and the orchestrator page."
group: "Reference"
section: "8.1"
order: 1
---

# 8.1 What the UI must do

Each line below is a requirement. The sections run from the page frame (shell, wall, board) through the Admin
pages, responding, the orchestrator page and the right panel.

## Shell

**Top bar**
- Logo and name, which are one link to the fleet page (`#/`, accessible name "Podium, fleet"), then Fleet,
  Board and History buttons, then Traffic while orchestrator messaging is on and Admin for a signed-in Administrator (below). Each leaves the wall as it is when already there.
- Fleet returns to the wall from the board or an orchestrator's page.
- The button for the page you are on is left off, since its pill already names it: no Fleet on the wall, no
  Board on the board, no History in History, no Admin in Admin, no Traffic on Traffic and no My reporters link on
  My reporters (#468; Traffic and My reporters were shown as the current page until then).
- History and Admin draw this same top bar (#452, #468), so their buttons, connection pill and Sign in match the
  other pages. Neither has a Hide top bar control or wall mode button, because they have no wall and the bar is one
  line; the `\` shortcut does nothing there. The Traffic link shows while orchestrator messaging is on, signed in
  or not, and the My reporters link while it is on and a person is signed in (#470).
- On Admin the bar's Sign in is the sign-in to respond, the same as everywhere. It does not unlock Admin: the
  Admin session is its own unlock, with its own form on the locked screen and Lock Admin at the bottom of the Admin
  menu. The locked, disabled and checking screens keep the same bar. There is no "Back to fleet" link; Fleet is
  the way back.
- A pill names the page. The page supplies it, not the top bar: "Fleet" on the wall, "Board" on the board
  (#346), "Orchestrator" on an orchestrator's page (#225), "History" in History, "Admin" in Admin.
- A connection pill: "N reporters live", or "1 reporter live". There is no synced time (#178). It reads red
  "disconnected, retrying" when SSE is down.
- Admin's top bar shows this same pill, from the same component and count, right after its "Admin" pill (#187).
- There is no clock. Nothing goes to the right of the connection pill, because its width changes with the
  reporter count and anything after it would move.
- No Pause or simulator buttons (those belong to the simulator script).

**Theme picker**
- The info row under the top bar carries the theme picker at its right end, in the live view and in History.
- It is a Theme dropdown and a Light, Dark or System radio group, with arrow keys moving through the radios.
- The choice is remembered in `localStorage` under `podium.theme` with try/catch.
- The default is Podium in System mode, which follows the OS. An old stored `light` or `dark` becomes Podium in
  that mode.
- The choice is applied to `<html>` before first paint.
- A theme with no palette for the chosen mode uses Podium's palette for that mode.

**Refresh every** (#138, `mockup/podium-update-interval.html`)
- The same row carries a **Refresh every** dropdown (2s, 5s, 10s, 20s, 30s, 60s; default 2s), left of the
  Shortcuts switch and the Theme dropdown.
- It is remembered in `localStorage` under `podium.updateEvery`, with try/catch. A stored value that is not one
  of the six is ignored.
- It sets how often the fleet page redraws: the browser keeps receiving every event, but shows the newest
  state once per interval, and the elapsed times and clock move on the same interval.
- A change shows at once when it is a change of connection phase, a session that newly reaches waiting or
  stale, or an agent that newly has a failure.
- The pulse and blink beat (`useHeartbeat`) is not affected. History and Admin have no such control, and the
  activity feed has its own.
- It goes with the info row when the top bar is collapsed, and the red disconnect banners replace the info
  row, so it is absent then.

**Legend**
- The legend (what the agent squares mean, and the model colors) is a footer under the middle column, on the
  wall and on the orchestrator page.
- The content above it scrolls and the legend does not. The rail and the right panel keep their full height
  beside it.
- It has a background halfway between the card surface and the page background (so it stands out from the
  cards) and a top border. Its items are centered and wrap on a narrow area. It stays visible in wall mode.
- Below 1040 px the page scrolls as a whole and the legend is the last thing on it, with extra padding.

**Columns**
- Three columns: left rail (252 px), main, right panel (340 px).
- Drag handles sit between them exactly as in the mockup: limits 180 to 440 and 260 to 700, main ≥ 420,
  double-click or Home resets, arrow keys 16 px, Shift 48 px, widths remembered, handles hidden and panels
  stacked below 1040 px.

**Collapsing**
- The left pane, the right pane and the top bar each collapse and expand on their own, from a visible control
  and from a shortcut: `[` left, `]` right, `\` top bar, `w` wall mode, `Esc` leaves wall mode.
- The single-key shortcuts (`[`, `]`, `\`, `w`) are off by default (WCAG 2.1.4, #636). A **Shortcuts** switch (the
  Admin `.sw` switch in a `.field`) in the Display settings row turns them on. It sits beside Refresh every and Theme
  on the wall, the Board, the orchestrator page, Traffic and My reporters, and beside Theme on History. It is kept per
  browser in `localStorage` under `podium.shortcuts` (`true` or `false`), the way the theme and the refresh interval
  are. While it is off the four keys do nothing, `Esc` still leaves wall mode, and every button still works. The
  pane controls' tips and the Wall mode button's title name their keys only while it is on. The switch's own hint
  (its `title` and `aria-describedby`) names all four keys.
- The shortcuts are ignored while typing in a field, with ctrl, meta or alt held, and on a resize handle.
- Every collapse control in the app is one pill, `EdgeTab` (`.edge-tab`): the top bar's, the Kanban KPI rows',
  the Plan / Files fold's and both panes'. It shows a styled tip (`data-tip`) on hover and keyboard focus, and a
  new collapse or open control uses it. A pane's pill sits in the `.cols` grid beside the pane, straddling its
  inner edge near the top, and, while Shortcuts is on, the tip names the shortcut ("Collapse the left pane ([)").
- A collapsed pane leaves a 24 px edge strip holding the same pill as its expand button (`aria-expanded`, `aria-controls`). Its
  content is `hidden`, so it is out of the tab order and the accessibility tree, and its saved width comes
  back when it opens.
- A collapsed top bar leaves a 4 px strip with a Show top bar button, and takes the info banner with it.
- The disconnect alert never collapses. With everything collapsed, a lost connection still shows the red "Lost
  the connection…" alert (and a red strip), and reconnecting clears it.
- The collapsed flags are remembered in `localStorage` under `podium.collapsed`, apart from the widths. The Board
  (`podium.collapsed.board`) and My reporters (`podium.collapsed.reporters`) keep their own.
- Below 1040 px the panes are stacked, so the pill becomes a 28 px full-width bar that collapses the stacked section
  (the rail's closes it upward, the activity panel's downward), and the Wall mode button is hidden.

**Wall mode**
- A Wall mode button (in the top bar, or in the upper right corner when the top bar is collapsed) collapses
  all three at once and asks the browser for fullscreen from that click only. A refusal changes nothing.
- It is left with `Esc`, the Exit wall mode button, or the browser leaving fullscreen, and each pane returns to
  its state from before.
- Wall mode is not remembered, so a reload comes back out of it.
- After 4 seconds without pointer, touch or key activity the cursor and the wall mode buttons hide (never
  while the pointer is over one), and any activity brings them back.
- `prefers-reduced-motion` removes the transitions.

## Kanban board (#346, `mockup/podium-kanban.html`)

`#/board` (also with a query) is a page of the fleet console: the same top bar, info row, left rail, right
activity panel and legend as the wall, with the board in the middle.

- It is read-only. Nothing on it can be dragged or changed, and the mod sends nothing new.
- It is built from the plan each session already carries ([5.6](../05-mod-api/05-06-what-the-engine-does-and-does-not-tell-you.md)),
  so it needs no endpoint. A session with no task list has no steps (5.6), and plan mode is not read.

**Columns**
- Pending, In progress, Review, Blocked and Done, in that order, each with a count. A step sits in the column
  of its state (`pending`, `active`, `blocked`, `done`).
- Review holds an in-progress step while its session waits on its person (`status` waiting, and not on
  background work). A session that waits on its person with no step in progress (a session with no plan, say)
  gets one card of its own there that opens its page, on All only (#443).
- A Review card says why the session waits, in the words of its card on the wall: "Waiting for your input" or
  "Waiting for your approval" (or "Waiting on you" when the kind is not known). It adds the question it asks
  (the first `question` of an AskUserQuestion note), the tool it wants to use ("Tool: Bash"), or the short
  message it sent. A step moved to Review shows the same text under its own.
- Review is where review logic can be added later, and nothing else moves in.

**Cards**
- A card has three parts, always in this order:
  1. the orchestrator's name with its model-color square as the title (left off in the By orchestrator
     layout, where the lane names it). While Admin > Settings > The wall > **Title cards with the machine** is
     on (#480), the title is `machine | session`, the machine's name, a space, a pipe, a space, then the
     session's name (`Silverbolt | Foobar`), with the pipe in the muted color and a little extra room either side;
  2. the work, which is `activeText` while the step is in progress (the step text when it has none) and the
     step text otherwise, never both;
  3. as the last line, the agent doing it (`ownerLabel`, for example "general-purpose · Sonnet medium") when
     there is one.
- A Review card puts why it waits between the work and the agent.
- The orchestrator's model is not named on a card.
- The card is one link named by what it shows (its orchestrator when the card shows one, its work, its reason and its agent), then its state as one more word, such as "api-refactor Porting endpoints , active" (WCAG 2.5.3, #636). A plain click opens that
  orchestrator's page, exactly as a click on its card on the wall does. A modified click (a new tab) goes to
  the fleet page.

**Which sessions**
- Every session the fleet page shows (the wall's background-session setting applies, the wall's status filter
  and search do not).
- A session with open steps fills the columns, a stale one included.
- A session with no plan, an empty one, or a finished one, and not waiting on its person, is listed in the strip
  described below, with a link to its page. An (i) in the strip opens the note on how to get a plan
  (the task tools, with a link to the Gotcha). The note is not on the page until the (i) is clicked. It opens
  as a popover above the strip, so it does not grow the strip or run into the legend, and Escape closes it.
- The strip is pinned to the bottom of the page, directly above the legend, with 16 px of space from the page
  edges and from the legend, so it reads as a panel and not as part of the legend. It overlays the board and
  does not move as cards come and go, whatever the height of the board. It stays in the page's flow, so the
  board always ends with room as tall as the strip and the last card can be scrolled clear of it; a focused card
  scrolls into view clear of it too. It is at most 200 px tall or 30% of the viewport, whichever is less: past
  that its chips scroll inside it, so it cannot cover most of the board. With no session in the strip nothing
  is pinned. In the stacked narrow layout, where the page scrolls as a whole, the strip is pinned to the bottom
  of the viewport instead, above the legend. It keeps its label and its place in the tab order, after the
  columns.
- In wall mode the columns are as tall as the space between the Board header and the legend, and end at the
  legend's top edge, so they follow the window as it is resized or goes fullscreen. A column with more cards
  than fit scrolls inside itself and the page does not scroll. With the strip showing, the columns end above it,
  which keeps its 16 px of space from the legend (#497).
- A finished session is one whose steps are all done and whose status is stale or done, so its Done cards
  leave the board. A running or waiting session whose steps are all done keeps them.
- When no session has steps the board says "No plans on the board" and the pinned strip lists them all.
- **Plans | All (#426).** A two-state switch right after the Board title, the Board's segmented control
  (`kb-seg`, the one that holds Mixed | By orchestrator), named "Sessions shown". **All** (default) is the page
  above. **Plans** shows only the columns: the strip is not on the page, so no session without a plan is listed.
  The switch changes nothing else: the tiles, the left list and the My orchestrators, Group and layout controls work the same
  in both modes. A no-plan session waiting on its person has a Review card on All only (#443): on Plans every column lists only sessions that have a plan, so a session with no plan or an empty one is in none of them. The
  empty board says "None of the N active sessions has open steps. Switch to All to list them." in Plans and the
  wording above in All. The choice is kept in `podium.board` (`view`: `plans` or `all`).

**Order, paging and layout**
- The step that changed last is first in its column. The rest keep plan order, session by session.
- A column pages at 25 cards with the same footer as the Files and Plan tabs ("Showing 1-25 of N", page
  buttons, "25 per page" when there is one page) at the bottom of the column, and scrolls inside itself.
- Mixed (default) shows every orchestrator's cards in each column with the orchestrator on the card. By
  orchestrator puts a lane label before each orchestrator's cards and drops it from the card.
- The choice and the My orchestrators | Everyone switch are remembered in `localStorage` under `podium.board`.
- A Group dropdown appears once any session has a group.
- **My orchestrators | Everyone (#451)** is a two-state switch in the same segmented control (`kb-seg`), named
  "Whose sessions", after the Group dropdown. **Everyone** (default) shows every session. **My orchestrators** narrows
  the board to the signed-in person's sessions. It appears only while someone is signed in (see People view below);
  with nobody signed in it is not on the page, and a remembered choice falls back to Everyone.
- Each column is at least 210 px wide, so a narrower board scrolls sideways. At 640 px or less it becomes one
  column at a time behind a tab row that keeps the counts.

**Running counts (#409, #426, #450)**
- Eight tiles under the Board header, with the Fleet page's KPI tile styling, in this order: **Orchestrators live**
  (`Kpis.live`), **Orchestrators running** (`Kpis.running`), **Orchestrators waiting** (`Kpis.waiting`),
  **Orchestrators with plans**, **Subagents live** (`Kpis.agentsTotal`), **Subagents running** (`Kpis.agentsRunning`),
  **Subagents waiting** (`Kpis.agentsWaiting`) and **Total cards**. The server derives the `Kpis` figures for the Fleet
  page's KPI strip, so the two pages cannot disagree. The board counts nothing of those itself; each reads "–"
  until the first update.
- Running means: an orchestrator whose status is running, and a subagent whose status is running (forks
  included). Waiting for an orchestrator is as the Fleet page counts it (waiting on its person, not idle on background
  work). Waiting for a subagent means its status is queued (not started yet); an agent has no other waiting status.
  Not counted as running: an orchestrator waiting, idle on background work, stale or ended; a session that
  ends takes its subagents out of the count.
- Captions: Orchestrators live "forks excluded", Subagents live "forks included", Subagents waiting "queued",
  Orchestrators with plans "of N live" (`Kpis.live`), Total cards "N done". The running and waiting tiles of
  orchestrators have no caption.
- The counts are always the whole fleet. Mixed or By orchestrator, Plans | All, the Group dropdown and My orchestrators change
  the cards, never the counts. The tile group is named "Orchestrators and subagents, plans and cards, whole fleet".
  While Group, My orchestrators or the Fleet page's own filters (People, hidden detached sessions) narrow the board,
  every caption reads "whole fleet".
- **Plan figures (#426).** **Orchestrators with plans** counts sessions that have a plan with steps on the board; a
  finished plan and a no-plan session waiting on its person do not count. **Total cards** is every step in those plans,
  done included, and no Review card for a session without a plan. They are worked out from the sessions the page
  received, so nothing new is sent or stored, and neither My orchestrators, Group nor Plans | All changes them.
- The tiles update with the rest of the console and never move the columns below them. They sit four across
  in two rows, and two across at 640 px or less.

**Panels**
- The board keeps its own collapsed flags under `podium.collapsed.board` and opens with the left and right
  panels collapsed to their edge tabs, so the columns get the width. The top bar starts open. The fleet page's
  flags are separate.
- The eight KPI tiles collapse and reopen as one element (#538). Open, a small chevron pill sits on the block's bottom
  edge ("Hide KPI rows"); collapsed, the block is a thin bar the width of the tiles with the open chevron centered
  ("Show KPI rows"). The choice is saved under its own key, `podium.collapsed.board.kpis`, apart from the top bar's
  flags and the fleet page's, and the tiles start open. The control is a button with `aria-expanded` and
  `aria-controls`. Wall mode neither reads nor changes it. There is no shortcut for it.
- Opening the board clears the selected orchestrator. Selecting a session or "All orchestrators" in the rail,
  or a click on an activity event, leaves the board.

**Live updates**
- The board redraws with the rest of the console.
- A card whose step changes column slides to its new place in about 220 ms and flashes for about 2.7 seconds.
  A new step fades in.
- A polite status region ("Board updates") announces the change ("step moved to Done", with "and N more
  changes" when several moved at once).
- With `prefers-reduced-motion` the slide and the fade are dropped and the flash stays.
- Cards of a finished orchestrator leave without a fade.

## Left rail

**Footer.** The bottom left corner of the rail holds a footer, one row each: "Theme credits" and "License"
(links to `docs/THIRD_PARTY_NOTICES.md` and `LICENSE`), a Dev row, the version (`Podium v1.1.0`) and the
copyright line at the very bottom. The Dev row, `Dev: a1b2c3d4` with the commit in the mono font, shows only
when the server is a dev build (6.8, Builds) and is left out of a release. No version row shows when the server
did not give one. It collapses with the rail.

**Rail items.** An "All orchestrators" item and one item per live session: status dot, name, blowout badge,
model chip, plan bar and `done/total`, running/total agents.

- Red left edge when blowout level is 2.
- Follows the current sort.
- Rows enter and leave with the mockup's animations (respect `prefers-reduced-motion`).

**Paging (#242, `mockup/podium-rail-pager.html`).** When the rows would not fit the rail's height, the list shows
one page of rows and a pager. When they fit there is no pager and no scrollbar, and the rail looks as before.

- A page is as many rows as fit the room between the "All orchestrators" item and the footer, measured in the
  browser from the rail's height, a row's height and a band header's height. A tall window holds more rows a page
  than a short one, and a resize re-measures and keeps the reader at the first row they were on. A page always
  holds at least one row, so a window too short for one row scrolls instead.
- The pager is the shared page footer (`PageNav`, the one the Files and Plan tabs use) in its compact form:
  "Showing 1–8 of 24", Previous, "1 of 3", Next. It sits at the bottom of the rail directly above the footer,
  whatever the page's length. Its room (and the line below it) is reserved whether or not that line shows, so a
  page break never moves when the line appears.
- Paging is by rows. With the people view grouped (People or Group), a band that continues onto the next page
  gets its header repeated there, marked "continued", so a page never starts with orphaned rows. A band's count
  and attention mark are the whole band's, not the page's, and the header still narrows the wall.
- A selection on another page stays selected. The pager then carries "Selected: `<name>` is on page N", and N is a
  button that goes to that page. "All orchestrators" is not a row and shows on every page.
- A page change is announced in a visually hidden `role="status"` region ("Page 2 of 3, showing 9 to 16 of 24
  orchestrators"). The pager buttons are real buttons: "Previous page" and "Next page".
- When the list changes the page stays unless it no longer exists, then the last page shows.
- Paging never touches the wall: every card stays on it.
- **Stacked (#474).** At 1040 px and below the panes stack and the page scrolls as a whole, so the rail has no height
  to fit rows into and does not page: it lists every row and shows no pager. Widening past 1040 px while the page is
  open pages again and lands on the page that holds the selection (the first page when nothing is selected).

## Fleet wall (default view)

**KPI tiles**
- Orchestrators live.
- Subagents running (the number running, forks included, and nothing beside it).
- Context blowouts.
- Plan steps done.
- Est. cost today (sparkline).
- Tokens in the last minute (sparkline).

**Toolbar**
- Status segments All / Running / Waiting / Stale / Blowouts.
- A Sort menu (Status, Model, Context blowouts, Context used, Cost, Newest).
- A text filter over name, project and branch.
- "N shown · M cleared today".

**Columns (#145)**
- Cards are never narrower than 360 px and stretch to fill the row.
- The wall holds as many 360 px cards, 12 px apart, as fit in its own width, at most four and never more
  columns than there are cards: four from a 1476 px wall, three from 1104, two from 732, otherwise one. A lone
  card is half the wall when two columns fit and the full width otherwise.
- Rows after the first keep the same column width, so a short last row stays left-aligned (five cards on four
  columns are 4 + 1).
- In the People and Group views every band uses the same columns, worked out from the total cards shown, so
  bands line up.
- The columns are recomputed whenever the wall's width or the number of cards changes. Collapsing or expanding
  a pane or the top bar, dragging a pane, or entering Wall mode can therefore change the columns and the card
  width.
- This applies to the fleet wall only, not History, the agent tree or Admin.

**Session cards (#144, `mockup/podium-card.html`)**

A card has four layers in a fixed order, divided by hairlines, with the content padding unchanged at 12 px.

1. **Who and where.**
   - A state shape, the name, the model chip and the effort meter (see Effort meter below).
   - The owner line in the People view.
   - The project path (one line, shortened from the front when too long, full path as its tooltip) with the
     session id at the right end of the same line (#322).
     - The id is its first eight characters, in the mono face.
     - A click copies the whole id, and the text reads "Copied" for 1.6 s, or "Copy failed" when the
       clipboard refuses.
     - It is a real button that sits beside the card's own button, not inside it (#759), laid over the space the path line keeps for it. It is at least 24 by 24 px, it comes right after the card in the tab order, and a click on it never opens the card.
     - Its accessible name is "Copy session id" and the eight characters, and while it reads "Copied" or "Copy failed" its name is that text.
   - The git line: branch icon, worktree chip or dashed "main checkout" chip, ahead/behind arrows, modified
     count or "clean".
     - The branch is one line ending in an ellipsis when too long, with the full name as its tooltip, and
       never wraps mid-name.
     - Other git chips move to a second line whole when the line is full.
   - Small tags, only when they apply: "nobody attached" and "hides in", "settings hooks", and the reporter
     version warning.
2. **What it is doing.**
   - The plan title, current step (the first pending step when none is active, #179) and progress bar, or "No
     plan reported. Agents were launched ad hoc."
   - The agent strip: a square per agent, filled by model color. A circle is a fork, faded is done, a red
     outline is failed, dashed is queued, blinking is running. It shows its running, done and failed count and
     the tokens-per-second sparkline at its right end.
3. **Cost and health.**
   - Four readouts in fixed columns: Cost, Tokens, Time and Context.
   - Context carries a thin bar and the blowout badge.
   - A session Claude Code compacted on its own (`compactions` above 0) also gets the **Comp pill** after the badge: a compress mark and
     the word Comp, in the delegation blue (`--deleg`), because it is information and not a warning. Its title and screen-reader text read
     "Claude Code compacted this session automatically N times". It stays for the life of the session, since the count is of the stored
     events. The label row wraps, so in the narrow cell the pill drops to its own line instead of being clipped, with or without the
     blowout badge. The orchestrator panel shows it after the Context readout.
   - A level 2 blowout adds the red card edge and turns the context figure red. Its sentence ("Context
     exceeded N× ...") is the Context readout's tooltip and the orchestrator page's callout, not card text.
4. **The status band.**
   - Always the last thing in the card, full width to the card's edges and the same height on every card, so
     cards in a row end on one line.
   - It holds the state shape and one sentence: "Running", "Done", "Waiting for your input." or "Waiting for
     your approval.", "Waiting for 1 background shell to finish." (blue, with the dashed-ring clock shape), or
     the heartbeat-lost line.
   - States that want the person (waiting) or say the session is lost (heartbeat lost) get the heavier tint.
     Running, done and background waits get a light tint. Every band has the same thin top line.
   - A heartbeat-lost card has its Remove button as its own element at the right end of the band, so the
     changing countdown text cannot move it. The band's text keeps clear of it.
   - A countdown under a minute has no space before its unit: "Goes away in 55s."
   - The state shape beside the name is the same shape as in the band, so state is never carried by color
     alone.

Empty states have an instruction, never a blank panel.

## Admin layout (#143, `mockup/podium-admin.html`)

Admin has a grouped side menu on the left that runs the full height and one page at a time on the right. The
menu and the page scroll on their own.

**The menu**
- It is `<nav aria-label="Admin sections">` of buttons, the current one `aria-current="page"`, in four
  groups:
  - People and access: People, Groups, Reporters.
  - Server: Settings, Model prices, Security, Certificates, Data, Stored activity (#432).
  - Reporting (#484): Usage, Spend, People and groups, Sessions, Failures, Admin activity.
  - Activity: Admin log.
- The page that was "Reporting and security" is now **Security** (#484), so two entries do not both say
  "Reporting". Its content is unchanged.
- Each group has a heading (#244, `mockup/podium-admin-menu.html`): a small outline icon, the group's name at
  18 px in the primary ink, and a rule under it, with the groups 24 px apart. The name is 16 px from 761 to
  1280 px of viewport, where the rail is 224 px and 18 px would wrap "People and access". No color is used,
  since color means model and status.
- A list's page shows its count as a badge once it has loaded.
- Lock Admin and "Locks after 10 minutes without activity." sit at the bottom of the menu. Under them is the
  left rail's footer (Theme credits, License, the Dev row for a dev build, the version and the copyright; the
  version and the build come from `GET /api/admin/session`). The footer shows on the lock screen too.
- Below 760 px the menu is a scrolling strip above the page, the group headings show only their icon and a
  hairline sits between groups, the footer moves to the bottom of the page, and tables scroll inside their
  panel.

**Every page is the same stack**
- A header (an H1 and a one-line lead), then sections, each an H2 with an optional one-line help above one
  panel.
- A token shown once sits above the header of whichever page is open until the owner says it is saved.

**People**
- **Create user**: a Name field and a **Create user** button. The token it makes is shown once, and with TLS on
  so is the person's reporter config file (see *The show-once box*).
- **Reporting people**: a **Search people** label with its field to the right, the table, and the pager. A person
  has two credentials, so the table has a **Reporter certificate** cell and a **Console token** cell, each with its
  own badge (shape, word and color) and a note that opens on hover and on keyboard focus. The certificate's note
  gives the date and what happens next; the token's is `pdm_<key id>`, as the Reporters page names it, and no
  page ever shows any of the secret (#218). There is no Status column. The Group select sits under the person's
  name and "created" under Last report (#587).
- **The certificate badge** reads *valid*, *renewal due* (30 days or fewer left, or half the certificate's lifetime when that is shorter, the point where the reporter renews it itself),
  *lapses soon* (the certificate is close to its end and the reporter has not renewed it, so reissue the config in
  time), *expired* (the reporter is refused and cannot renew: reissue the config), *revoked* or *none*. With TLS off the cell says "TLS is off" and the certificate actions
  are disabled.
- **The Actions menu**: each row has one menu, grouped Console token (Rotate token, Revoke token, or Issue new
  token for a revoked token), Reporter certificate (Download certificate, Reissue config…, Revoke certificate) and
  Person (Revoke all…, Delete…). An action that does not apply is disabled, not hidden. Up, Down, Home, End and
  Escape work, and it closes when focus leaves it. Rotate token, Revoke token, Revoke certificate, Revoke all,
  Reissue config and Issue new token each open a warning-bordered confirmation in a full-width row under the
  person that says what will happen; Delete opens the dialog. Revoke token's confirmation says the reporter is
  refused too, since revoking the token revokes the certificate ([7.7](../07-server/07-07-hardening.md), *Revocation*). Issue new
  token's says, while TLS is on and the person's certificate is revoked, that their reporter stays refused until Reissue
  config (#629).
  **Download certificate** gives the public certificate and the CA, never a key.
- **The show-once box** (after Create user, Reissue config or a token rotation) is headed "Token and reporter
  config for `<name>`" (or "Token for `<name>`" when TLS is off). It holds the token settings (`userName`, `token`,
  `serverUrl`), and with TLS on the file `reporter-config-<name>-<epoch>.pem` with **Download reporter config**, the
  two steps (save it in `~/.podium/`; optionally set `PODIUM_REPORTER_CONFIG`) and the note that a running
  session does not pick it up and podium-reporter needs Node.js on the PATH. A reissue shows only the file and a
  rotation only the token. Its buttons are **Copy token settings**, **Download reporter config** and **I have saved
  it**; none is primary, since Create user is the page's primary button. The file cannot be fetched again.

**Groups**
- **Create group**, then **Manage groups**.

<a id="admin-reporting-484"></a>**Reporting (#484, `mockup/podium-admin-reporting.html`)**
- A menu group of seven pages, all Administrator-only like the rest of Admin. Every page is the usual stack: a
  header, then one **Period and filters** section above one **Report** section.
- **Period and filters**: a **Period** choice (Last 7 days, Last 30 days, Last 90 days, This month, Last month,
  Custom with From and To), **By** (Day, Week, Month), and **Person**, **Group** and **Model** where the report has
  them. The default is Last 30 days by day. Under the controls one line states the time zone ("Days are in
  Europe/Berlin time") and what the report is based on and how far back it goes ("Based on daily rollups since
  2026-03-02; today is read live"). The choice is remembered in `localStorage` under `podium.adminReporting`, read
  and written with try/catch.
- **Report**: a summary row of totals, a chart in a neutral ink (never a hue, as on Spend) whose gridlines carry
  value labels and whose axis names the first and last period, the table the chart is
  drawn from, and the pager. **Export** has **CSV** and **JSON**, and **Print** prints the page without the menu.
  An export is exactly the table's `columns` and `rows` for the chosen period and filters ([7.7](../07-server/07-07-hardening.md),
  `GET reports/:report`).
- A period that reaches before the first rollup day says "Podium has no history before 2026-03-02. The figures
  below cover 2026-03-02 to 2026-04-01." A period with no rows says "Nothing was recorded in this period."
  Neither draws zeros.
- The pages:
  - **Usage**: active people, active reporters, sessions started and the peak of sessions live at once, per
    period.
  - **Spend**: total, and by person, group, model or project (**Break down by**), per period. It keeps the
    content of the old Admin > Activity > Spend page: *Spend today, by person* and *by group* as Chart or Table,
    now the first section of this page with its `podium.adminSpend` choices unchanged, above the report. Figures
    are estimated from tokens, not a bill, and a model without a price shows a dash. A session counts on the day it
    was last seen, so a session that runs past midnight is not split. The page has three sections, in this order:
    *Spend today* (with the breakdown below), *Projection* and *Spend over time*.
    - **Breakdown (#482).** A row in *Spend today, by person* is a button (Enter and Space work). It opens the
      person's breakdown under the list, with a **Close** button, and focus moves to its heading. The breakdown
      is of the same "since midnight" figure as the row, cut three ways, each adding up to the row:
      - *By session*: each session that spent something today, with its name, model, the share it spent today and
        a link to it in History.
      - *By model*: each model's share of today's spend.
      - *Orchestrator and agents*: the session's own loop against the agents it launched. A session's today share is
        split in the same proportion as its whole cost (the agents' `cost_usd_est` against the rest).
      - The amounts use the same estimate and prices as the table. A part on a model with no price shows a dash
        and is left out of the sum, and a line under the breakdown counts those sessions ("plus 2 sessions on
        models without a price"), so the priced parts still add up to what the row shows.
      - On *by group*, a group row opens the same panel with a **By person** cut first (its members and their
        shares), and a click on a member opens that person's breakdown. A row for sessions with no owner opens the
        panel with only the by-session and by-model cuts.
      - It reads `GET reports/spend/today/:owner` (the live sessions, as the table does; `owner` is the name,
        `Admin`, or `-` for no owner). The people in it are drawn as text.
    - **Projection (#483).** A forecast of spend over a horizon ahead, from the rollups.
      - **Horizon**: *Rest of this month* (default) or *Next 30 days*. **Window**: the trailing 7, 14 (default)
        or 30 complete days the run rate is taken over. Today is not in the window.
      - Method: the **run rate** is the window's priced spend divided by its days. *Rest of this month* is the
        month's spend so far, today included, plus the run rate for each day left after today. *Next 30 days* is
        30 times the run rate. It does not allow for weekdays, a trend or a price change.
      - Shown: the projected total, and beside it the window ("14 days, 2026-10-06 to 2026-10-19"), the run rate
        per day, and the assumptions in one line ("Straight run rate. Models without a price are left out.
        Not a budget."). Per person or group when **Group by** says so, each with its own run rate.
      - With fewer than 7 complete days of history in the window (the server has less, or a person has been
        active on fewer than 3 of them), it shows "Not enough history to project. Podium has N days so far" in
        place of the number, never a guess. A person under that rule is listed with a dash.
      - Models without a price are left out and the projection says how many sessions that was in the window.
      - It reads `GET reports/spend/projection?horizon=&window=&by=person|group`, which returns the same
        `columns` and `rows` as any report, so CSV and JSON export work. Because the rollups hold the history,
        no extra history is recorded for it.
  - **People and groups**: how many people, groups and reporters there are; who reported in the period; who has
    not reported (quiet for the period, or never); the reporter versions and engine versions in use.
  - **Sessions**: counts by outcome, model, effort and plan; average and longest duration; agents launched per
    session; and how many sessions hit a context blowout and how full the window got.
  - **Failures**: counts by failure class and tool, over time and by person, each class row linking to History
    filtered to those sessions while they are within the 30 days History keeps. It is the root-cause report.
  - **Admin activity**: the Admin log filtered by kind and period, read from `admin_log` (90 days).
- Names are untrusted text, drawn as text nodes. A CSV cell is neutralized as in [7.7](../07-server/07-07-hardening.md).

**Data and Stored activity (#432, `mockup/podium-activity-history.html`)**
- **Data** (it was Data kept under Reporting, #484, and moved to the Server group because it now holds a setting
  and deletes, while a report only reads). Sections: *Daily rollups* (each table, its rows, its oldest day, how long
  it is kept; the text says a rollup holds counts, tokens, cost and names, and no prompts or tool input), *Detail
  rows* (samples, events and ended sessions, the Admin log, and Activity history, each with how long it is kept,
  and a line saying the first four are set with `RETAIN_*` environment variables (`RETAIN_SAMPLES_MS`, `RETAIN_EVENTS_MS`,
  `RETAIN_SESSIONS_MS`, `RETAIN_ADMIN_LOG_MS`) and cannot be changed here),
  and *Activity history*.
- *Activity history* is one form of Settings-style rows, each the full width of its panel. A select picks the
  policy (Not stored, Purge after a set time, Purge when the session ends, Keep everything). *Purge after* adds a
  row for the number and unit, and any keep policy adds a row for the optional size cap and a warning bar (the
  warning color, `role="note"`) that says every reporter will send more, the server will store more, and that only
  the session's owner and the Admin can read it. A line under the form shows the last purge, and the stored total.
  Without a server token the keep choices are disabled with a line saying a token is needed.
- **Save** is the page's one primary button. A save that would remove stored entries (a shorter time, purge when
  the session ends) or stop capturing first asks, in the warning-bordered confirmation box: it names how many
  entries and how much space will go, and offers a button for each answer. Returning to Not stored offers *Stop
  and delete N entries*, *Stop, keep what is stored* and *Cancel*. The count comes from the preview route.
  Saving is written to the Admin log.
- **Stored activity** shows the totals (entries, size on disk, sessions, how many match), the filters (session,
  loop, project, owner, older than, entries from and to, source), a table of sessions with a tick box (name and
  project, owner, state as shape plus word, entries, size, oldest entry) and the pager. A selection bar offers
  *Delete N…* for the ticked sessions, *Delete all N that match…* (only with a filter set) and *Delete
  everything…*. Each opens the confirmation box naming the entries and size that will go, and for a running
  session says it keeps being captured while the policy keeps history. After a delete a line says how many entries
  went, how much space was freed, and that the Admin log has it. Source has two choices: Activity and, since #353, Recordings (its rows are sessions with a recording, sized in bytes of
  text, and *Delete* on them is the recording's delete).
- Nothing here shows entry text. Reading stored text is in the Activity window ([8.1](08-01-what-the-ui-must-do.md)).

**Spend (#239, `mockup/podium-admin-spend.html`)**
- Since #484 this page is Reporting > Spend, not Activity > Spend. Its content below is unchanged except that a
  row is now a button that opens a breakdown (#482), and the projection (#483) and the over-time report sit
  below it (see *Reporting*).
- The page's first section, **Spend today, by person** (or **by group**), whose lead says it is estimated from tokens, not a
  bill.
- Its panel has a toolbar with **Group by** (People, Groups) and **Show as** (Chart, Table) and, at the right
  of that row, the total spent and the live session count. Then the list, then the pager with its usual sizes.
- The list is largest first and counts what was spent since midnight on the server, live or ended sessions
  (the same rule as "Est. cost today"). A person whose sessions ended today still has a row but no band on the
  wall.
- A chart row is a monogram, the name, the person's group, a bar in a neutral ink (never a hue: hues mean model
  and status), the amount and the share.
- The table has person (or group), group, live, spend and share, and a Total row.
- The total, the live count and the Total row cover everyone, whatever page or page size is showing.
- The numbers are the fleet stream's (`kpis.costTodayByOwner` and the live sessions) paged in the browser. The
  page's Group by, Show as and rows per page are remembered in `localStorage` under `podium.adminSpend`, read
  and written with try/catch.
- Only an Administrator opens Admin, but the same numbers are in the fleet stream, so this is a place for the
  view, not access control.

**Rules for every Admin page**
- Names are untrusted text and drawn as text nodes.
- Every search is a label with its field to its right, alone in the table's toolbar. Every list ends in the
  pager (range, Rows per page, Previous, Next).
- Every on/off setting is a switch row: name, id when it has one, a one-line description and On/Off.
- Buttons are 30 px tall and 26 px in a table row. A panel has at most one primary button. A confirmation is
  inline in the row. An error says what failed.
- Spacing steps are 4, 8, 12, 16, 24 and 32 px.
- The theme picker stays in the info row under the top bar.

## Feature flags (#118, `mockup/podium-feature-flags.html`)

Admin > Settings starts with a "Feature flags" group, above the wall notices, with the hint "Turn a feature off
for everyone on this server. A flag that is off hides the feature in the console and stops its data. New
features that can be switched off appear here."

- It has one switch row per flag, in the same style as a notice's row: the flag's name, its id in mono beside
  the name, a one-line description and On/Off.
- The flags are:
  - **Agent activity feed** (`activity-feed`): "Shows an agent's recent tool calls and text in its panel while
    someone watches. Needs the reporter's activityFeed option on the machine as well. Nothing is kept after
    the panel closes unless the Admin chooses to keep activity in Admin > Server > Data. Off, nothing is captured
    or kept."
  - **Bash output in the activity feed** (`activity-output`, #431, `mockup/podium-feed-expand-admin.html`): "Lets a
    person open a Bash row in the Activity feed to see what the command printed and how it exited. Needs the Agent
    activity feed on, and the reporter's activityOutput option on the machine as well. Output is held in memory while
    the panel is open and is never stored. Off, no output is captured or sent." It sits under Agent activity feed.
    With a warning bar (`role="note"`) under it while it is on: "Output holds whatever a command printed: file
    contents, environment dumps and tokens the redactor does not know. Podium hides the secrets it recognizes, but it
    cannot promise to catch all of them. Anyone who can open the Activity panel of a session can read its output
    while the panel is open." Off by default.
  - **Respond from Podium** (`respond`, #206, [7.7](../07-server/07-07-hardening.md)).
  - **File diff** (`file-diff`, #319): "Lets the owner of a session, and only the owner, open a changed file's diff in
    the console. The diff is source code, read from the machine while the owner has the session's page open (or only when
    asked, where the reporter's fileDiffPreload is off) and never stored by the server. Needs the reporter's fileDiff
    option on the machine as well."
  - **Orchestrator messaging** (`peer-messaging`, #347, [7.7](../07-server/07-07-hardening.md#orchestrator-messaging-347)): "Lets a person's
    orchestrators find and message each other, on the machines they choose, through this server. Only between one
    person's own reporters. Each machine must also turn it on in podium-reporter, and the owner gives each pair the
    right on My reporters."
  - **Session recording** (`session-recording`, #353, [7.7](../07-server/07-07-hardening.md#session-recording-353),
    `mockup/podium-recording.html`): "Lets a session's owner, or an Admin, record everything an orchestrator and its
    agents do, so a run can be replayed to see what happened and why. Needs sign-in on the server. Off by default."
    With a warning bar (`role="note"`) under it: "A recording holds whole prompts, file contents, command output and
    tool results. Secrets are removed on the machine before it is sent, but that is best effort. A session is
    recorded only when its owner has allowed it in the reporter and someone has chosen it. Only the owner and an
    Admin can read a recording." The row is unavailable, with a line saying a token is needed, when the server has no
    `PODIUM_TOKEN`.
  - **Release check** (`update-check`, #499, [6.8](../06-reporter-protocol/06-08-version-compatibility.md#the-release-check-499-mockuppodium-update-noticehtml-mockuppodium-update-check-adminhtml),
    `mockup/podium-update-check-admin.html`): "Asks GitHub once a day for the latest Podium release and says at the
    bottom of the wall when a newer one is out. Off, this server makes no request to GitHub." It is the last row.
- Flags default to on, except `respond`, `file-diff`, `peer-messaging`, `session-recording` and `activity-output`, which are off by default.
- They live in the server's `settings` table (`feature.<id>`), apply to every browser, survive a restart, and
  each change is written to the admin log (`feature_changed`).
- The console gets them in `StateBody.features` and a change as a fresh snapshot.
- A later flag adds one entry to `FEATURES` in `server/src/storage/sqlite/featureFlags.ts`.
- What turning the activity feed off does is under *Right panel* below and in
  [6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md).

## Responding (#206, `mockup/podium-respond.html`)

The mockup is the specification: every string, frame and placement in it is literal, and this section is only
a map of it.

**Respond button**
- **Respond** sits at the right end of the amber waiting band, on the fleet card and on the orchestrator
  page's status band, with the reply icon and, for a question, the number of questions in the ask.
- It shows only while the session waits on its person with an open ask whose kind the session accepts (or,
  idle, with `message` in `accepts`), and only while `features.respond` and `features["activity-feed"]` are on
  and `GET /respond/me` says `enabled` (a token is set and a feature that needs the sign-in is on; the flags
  above are what make it mean responding).
- It is never on a blue band (waiting on background work).
- It is gone when responding is off and when the reporter can't answer (`respond` null, or the ask's kind
  removed by `limits`).
- Signed out (with `enabled` true), it is live on every waiting card, since Podium doesn't know whose sessions are yours;
  it leads to the sign-in form.
- Signed in, on a session that is neither yours nor answerable as an Admin, it is dimmed, with "`<Owner>`'s
  session" beside it and the tooltip "Only `<Owner>`, who owns this session, or an Admin can respond."
- The card's own click target is unchanged.

**The modal**
- It opens the existing Activity modal (#118) on the orchestrator's main loop. The modal gains the answer
  panel between the feed and the message box, and the message box at the bottom.
- Expand on the orchestrator's Activity panel opens the same modal, so a message can be sent while the session
  runs.
- The panel's content comes from `GET /respond/sessions/:id/asks/:askId` and is fetched again whenever the
  session's `asks[].state` changes.
- Section 3 of the mockup has every case, grouped as signing in, a question, plan approval, a tool permission,
  its turn ended, and when Podium can't send the answer.

**Signing in**
- Signed out, Respond opens the modal with the feed and the sign-in form (Name, Token, Sign in) in the answer
  panel, and no message box.
- The top bar's far end, after a divider that follows History, Traffic, the wall mode button and Admin,
  has **Sign in** (shown only while `GET /respond/me` says `enabled`), which opens a small Sign in dialog with the same form. Signed in, that spot shows "Signed in
  as `<name>`" and **Sign out**.
- These go after the spacer, at the end of the bar, so the controls before them don't move. Nothing is added
  next to the connection pill.
- A wrong pair, an empty field, the lockout and a sign-in that ended show the mockup's messages.
- The page never keeps the token.

**The feed**
- An answer, message or command sent from Podium is a feed entry: "You, from Podium:" for the signed-in
  person's own, "`<Name>`, from Podium:" (for example "Alex, from Podium:") for someone else's, with the
  mockup's notes, such as "(queued until the session is idle)".
- The server adds these entries to the loop's in-memory feed ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md)) when it
  takes the delivery and updates them when the mod reports its result. They follow the feed's lease rules and
  are never stored.

**Settings**
- Admin > Settings > Feature flags has the **Respond from Podium** row ([7.7](../07-server/07-07-hardening.md)), off by default.

## Session recording (#353, `mockup/podium-recording.html`)

The mockup is the specification: every string, frame and placement in it is literal, and this section is only a map
of it. It is built from the components on `development` (the mockup's notes say which are new), and a new component
becomes a standard in the release-prep PR, not in the feature PR.

**Admin**
- **Settings > Feature flags > Session recording** (`session-recording`) with its warning bar ([8.1](#feature-flags-118-mockuppodium-feature-flagshtml)
  lists the others). Unavailable, with a line saying a token is needed, when the server has none.
- **Settings > Session recording** holds the form of the three limits: *Keep a recording for* (a number and hours or
  days, 6 hours by default, at most 7 days), *Disk budget* (GB) and *Limit for one session* (MB). Saving is the
  page's primary button and is written to the Admin log; a shorter time removes recordings that are already older,
  and the form says so. A line under it says how many recordings and how much is stored, of the budget. The defaults
  are set from measurement ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md#session-recording-opt-in-353)).
- **Recordings** (a section on the same page) lists every recording, running or kept: the session, who owns it, who
  started it, its state as shape plus word (Recording, Stopped, Limit reached), size, when it goes, and **Stop** or
  **Open replay**, and **Delete**. Stop and Delete ask first in the warning-bordered confirmation box. The state word is
  `.badge.recording` (a filled dot, in the critical color) while it records.
- *Stored activity* lists the same recordings with its Source filter set to Recordings.

**Choosing what to record**
- **Recording** is the last cell of the orchestrator page's facts panel, after Fork, shown to the session's owner and an
  Admin (to everyone else it states the state and has no button). The facts stay twelve cells in two rows of six:
  Machine and System become one cell (`Silverbolt | macOS 26.0`). Not recorded, the cell is a button like Resume and
  Fork: the word **Record** and the record mark. Recorded, it states the state and when it goes.
- The record mark is a ring with a disc inside. The ring is always neutral; the disc is neutral when idle, absent
  when the recording is only kept, and critical and pulsing on the app's shared beat (`data-beat`, still under
  reduced motion) only while it records.
- **Record** opens the modal with the Respond modal's option rows: the orchestrator, its agents and its forks, each
  with a box. Recording is per loop, starts when **Start recording** is pressed, and keeps nothing from before. The
  modal has five states: the owner allows it; just after Start; the owner has not allowed it (nothing to press, and
  the text names the `sessionRecording` option); the feature is off; and a viewer who is not the owner or an Admin.

**The notice cannot be hidden**
- It is not a wall notice. Wall notices are for informational notes that someone may close, and consent is not one:
  there is **no X and no switch**, on the wall or in Admin, and nothing a viewer can do hides it.
- On the wall, a recorded card gets a second band in the critical color with a filled dot, the words "Recording
  everything" or "Recording N of M loops", and who started it and when it goes (`.band.recording`).
- On the orchestrator page, a layer inside the page's surface above its band (`.rec-bar`) says what is kept, who
  started it, which loops are recorded and which are not (in words, not on the agent table), and when it is deleted,
  with **Stop recording**, **Open replay** and **Delete recording** for the owner and an Admin.
- The terminal shows the same text ([5.3](../05-mod-api/05-03-events-the-reporter-hooks.md#session-recording-from-the-reporter-353)).

**Stopped, ended and limit**
- Stopping keeps what was recorded. The page goes to a third state, "Recording stopped", with the same layer in the
  neutral color and a ring in place of the filled dot, and it keeps **Open replay** and **Delete recording**.
  A recording that hit a limit reads the same way with the limit named.
- An ended session shows its final state (the Done band, all agents done) plus that layer. It is reached from
  History, whose row has a line under the name, "recording kept until `<time>`" (shown to the session's owner and to an
  Admin only, from the row's `recording`, [7.1](../07-server/07-01-endpoints.md)), and from Admin's Recordings table.
  Nothing is shown once the recording is deleted or has expired.

**Replay**
- A page of its own, at `#/?open=<id>&replay` (built on #542's address, so it survives a reload; a viewer who may not
  read it sees the refusal at the same address), reached from **Open replay**, with a back link to the orchestrator
  page. Read-only: a replay never runs anything or sends anything to the session.
- It is the Activity feed's rows, oldest first, with the loop's name before each row, and a collapsed result under
  each tool call, the one its `callSeq` names (a stored row carries its own `seq`, so calls that overlap get their own
  results; a result with no `callSeq` goes to the oldest call of the same loop and tool still waiting). A loop filter, a position slider (`.scrub`) and **Jump to next failure** move through it. A failed
  call uses the failure box. A compaction, a clear, a gap, a stop and a limit are marked rows (`.feed li.mark`). A
  prompt, a clear or a compact that came from Podium, and a `decision`, show who sent it as the Activity history marks
  a Podium entry ("You, from Podium" for the signed-in viewer's own, else the name). A `decision` is a row of its own
  right after the call it answers (`callSeq`), reading `Answered a question`, `Approved a plan`, `Sent a plan back`,
  `Allowed a tool once` or `Denied a tool` by `name` and `failed`, with its text; one with `failed` uses the failure
  styling, because it refused something.
- **It loads the newest 200 rows** (`RECORDING_LIMITS.page`) and **Show older** pages back through a long run
  (`GET …/recording?before=`, [7.1](../07-server/07-01-endpoints.md)). The whole result is stored; it is not all loaded at once.
- **Thinking.** The replay says in its header that thinking text is not available, and each place the model thought has
  a Reasoning row that reads "Thinking: text is not available" ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md#session-recording-opt-in-353)).
- States: loading ("Loading…"), a failed load (the error box with Try again), nothing recorded yet, a delete asking
  first, a stopped recording, a recording that reached its limit, and a viewer who is not the owner (the empty-state
  box with a plain refusal). A loop name too long for its row is cut with its full name as a title.
- Confirmations: in Admin, the warning-bordered box with a button for each answer. Everywhere else, the Respond
  modal's confirmation box: a bold question, Cancel, and the critical-colored action button. Stop, Delete and Delete
  this recording all ask first and say what stays and what goes.

## Wall notices (#114, `mockup/podium-wall-notices.html`)

Informational notes about the wall sit in one stack at the bottom of the wall, below the cards, one per row.

- Each has an X (accessible name "Close notice: `<name>`"). Its action link, if it has one, stays in the note.
- Closing a notice turns it off for everyone (`POST /api/fleet/notices/:id/close`) and shows a confirmation,
  bottom right, that names the notice and links to `#/admin/settings`. The confirmation clears itself after
  about 9 seconds and has its own X. It waits while the pointer is over it or focus is inside it, and the 9 seconds
  start again when both have left.
- Errors and connection problems are not notices. They keep their place and have no X, and so does the short
  status message at the top of the main column that clears itself after 6 seconds.
- The switches live in Admin > Settings > Wall notices, one row per notice (name, one-line description,
  On/Off). They are stored in the server's `settings` table and sent to the wall in `StateBody.wall`, so they
  apply to every browser and survive a restart. A change reaches open tabs through the `wall` stream event.
- All notices default to on.
- The notices are the background-sessions note and the update notice. Only the background-sessions note is in
  `NOTICES`; the update notice is handled apart (below). A later notice that has its own switch adds one entry to
  `NOTICES` in `server/src/storage/sqlite/wallSettings.ts` and one to the stack in `Wall.tsx`.
- **The update notice (#499, `mockup/podium-update-notice.html`)** is the one notice that is not in `NOTICES`. It reads
  `Podium 0.15.0 is available`, in a green pill (`pill good`), then `You are running 0.14.3.` and a **Release notes**
  link that opens the release in a new tab. It shows only while `StateBody.wall.update` is set
  ([6.8](../06-reporter-protocol/06-08-version-compatibility.md#the-release-check-499-mockuppodium-update-noticehtml-mockuppodium-update-check-adminhtml)).
  - Its X is "Close notice: Update available". It hides the release the notice names, for everyone
    (`POST /api/fleet/update-notice/close`), not the notice: a newer release shows it again. The confirmation is titled
    **Notice dismissed**, says `“Update available” will show again when a release newer than 0.15.0 comes out`, and
    links to Admin > Settings as the others do.
  - Its switch is the **Release check** flag under Feature flags, because turning the notice off for good means
    stopping the check. It has no row under Wall notices.
- Whether background sessions are shown is a separate server setting (`StateBody.wall.showBackgroundSessions`,
  off by default), switched in Admin > Settings > The wall or by the note's Show them / Hide them link, so
  turning the note off never removes the way to show them.
- Whether a card is titled with its machine is a third setting (`StateBody.wall.cardTitleMachine`, #480), switched
  in Admin > Settings > The wall (**Title cards with the machine**), off by default, for everyone on this server and
  without a restart: the change reaches open tabs through the `wall` stream event. Off, a card's title is the
  session's name alone, as before. On, it is `machine | session` (`Silverbolt | Foobar`), on the wall's cards only;
  the rail, the Board, the orchestrator page and History keep the session's name. The fallback: a session with no
  machine name (a reporter with no `userName`, or older than 0.9.0) is titled with its session name alone, and a
  session with no name with its machine's name alone, so a title is never empty and never has a lone pipe. The
  change is written to the Admin log (`wall_card_title_changed`). An older server's `wall` with no
  `cardTitleMachine` reads as off.

## Model prices (#117, `mockup/podium-model-prices.html`)

Admin > Model prices is its own page since #143 (under Server, after Settings).

- A sentence says the figures are US dollars per million tokens, that changing one changes today's cost
  everywhere at once, and the date of the built-in sheet.
- One table: a row per model (the built-in rows in the sheet's order, then the models the Admin added), with
  five price columns: Input, Output, Cache read, Cache write 5 min, Cache write 1 hour.
- Haiku 5.5 is two peer rows, both named `Haiku 5.5` with the prompt size under the name (`Prompts up to
  100,000 tokens`, `Prompts over 100,000 tokens`), joined by a dashed divider while a full divider separates
  models.
- Each price is a text box with a number keyboard and an accessible name such as
  `Sonnet 5.5 cache write 1 hour`.
- A box whose value differs from the saved one has an accent border, and the row shows Cancel and Save (a row
  with no unsaved edit shows nothing).
- A saved row that differs from the built-in price shows a Changed tag, a note with the built-in input price
  and a Reset to built-in button. An Admin-added model shows an Added by you tag and a Remove button.
- A value that is empty, not a number, negative or over 1000 is refused on the row with a message that names
  the price (`Output must be zero or more.`), the box is marked `aria-invalid`, and nothing is sent. A refusal
  from the server is shown the same way.
- Above the table, an **Add a model** section with a **Model id** field and an **Add model** button adds a row
  with empty boxes (all five must be filled before Save), and refuses an id already in the table.
- A saved change reaches every open browser as a fresh snapshot.

## People view (#34, `mockup/podium-people.html`; the controls row #245, `mockup/podium-wall-controls.html`)

It appears once any live session's `owner` is a person (not `Admin`, not null). Until then the wall, the rail
and the right panel are exactly as above.

**Controls row**
- The wall's one control row, the same row as the status filter, Sort by and the text filter, gains an
  outlined **People** cluster (#245): **Group by** (People, Group, All, and Me while a person is signed in) and
  **Order by** (Needs attention, Spend, Name; hidden for All and Me).
- Order by orders the bands and Sort by, beside the filter, orders the cards inside each band. Their tooltips
  say so.
- The row gives way in a fixed order as the wall narrows, measured on the toolbar's own width and never hiding
  a control:
  - below about 1470 px, the caption "N shown · M cleared today" becomes an info icon whose tooltip and
    `aria-label` carry the same words;
  - below about 1300 px, the cluster takes its own line under the filter row, so the row is never more than
    two lines;
  - below about 651 px, the buttons and the Sort by menu tighten;
  - below about 635 px, the cluster's "People" label is dropped;
  - below about 599 px, the text filter gives a little more.
- With the people view off, the row is the plain toolbar and keeps its caption in words.

**Group by modes**
- People are derived from live sessions only: a person whose sessions all leave has no band.
- *People*: one band per owner, keyed by the name, so one person on two machines is one band.
  - A band header is a button that collapses the band to its header (`aria-expanded`, "N hidden").
  - It shows a monogram (one or two initials in a neutral circle; a person never gets a color, because color
    means model and status), the name, a "you" tag for the viewer, the person's group as a chip, the machines
    the person's live sessions run on, "N live", the waiting and stale counts in amber, and the person's share
    of today's estimated spend (`kpis.costTodayByOwner` against `kpis.costToday`) as an amount, a percentage
    and a neutral bar.
  - Sessions reported with the admin secret are the **Admin** band and sessions with no owner the
    **Unassigned** band, always after the people.
  - Each card in a person's band gets a line with its machine (`machine.name`, plus the first four characters
    of `machine.id` when one person has two machines with the same name).
- *Group*: one band per group from Admin holding every member's orchestrators, each card naming its owner.
  - A group with no live session has no band.
  - People with no group, Admin and Unassigned are under **No group**, last.
  - The viewer's group is marked "your group".
- *All*: the flat wall, each card naming its owner (called None before #245).
- *Me*: offered only while a person is signed in to the console ([7.7](../07-server/07-07-hardening.md); `GET /respond/me` with a
  name that is not `Admin`). A flat wall of only that person's orchestrators, each card naming its machine but
  not its owner, ordered by Sort by. A remembered Me with nobody signed in falls back to People until someone
  signs in.
- Cards inside a band follow the Sort menu and the status and text filters, and a band with nothing left to
  show is hidden.

**Order by**
- *Needs attention* puts the signed-in viewer's band first, then the most waiting plus stale, then the most
  spend.
- *Spend* is most spend first.
- *Name* is alphabetical.

**Rail and right panel**
- The left rail groups the same way. A header per band (monogram, name, you tag, attention count, orchestrator
  count) is a toggle that narrows the wall and the rail to that person or group, and **All orchestrators**
  undoes it. The wall's control row no longer repeats that with a "Showing X" line.
- For Group, All and Me each rail row carries the owner's monogram.
- The right panel on the wall is the activity list alone. Spend by person or group is on Admin > Spend
  (#239, above).

**Remembered state and "me"**
- Group by, Order by and the collapsed bands are remembered in `localStorage` under `podium.people`, read and
  written with try/catch.
- Who "me" is comes from the browser's sign-in, the same one Respond uses, so it exists only while the Admin's
  respond and activity-feed flags are on and someone is signed in. Signed out, or signed in as `Admin`, there
  is no Me, no "you" tag and no viewer's band first.
- #245 retired the "You are" picker, "Only me" and the `podium.me` key. A stale `podium.me` is ignored.
- Names and machine names are untrusted text and drawn as text nodes.

## Pinned cards (#496, `mockup/podium-pin-cards.html`)

A person can pin a wall card so it keeps its place until they unpin it. Pinning is on the Fleet wall only: not the
Board, History, Admin or the rail, and there is no dragging a card to a new place.

- Each wall card has a pin button in its first row, just before the model chip. The row keeps an empty 24 px space
  there, so no card text is covered; the button is a sibling of the card's own button, laid over that space. Its name
  is "Pin `<session>` to its place on the wall" and, once pinned, "Unpin `<session>`", with `aria-pressed`. It shows on
  hover and keyboard focus (always on touch screens). A pinned card always shows it, filled, and has a stronger
  border, so pinned is not shown by color alone. Any number of cards can be pinned.
- A pin holds a slot: the card's place in reading order (first, second, third...) in its wall, or in its band
  while Group by makes bands. The slot is the card's position when it was pinned. The card holds that slot while
  statuses, costs, activity and the sort order change and while other cards appear, leave or re-order; the unpinned
  cards fill the other slots in the usual order. Unpinning returns the card to the usual order.
- Two pinned cards never share a slot: a later pin that would take a taken slot goes to the next free one. A slot
  past the last card means last, and the card returns to its slot as more cards arrive.
- A slot is a place in the flow, not a row and column, so a change in the number of columns (a window resize, a pane
  moving) leaves it reading in the same order, left to right and top to bottom.
- A pinned card the filter hides, or that Group by "Me" leaves out, is not drawn and leaves no gap: the other cards
  close up, and it returns to its slot when it is shown again. Its pin is kept. Changing Group by changes the
  band, so the card keeps the slot number it was pinned at in whatever band it falls in.
- A pin for a session that ended or was removed is dropped once the fleet is loaded, so no stale pin remains and
  a session that comes back is not pinned.
- Pins are remembered per browser in `localStorage` under `podium.pins` as a list of `{ id, slot }` (at most 200),
  read and written with try/catch. They are not per person and the server does not know about them. Anything
  unreadable is ignored.

## Reporters page (#142, `mockup/podium-reporters.html`)

Admin > Reporters, under People and access after Groups, with the number of reporters as its badge. Admin only,
like the rest of Admin.

**The list**
- A strip of five buttons (**All reporters**, **Reporting**, **Idle**, **Silent**, **Not since restart**),
  each with its count from `counts` and a tooltip with the state's definition, filters the list
  (`aria-pressed`).
  - A row's own state is a focusable element whose tooltip adds when the reporter was last heard and, for Not
    since restart, when the server started and that the server cannot tell whether the reporter still runs.
  - "no name set" under an unnamed reporter's name explains the same way and is also in the detail.
- Under it, a **Search reporters** label with its field to the right, which searches machine, person, address,
  machine id and version after a 250 ms pause.
- When any reporter uses the admin secret, a warning band under the strip says how many and has **Show only
  these** (**Show all reporters** to undo; `aria-pressed`).
- The table columns:
  - State.
  - Machine (with its machine id, or "no machine id, matched by address ...").
  - Person ("Admin" for the admin secret).
  - Token: the token's key id, or an **Admin secret** badge with a warning icon, in the warning color and with
    a focusable tooltip that says what is wrong and to make a token for the person in Admin > People.
  - Reporter version: a warning with "outdated" or "newer" beside a version outside the supported range, "no
    mod" for the settings hooks.
  - Last report ("3 h ago", counted from the server's `serverTime`).
  - Sessions (with "N live").
- The headers sort (`aria-sort`). The table is paged like the other Admin lists.
- There is no note under the table. What Silent and Not since restart mean is the tooltip on the state chip and
  on the strip button:
  - "Silent means the server has not heard from this reporter for a while. It does not mean the reporter is
    turned off: Podium can only see what arrives."
  - "Not since restart is what every reporter reads after this server restarts, until it reports again. Most
    rows show it for a short while after a restart; it does not mean they stopped."
- How an unnamed reporter is named and matched is the tooltip on "no name set" (#181).
- The list and an open detail ask the server again every 10 seconds while the page is visible, so a reporter
  that stops moves to Silent without a reload.

**Removing reporters**
- Each row has a checkbox, and the header box selects the page. When more rows match than fit, a line offers
  **Select all N that match** (sent as `match`, so it reaches past one page).
- A bar above the table, always there so the rows do not move, reads "Tick reporters to remove many at once."
  until a row is ticked, then shows **N selected**, **Remove N…** and **Clear selection**.
- Removing asks "Remove N reporters from the list? They come back if they report again, unless ignored. Their
  sessions are not touched." with **Remove N reporters** and **Keep them**.
- With a state chosen, **Remove all `<state>` (N)** beside the search asks the same.
- **Remove from list** has a tooltip that says what it does and does not do: it takes the row away and nothing
  else, the sessions stay, and the reporter comes back the next time it reports (#181).

**Ignore rules**
- **Ignore rules** is its own section after the reporters section (a heading, a help line and its own panel,
  like the other Admin pages).
- It lists each rule (what it matches, the pattern, when added) with **Remove rule**, says a matching reporter
  is refused and its sessions stop appearing until the rule is removed, and has a form (**Rule matches**,
  **Pattern**, **Ignore matching reporters**).
- A reporter's detail has **Ignore…**, which sits at the right of the header beside **Remove from list** (the
  name and state stay on the left; #247). Its label ends in an ellipsis because it opens a choice before
  anything happens, and its tooltip says so. It offers this reporter only, everything from its address, or
  every reporter on its version, and says its reports are turned away.
- Admin > Settings has **Forget old reporters** (off by default) with a **Days** box (30 by default).

**Detail**
- Selecting a row opens its detail in place with an **All reporters** link.
- The header has the name, state and **Remove from list**, which asks "Remove X from the list? It comes back if
  it reports again. Its sessions are not touched." with **Remove reporter** and **Keep it**.
- For a reporter on the admin secret, a warning callout, **This reporter is using the admin secret**, gives the
  three steps to fix it: make a person in Admin > People, run `/plugin configure podium-reporter`, enter
  `token` and `userName`.
- **Reporter** shows version, compatibility, Claude Code version, first seen, last report, and sessions seen
  (with a tooltip).
- **Where it comes from** shows machine, machine id, source address, person, and token as `pdm_<key id>` or
  "admin secret" (with a tooltip saying the secret is never shown).
- Below the details, **Recent sessions** and **Reports the server turned away** are each their own section with
  a title, a help line and a panel, like the other Admin pages (#188).
  - Recent sessions has the shared pager (**Rows per page** 25, 50 or 100, 50 by default, **Previous**,
    **Next**), so every session the server still holds for the reporter can be reached.
  - The turned-away list is not paged, since the server keeps at most 20 per reporter.
- Explanations sit in tooltips (`title`), shown with a dotted underline.
- A reporter removed while its detail is open shows "That reporter is no longer on the list."
- Machine names, addresses and refusal reasons are untrusted text and drawn as text nodes.

## My reporters page (#347, `mockup/podium-my-reporters.html`)

Built (#415). A console page, `#/me/reporters`, for a signed-in person. The rules are in
[7.7](../07-server/07-07-hardening.md#orchestrator-messaging-347).

- The top bar reads *Signed in as Ed*, then **My reporters · N waiting**, then **Sign out**, with 16 px between the
  name and the button (approved on #347). **My reporters** shows once a person (not the admin secret) is signed in
  with messaging on, and "· N waiting" only while N is above 0: plain **My reporters** at 0 and before the first
  read. On the My reporters page the link is left off, since the pill names it. The page and the count
  share one read, every 10 seconds on the page and every 30 seconds elsewhere.
- The page mirrors Admin > Reporters for the person's own reporters only, in the Admin page layout under the top
  bar:
  - **Waiting for you**: one consent box (`.confirm`) per request, naming who asked and what changes, with a
    button per answer. An orchestrator's reason and a message waiting for approval are quoted as text. An Admin's
    proposal is matched to its Grid cell and Board card by reporter key, not by machine name, and says what the
    pair has today. An orchestrator's request says what allowing gives, or that it changes nothing when the pair
    already has as much, since allowing never lowers a right.
  - **Your reporters**: state, machine, system, Messaging (On, or Off on the machine, with how to turn it on
    there in words), version, last report, live orchestrators. State uses Admin > Reporters' badge, words and note
    (Reporting, Idle, Silent, Not since restart) from the server's `state`, and Last report is `lastSeenAt` counted
    from the server's `serverTime`. Version is drawn as on Admin > Reporters from the server's `compat`, so an
    outdated reporter is flagged whether or not it has a live session.
  - **Defaults**: Trust my own reporters (a switch), When an orchestrator asks for access (Ask me, Allow,
    Decline), A new right to send starts as (With approval, Without approval), and the owner's stricter limits
    (#436, [7.7](../07-server/07-07-hardening.md#orchestrator-messaging-347)): round trips, messages per minute and longest message, one
    `PeerLimits` row each.
    - A box shows the limit that applies, and its most is the Admin's value. A line says whose value it is.
    - **Use the Admin's limit**, or typing exactly the Admin's value, sends `null`.
    - A value above the Admin's, below 1, not a whole number, or an empty box is refused in its row and nothing is
      saved.
    - When the Admin later goes below the owner's value, the owner's is kept and the row says the Admin's applies.
    - It saves through `PUT /api/fleet/respond/peers/defaults`.
  - **Who can message whom**, with a **Grid | Board** switch that the browser remembers:
    - Grid: rows send, columns receive, and every cell is a select labeled "A to B". The diagonal is between
      orchestrators on the same machine. A cell with messaging off says why.
    - Board: one reporter's peers as cards in four columns (No access, Can see, Can send with approval, Can
      send). Dragging is never the only way: each card has a Move to list. Each card also says what that
      reporter can do back.
    - Giving A the right to send to B asks at once whether B can answer.
- Every level is an icon and a word, the same everywhere: No access, Can see, Can send, with approval, Can send.
  No hue carries the meaning.
- The Admin's view (#416) is the Messaging section on Admin > Reporters > a reporter, in the Admin shell, with the
  same Grid | Board switch. It shows every pair of the owner's reporters, from one read.
  - A change is sent as a proposal and shows as Proposed, waiting for the owner, until the owner accepts it. Only
    more than a pair has can be proposed: No access, today's level, or a level below it are not offered (the server
    refuses them too), since taking a right away is the owner's choice.
  - A `.warnbar` says a change is sent to the owner to accept, and a second one says when the owner's Trust my own
    reporters locks the choices.
  - **Pause all links** in the detail's header applies at once and **Resume all links** undoes it.
  - The details add System and Messaging (On, Paused, Off on the machine, Reporter can't message: update it, or
    Cannot take part).
  - A reporter on the admin secret, with no owner, with messaging off on the machine, or too old to message says so
    in an empty block and offers no choices. With the flag off, Admin shows none of this.
- Empty: "No reporters yet", and how a machine gets here. Not signed in, the admin secret and messaging off each
  get their own empty block too.
- A change shows at once and keeps focus where it was. If saving fails, the page says "Could not save the change:
  … Nothing changed. Try again." and takes back only that change; a newer change still saving stays shown.
- **Panels (#446).** The page sits between the left rail and the Activity panel, as the Board does, and keeps the rail's
  footer (see Left rail) in the bottom left corner.
  - It keeps its own collapsed flags under `podium.collapsed.reporters`, apart from `podium.collapsed` and
    `podium.collapsed.board`, and opens with both side panels collapsed to their edge tabs. The top bar starts open.
    They open and close with the console's animation, which `prefers-reduced-motion` removes, and stack below 1040 px
    as on the wall: rail, page, Activity panel.
  - The rail and the Activity panel show the whole fleet, as the wall does. `GET /api/fleet/stream` sends every viewer
    the same fleet, so they show no orchestrator that the wall would not.
  - Opening the page clears the selected orchestrator, as opening the Board does, so the rail marks "All
    orchestrators". Selecting a session or "All orchestrators" in the rail, or a click on an activity event, leaves My
    reporters for the console, as it does from the Board.
  - The console's own messages, such as a failed Remove in the rail, show at the top of the page in the wall's
    `.callout.notice`.
  - Unlike the Board it has no legend (approved on #446), no KPI tiles and no Wall mode button. With Shortcuts on, `[` and `]` open and
    close the panels and `\` the top bar; `w` does nothing, and Esc only leaves a wall left on from the fleet.

## Traffic page (#347, `mockup/podium-traffic.html`)

Built (#417). A console page, `#/traffic`, reached from **Traffic** in the top bar after History while the flag is
on (left off the bar on the Traffic page itself). It draws no rail, side panel or wall, so it offers no Wall mode button, and `[`, `]` and `w` do nothing there; `\`
still hides and shows the top bar.

- **Who is talking**: a map (inline SVG) of the orchestrators in the open read, grouped in a box per machine with its
  OS (from the owner's reporters when signed in, else from a live session on that machine, drawn or not; "System not
  reported" only when none says), the busiest machine first and then by name, so nothing moves as messages arrive. A
  node shows the app's status shape and its state as a word ("ended" once it is no longer live). A line joins two
  orchestrators that have messaged each other:
  - solid while active, dashed in the warning color while a message waits for approval, dotted and muted while
    paused; the label has the message count, and for waiting or paused also an icon and the word. A paused link where
    a message also waits for approval keeps the waiting line and icon, and its label reads "N messages, waiting,
    paused", its accessible name starts with the same words, then ", a message needs approval";
  - an active link where neither side can send (both `aToB` and `bToA` false, as after Remove link) keeps the solid
    line, and its label adds No access's struck circle and "no right to send"; the line's accessible name ends
    ", no right to send". The browser works this out from `aToB` and `bToA`; the server's `state` stays `active`;
  - an arrow at one end when only that way can send, and a thicker line for more messages, as a second signal;
  - each label sits at the first point along its curve that clears the other labels and the nodes and fits inside the
    map; when no point fits, the first clear one is slid back inside the map, so a label is never cut off at its edge;
  - a legend for the styles, which also names the owner's machines with messaging off.
- Each line is a link (focus, Enter). Selecting it opens the conversation beside the map (below it at 900 px and
  narrower):
  - the pair and their machines, its state (on a paused link where a message also waits for approval, both the
    waiting state and Paused; "No right to send" with No access's icon in place of Active when neither side can
    send; the same in the Table), **Pause link** or **Resume link**, and **Remove link…** (a
    confirmation that names the two machines and what goes; once removed, it says neither machine can send to the
    other, or for two orchestrators on one machine that they cannot message each other);
  - the round trips used against the limit, or on a one-way link which side cannot answer and that the right is
    given in My reporters;
  - the messages as an Activity feed (`.feed`), oldest first, each with sender, receiver, time and delivery state
    as an icon and words. The text is text nodes; the only element in it is `.rd`;
  - how many days a conversation is kept, from the read's `retainDays`.
  - Pause and Remove act on the two reporters, through the owner's routes, so they also pause or remove the other
    conversations between the same two machines.
- **Table** shows the same links as text (pair and machines, messages, last message, round trips, state) and is
  where a 640 px or narrower screen opens. **Show** picks Live sessions, Last 24 hours or Last 30 days. Both are
  radio groups that move with the arrow keys.
- Not signed in, or not the owner: the map and counts show, the page never asks for the text, and the conversation
  says only its owner and an Admin can read it. An Admin reads it, but only the owner pauses or removes it here; an
  Admin's one action on a link is Pause all links, in Admin > Reporters > the reporter. The Admin's remove route
  (`DELETE reporters/:key/peers/:other`, 7.1) has no button.
- Empty: "No orchestrator has messaged another yet", with a link to My reporters; Show stays. A failed Pause, Resume
  or Remove says so in place and the link is unchanged.
- Long names are cut with an ellipsis and keep their full text as a title.

## Effort meter

Wherever effort appears (cards, facts bar, agent tree, agent panel) it is five small bars with no text. One bar
is lit for `low` up to five for `max`, so the count carries the level and color is never the only signal.

- Lit bars are colored by level: low orange, medium green, high blue, xhigh purple, and max one rainbow color
  per bar.
- The level is the meter's tooltip and accessible name ("Effort: medium").
- When effort was not reported, or is not one of the five levels, the bars are dimmed and the tooltip says
  "Effort not reported".

## Orchestrator page (click a card or rail item; #165, `mockup/podium-orchestrator.html`)

The header, the facts and a status band are one bordered surface, in this order: the header, then (only when
the session has context blowouts and its Blowouts cell is open) the blowout detail, then the facts, then the
status band as the last row.

**Address**
- The open orchestrator is kept in the address as `#/?open=<id>`, the way History keeps its opened session, so a
  reload or a shared link opens the same page. The wall is `#/`. The selected agent is not in the address.
- Opening an orchestrator from the wall adds a browser history entry, so Back returns to the wall and Forward opens
  it again. Moving to another orchestrator (the rail, an activity event) replaces that entry, so Back still returns
  to the wall.
- "All orchestrators" and Fleet return to the wall's entry when the console added one, and otherwise replace the
  address with `#/`. Opening an orchestrator from the board, My reporters or Traffic goes to its address.
- When the open session leaves the fleet, the address goes back to `#/` with the usual message. An address naming
  a session that is not in the fleet lands on the wall with "That session is not in the fleet. Sessions that ended are listed in History."

**Header block** (on the left)
- The name at 28 px beside the state shape, which is the status band's shape.
- The goal line: the plan title and current step.
  - With no step active, the first pending step is shown as the current one, marked "(inferred)".
  - "plan complete" when every step is done (#179).
- The working directory, then a `|` and the repository name when there is one. The `|` is decoration and is hidden from screen readers.
- The git line.

The session id is not in the header; it is a cell in the facts grid (#352).

**Charts** (on the right)
- Three charts: tokens per second, peak context (with a dashed 100% line, red blowout markers and a "N
  blowouts in 60s" caption), and subagents running. Each has a crosshair and a value readout on hover.
- The three charts are equal in height and fill the height of the header row (#197). Each chart's title and
  readout stay at the top, "60s ago" and "now" stay at the bottom, and the graph takes the space between,
  never shorter than 46 px and with no maximum. Gridlines, the 100% line, blowout markers and the crosshair
  scale with the graph.
- Off the chart, the readout of peak context and subagents running is the newest second.
- The tokens-per-second readout is the average of the newest 10 seconds (#191), because tokens reach the
  server in bursts and the newest second alone is usually 0. Its tooltip says "Average over the last 10
  seconds".

**Facts grid**

Twelve cells in fixed places, six to a row (two columns at 640 px and narrower, by the page's own width, so six
rows). Row one is Agents, Est. cost, Tokens, Running for, Agent time, Blowouts. Row two is Machine, System,
Reporter, Session, Resume, Fork (#352, `mockup/podium-fork.html`; #427, `mockup/podium-facts-system.html`). A cell
never moves because another has nothing to say.

- **Agents**: running, done, and a red "N failed" button that opens the first failure. The orchestrator counts
  as an agent, running while the session runs, done once it is done, and neither while the session is stale.
- **Est. cost**: the session's ledger.
- **Tokens**.
- **Running for**: wall-clock time.
- **Agent time**: the orchestrator's time plus every agent's own. It can be longer than running for when
  agents run at once.
- **Machine** (#427) is `machine.name` from the session's report, in the mono face, with the popup "The machine
  this session runs on. As its reporter named it." A session that sent no machine (no `userName`, so a
  settings-hooks session or one in the Admin or Unassigned band) reads "Not reported" in the muted face, and the
  popup says Podium learns the machine only from a reporter that has a user name, and that installing
  podium-reporter and setting `userName` in its options fills it in.
- **System** (#427) is `machine.os` as the reporter sent it, such as `Fedora Linux 44` or `macOS 15.4`, with the
  icon for its family and the wording My reporters and Admin > Reporters use (`systemKind`, `SystemTag`), so the
  three never disagree. The text is cut with an ellipsis when it is long, and its popup holds the whole text.
  When the report has a machine but no OS (a reporter older than the one that sends it, or a command that failed
  on the machine) it reads "Not reported" in the muted face, never blank or "undefined", and the popup says the
  reporter did not send the system and that updating podium-reporter fills it in. A session that sent no machine
  reads "Not reported" with the Machine cell's popup. Both cells are focusable, so the popup opens from the
  keyboard.
- **Reporter** (#124):
  - `reporterVersion` as given, such as `0.11.0`.
  - "Settings hooks" when it is null, with the hooks note as its tooltip.
  - When `compat` is `outdated` or `newer`, the card chip's wording without the leading "reporter", for
    example `0.3.0 · update`, in the warning color, with the same tooltip text as the note, taken from the
    same `versionNote` so the card and the bar never disagree.
- **Blowouts** (the last cell of row one since #427) is always present: "none" when clear, otherwise the count with a warning shape, amber at level 1
  and red at level 2. A button (`aria-expanded`, `aria-controls`) opens and closes the blowout detail (the
  sentence and each affected loop as a link), closed by default. A level 2 blowout also gives the whole
  surface the card's red top edge.
- **Session** (#322, #352) is the first eight characters of the session id in the mono face, with a copy icon.
  It is a button that copies the whole id and reads "Copied" with a check for 1.6 s, or "Copy failed" when the
  clipboard refuses, as the card's id does. Its accessible name is "Session" and the eight characters, then ", copy the full id" (the visible words first, WCAG 2.5.3, #636; the card's own control keeps "Copy session id" and the eight characters), and its tooltip is the whole id.
- **Resume** and **Fork** are quiet whole-cell controls with no button chrome. Each has its label (**Resume**,
  **Fork**) over "Command" and a copy icon, and behaves as Copy resume command and Copy fork command below.
  Their accessible names are "Copy resume command" and "Copy fork command".
  - Each has a popup that says what the command does, opened by hover and by keyboard focus, closed by Escape
    or when the pointer or focus leaves. It holds text only, and the cell points to it with
    `aria-describedby`. It opens above the cell, aligned to the cell's right edge, so it must not be clipped
    by the surface.
  - Machine and System have the same kind of popup, text only, opened by hover and keyboard focus and closed by
    Escape. In the two-column layout a popup in the left column opens to the right, so it stays on the page.
  - The Resume popup says it continues this same session in a new terminal with the whole conversation, that it
    should be run once the session has ended because resuming one that is still running in another terminal
    writes both into the same conversation, that it starts in the session's working directory and does not
    restore flags such as `--mcp-config`, and that Fork is the way to try something without changing this
    session.
  - The Fork popup says it starts a copy of the conversation in a new session, that this session is not
    changed, that permissions allowed for the session are not carried over, that it works in the same
    directory so file edits are real (start it in a worktree to keep them apart), that flags such as
    `--mcp-config`, `--settings`, `--plugin-dir` and `--add-dir` are not restored, and that it needs the
    session's transcript, which Claude Code keeps for 30 days by default.
  - Fork is offered for a live, waiting or ended session. Podium cannot tell whether the transcript still
    exists, so it does not offer a "transcript gone" state; the popup names the 30-day limit.
  - Fork is not on History's read-only page, as Resume is not. There is no worktree variant: nothing in
    `claude --help` says `--worktree` combines with `--resume --fork-session`, so the popup advises it.
- The orchestrator's model, effort and context are not in the bar. Its row in the agent tree shows them (#109).

**The status band**
- It is the last row of the surface, full width, at least 58 px tall, with one bold line and an optional detail
  line. It replaces the status chip beside the name and the waiting, background-wait, heartbeat-lost, hooks
  and reporter-version callouts.
- It uses the card band's states, shapes, sentences and tints (`cardKind`):
  - running: "Running";
  - done: "Done";
  - waiting: the wait sentence, with the detail "Answer in its terminal." and what it waits on;
  - a background wait: its sentence, with the task description as the detail (tooltip: the full text);
  - heartbeat lost: "No heartbeat for 0:38. Goes away in 37s." with the detail "The session may have crashed
    or been closed without a clean exit." and a **Remove now** button laid over its right end as its own
    element (only for a viewer who can remove).
- Waiting and heartbeat lost get the heavier tint.
- **Delegating** (#98, #287) shows here and on the card, the rail item and the wall: "Delegating to N agents."
  with the blue ring shape, naming the agents. The card carries the sentence and lists the agents in its
  tooltip. The page adds them as the detail line. Failed agents do not change the band.

**Plan section and agent tree**

Two columns: the plan section and the agent tree.

*The plan section* is a tab list, **Plan** and **Files** (arrow keys, Home and End move between them; Plan is
selected first and the choice is not saved). While Files is selected the left column is 400 px wide instead of
300.

- **Folding (#604).** A button on the column's right edge ("Hide plan and files", `aria-expanded`) folds the whole
  column to a 28 px rail that holds the same button ("Show plan and files") and the name set sideways, and the agent
  tree takes the width. The rail is as tall as the open column was. The choice is one flag for every orchestrator's
  page, kept in `localStorage` under `podium.planFiles.collapsed`; it is open unless a stored `true` says
  otherwise. The panel stays mounted while folded, so the selected tab, its scroll and the plan's page are there
  when it opens again, and the Files widening is not applied while folded. Where the two columns stack, the same
  button hides the panel in the stack and the folded bar is 16 px high across the width. Nothing on the page links
  into the panel, so no link has to open it first.

- **Plan** is the checklist (active, blocked, pending, done, with owner label), under a progress bar that a
  hairline separates from the first step (#200).
  - **Order (#454).** In progress first, then blocked, then pending in plan order, then done in the order they
    finished, oldest first. A step that finishes moves to the end of the done steps; one the model reopens
    goes back among the open steps in plan order. Open work stays on the first page. Done steps whose finish
    the server never saw (a plan already part done when it first arrived) come first among the done, in plan
    order. The count, the bar, the inferred step and the Board keep plan order; only this list is reordered.
    The server numbers the finishes (`doneSeq` on each step of `session.plan`, never sent by a reporter, [7.4](../07-server/07-04-view-types.md)), so a reload keeps the order (#465). Two reports carry the same plan when
    their source and title are equal and every step id they share has the same text; the numbers carry over only between
    the same plan. A report with no plan in between does not break that: the server keeps the last plan until one returns.
    A different plan starts over, and one first seen already part done gets no numbers. A step
    that moves keeps its row and the viewer's page, and the list says once, politely, to assistive
    technology: "`<step>` finished and moved to the end of the list." (several at once: "N steps finished and
    moved to the end of the list."). Rows do not slide, so reduced motion needs no special case.
  - Each state has its own mark, so shape carries the state as well as color: a green circle with a check for
    done, a ring with a filled dot for in progress, a ring with a slash for blocked, an empty ring for not
    started.
  - With no step active the first pending step gets a dashed ring and the note "up next · inferred" (#179),
    display only, never sent to or from the reporter.
  - A plan of more than 10 steps shows 10 at a time with the same pager as Files under the list ("Showing
    1–10 of 23", the page buttons; none for 10 steps or fewer, #214). The count beside the tabs and the
    progress bar cover the whole plan, not the page. The panel opens on the page holding the current step, and
    a plan that changes keeps the page being viewed unless it no longer exists.
  - The plan panel does not say where the steps were read from.
- **Files**, from `session.files`, lists every file the session changed, committed or not.
  - Each row: the file name in bold over its folder, a letter for the status (A, M, D, R) with the word for
    screen readers, and the signed counts (`+12 −3`, the word `binary` for a binary file), with a five-block
    bar beside them (green for the share of added lines, red for the rest) that carries no numbers.
  - With the `file-diff` flag and the session's `fileDiff` option on, and the session's signed-in owner
    (#319, `mockup/podium-file-diff.html`), a row is a button named "Open diff of `<path>`". Enter, Space and a
    click open the shared `Modal` (#97): the title is the path, the sub line is the status letter and the
    counts. The modal is a wide variant (up to 1240 px). The diff is side by side: the old file on the left
    and the new one on the right, level line for line, with a filler beside a line that has no partner (an
    untracked file has an empty left, a deleted one an empty right). In a modal narrower than 720 px it is one
    column with both line numbers. It is text nodes in a monospace face, line breaks kept; removed and added
    lines carry a `−`/`+` gutter mark as well as color; hunk headers are set apart. Long lines wrap at the
    pane's edge by default (#623, `mockup/podium-file-diff-wrap.html`): a line continues under its own text, its
    number and mark appear once on its first visual line, and side by side each pair of lines sits on one grid
    row, so the old and new halves stay level (the panes stay two elements in the same order, so keyboard and
    screen reader order do not change). A **Wrap lines** switch (the `.sw` on/off switch, with its On or Off
    word) at the lower right of the modal's bottom row turns wrapping off, and then long lines scroll inside the
    modal, each side on its own with the other following. The choice is kept in the browser
    (`podium.diffWrap`), and a failed read means wrapped. The switch shows only where a diff is drawn. The
    note below (the cut and the count of hidden values) sits between the pager and the switch. Each `[redacted]` in it
    is bold and in the critical color, and a footer counts them ("3 values hidden as possible secrets").
    It shows a loading state (the word "Loading" at 18px with three dots that fill in on the console's shared
    beat, all three still when the reader prefers reduced motion). The bottom row always starts at the left with the
    Files tab's pager (#630, `mockup/podium-file-diff-step.html`): "Showing file 3 of 12" and Previous and Next
    buttons (`‹` and `›`) that step through every file in `session.files`, in the list's order and not only the
    page the first one came from, without closing the modal. Each button is named for the file it opens ("Next
    file: src/b.ts") and has that as its tooltip, and is disabled at the first and last file (no wrap). The
    modal's content changes in place: the title, counts and diff, the scroll back to the top, the Wrap lines
    choice kept, and focus on the button used (or on the other one when the used one has just been disabled).
    With the session's `fileDiffPreload` on (#631) the page loads every listed file's diff in the background when it opens
    (`DiffPreloader`: first-listed first, two at a time, the file being opened moved to the front with one more place, nothing
    while the tab is hidden, held in the page's memory only and dropped when the page, the session or the access goes), so a
    loaded file opens at once. A file whose status, counts, `from` or `rev` changed is loaded again and its old text stays
    until the new one swaps in; a failed one shows today's message and is asked for again when opened, not in the background.
    With it off, only the file in view is asked for, 120 ms after the last step so that holding a key down asks for the file it stops on and not each one it passes (the server holds four a session), and a reply for a file the person has left is dropped, so the last file's
    diff is never drawn under the next file's title; a 429 or 504 shows for the file in view and the buttons
    still step past it. The row shows in loading, failed and binary states too. Below 480 px the switch comes up
    beside the pager and the note takes a line of its own. Where the diff is
    drawn, it fills the modal; for `binary`, `withheld`, `too-large`, `unavailable`, a deleted, renamed or
    untracked file, and a cut diff ("Showing the first N lines of M") it shows a plain message. Close, Esc and the dimmed
    area return focus to the row.
  - Otherwise the row is not a button. With the `file-diff` flag off nothing changes, since a flag that is off
    hides its feature. With it on, a line under the list says why: "Sign in to open diffs." (signed out),
    "Only `<Owner>` can open diffs." (someone else's session, an Admin included), "This session has no owner, so no
    one can open its diffs.", or "Turn on the fileDiff option of podium-reporter on this machine to open diffs."
    A session that has ended shows no line.
  - A summary line above the list gives the file count and the totals (`6 files · +855 −145`).
  - The list shows 20 files a page, and the pager footer reads "Showing 1–20 of 47" with the page buttons
    (previous, numbered, next) once there is more than one page, and "20 per page" when there is not (#200).
  - A footer says when the reporter cut the list (`Listing the first 200 of 340 files.`) or when the starting
    commit is gone and the diff is against the upstream or the working tree only.
  - With no files the tab says `Files will appear here once a file has been updated.` When the reporter is
    older than 0.6.0 or the session is hook-only, a note under it says to update the mod.
  - The tab label carries the count (`Files 3`).

*The agent tree* has indented guides, the agent marker (#141), task, type, model chip, effort meter, context
bar (amber from 75%, red from 80%) with blowout badge and red stripes at 2+, tokens, cost, time, status chip,
and inline failure class.

- **The marker** at the start of a row is the same one the card's agent strip draws: a square in the agent's
  model color for a subagent, a circle for a fork, faded when done or aborted, outlined red when failed, dashed
  and unfilled when queued.
  - In the tree it has a 1.5 px border, the model color mixed toward the theme's ink so it follows light and
    dark (dashed in the model color when queued).
  - It is not a stroke icon, so it never reads as an empty box, and it is decorative: the status chip carries
    the state.
  - The legend's "Square color is the model" holds for the cards and the tree rows (the legend's own swatches
    are gray).
  - The Kind row of the agent panel keeps its own icons.
- **Sorting.** A column header sorts the tree: the children of each parent, and the top-level agents, are
  ordered by that column, and every child stays under its parent at every depth (#101). Clicking the same
  header again reverses it, and **Launch order** clears the sort.
- The full task and type are each row's tooltip.
- Selecting a row opens the agent panel. The selected row keeps a highlighted background and does not flash.

*The orchestrator's own row* is selectable too and opens an orchestrator panel: name, status, model, effort,
context with blowout badge, tokens, cost, time, git line, and from `session.loop` the steps, tools used and
skills loaded, laid out and worded as in the agent panel.

- The orchestrator's tool counts cover its own calls, not those of the agents it launched.
- When the reporter sent no `session.loop` (a mod older than 0.4.0), those rows are left out rather than shown
  empty, and one note under the facts says they need podium-reporter 0.4.0 or later, as the agent panel does
  for tool counts.
- A settings-hooks session has no mod, so it shows neither the rows nor the note.

## Agents that launch agents (#101, `mockup/podium-nested-agents.html`)

A subagent or a fork can launch its own agents ([5.3](../05-mod-api/05-03-events-the-reporter-hooks.md)), and every place that
lists or counts agents treats them like top-level ones.

- **Tree.** The agent tree nests each under its real parent at any depth. Each level past the second widens
  the Task column by one 16 px guide (a `--deep` custom property on the table), and the table scrolls sideways
  inside its own box, so a deep row keeps as much room for its task as a second-level one and no guide is
  dropped. The tree's caption says how many were launched by other agents ("6 launched, 4 by other agents").
- **Cost.** An agent's row is its own estimate. The facts bar and the card are the session's ledger, which
  includes every agent once at every depth. The orchestrator's row and panel are its own share, the ledger less
  each agent's estimate (never below zero), so the rows add up to the facts bar (#109). Each says so in its
  tooltip, and the Cost header's tooltip says both.
- **Tokens** add the same way ([5.6](../05-mod-api/05-06-what-the-engine-does-and-does-not-tell-you.md#tokens-as-shown-issue-96)).
- **Agent panel.** It has a **Launched by** row (the parent's task as a button that opens it, or "the
  orchestrator"). For an agent that launched any, it also has **With its agents**: its own estimated cost and
  Tokens figure plus those of every agent under it, each counted once (a parent cycle cannot loop), with the
  count of those agents and how many are not priced.
- **Counting.**
  - The card's agent strip is in tree order, and a nested agent's square names its parent in its tooltip.
  - The rail, the facts bar and the card count every agent once and the orchestrator as one more (#109). The
    wall's "agents running" tile counts agents only, since "orchestrators live" is beside it.
- **Activity.** A spawn row in the activity feed for a nested agent ends with "· launched by `<parent's task>`"
  and opens that agent.
- A plan step can be owned by a nested agent like any other.
- The Files tab lists the session's working-tree changes and names no agent, so changes made by nested agents
  are in it.
- A settings-hooks session has no parent ids ([5.3](../05-mod-api/05-03-events-the-reporter-hooks.md)): its agents are all at the
  top level and its note says so.

## Delegating (#98)

In the agent tree, the page header and band, the fleet card (and so the wall) and the rail item (#287), a row
whose own status is `running` and that has at least one running direct child reads **delegating** instead of
"running", in a blue ring-dot style that is not amber (amber and the word "waiting" mean the session is
waiting on the person).

- The orchestrator's children are the agents with no parent, or whose parent is not in the list. An agent's
  children are the agents whose `parentId` is its id.
- Hovering the chip lists the agents it is waiting on ("Waiting on 2 agents: A, B. Not waiting on you."), and
  the same text is its accessible name.
- It is derived in the browser from `agents[].status` and `parentId` only. It is not a session status. The
  card, the rail item and the page all take it from one function (`stateKind` over `waitingOnByRow`), so they
  cannot disagree.
- On the card the band reads "Delegating to N agents." in the blue style with the ring shape beside the name.
  On the rail item the dot is the blue ring and the screen-reader text is "delegating".
- A delegating session still counts as running in the status filter, the sort order and the KPI counts (live,
  running, waiting), because the server status is still `running`.
- When the session itself is waiting, stale or done its own status shows, and when its last running child
  finishes the card and the rail item go back to "Running".
- Podium cannot tell a foreground launch from a background one, so an agent launched in the background reads
  as delegating while it runs.
- The color is the `--deleg` and `--deleg-text` tokens, defined in every theme and mode and checked by
  `scripts/theme-contrast.ts`.

## Waiting on a background process (#119, `mockup/podium-background-wait.html`)

A session that ended its turn but has background work in flight (a shell, a monitor, a background agent or a
workflow) or a scheduled wake-up is not waiting on the person.

- Its card, rail item, orchestrator page's status band and activity row read "Waiting for 1 background shell
  to finish" (counts per kind when there are several; "Waiting for a scheduled wake-up at 14:30" for a
  wake-up; with both, "Waiting for 1 background shell to finish, and a scheduled wake-up at 14:30"), in the
  blue ring style of Delegating, not amber.
- It keeps its place in the Waiting filter, but is not counted in "waiting on you".
- The card carries only that short line, so a long task description cannot wrap it.
- The orchestrator page's band adds the task description after the line, as its detail row, cut at a
  character limit and ended with " ..." (a space, then three dots). The tooltip lists each task.
- The ring dot pulses like the running dot, on the same shared beat.
- In the activity feed the newest such row is tinted and outlined in blue with a kind pill, as a waiting row is
  in amber.
- A shell's command is shortened and redacted, and never sent whole.
- When the work ends the wording goes back to normal at once. "Waiting for your input" and approval waits are
  unchanged.

## Right panel

**Activity list**
- Newest first, **12 rows**, "Show 12 more" and "Show fewer", count text "Showing N of M", footnote "Only
  the latest 150 events are kept in memory."
- Each row is a button that selects the session and agent it is about, scrolls the agent row into view and
  flashes the whole row once (the only place a row flashes).
- Failure rows say "Show root cause", blowout rows "Show context history".
- Rows of sessions that have left the live set are greyed, say "Session ended" and do nothing.
- Filtered to the selected orchestrator when one is selected.

**Agent detail**
- Status.
- **Failure box**: class, failing call, output tail, evidence list, explanation if present, what happened next.
- **Blowout box**: timeline of each overflow with time and token counts, explanation.
- Kind, type, model and effort (marked "inherited" for a fork), context, tokens, cost, time, steps.
- **Tools used** as chips (below), skills as chips.
- A **Report** group, an **Activity** section (below).
- Child agents as buttons ("Launched by this agent"), and a back button.
- A **Launched by** row and, for an agent that launched any, a **With its agents** row (see "Agents that
  launch agents" above).

**Report group**

Two buttons, **Task prompt** and **Final answer**, each with the length of the text (`1,842 chars`).

- A button is enabled only when there is text for it.
- Without the full text it falls back to the 400-character excerpt and says `excerpt only`.
- With neither it is dimmed, dashed and inert and says `not reported`, and for the answer of an agent that is
  still running `not finished`. It turns on when the answer arrives, without a reload.
- A click opens a centered modal (`role="dialog"`, `aria-modal`, labeled by its title) with the text rendered
  as markdown, the rest of the page blurred behind it.
  - Markdown supports headings, lists, bold, italic, inline code, fenced code, block quotes and links. A fence
    closes only on a fence at least as long as the one that opened it, and a link's address may hold one level
    of balanced parentheses.
  - The renderer builds elements only: raw HTML in the text shows as text, and a link opens in a new tab with
    `rel="noopener noreferrer"` and only for `http:`, `https:` and `mailto:`.
  - The modal closes with the X, Esc or a click on the dimmed area. Focus moves in, Tab stays inside, and focus
    returns to the button. While it is open the page behind gets no keys (Esc does not leave wall mode).
  - A **Copy** button copies the raw text.
  - When only the excerpt is shown a note says so: for a mod older than 0.10.0 it says to update, otherwise it
    names the `fullPrompts` option.
  - The full text is fetched when the modal opens. If that fails the modal shows the excerpt and says so.

**Activity section** (#118, `mockup/podium-agent-feed.html`)

It sits under the Report group of the agent panel, and under the git line of the orchestrator panel. It shows
the loop's recent tool calls and the text it writes ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md)).

- *The list.* Newest at the bottom, at most 20. Each row has its time since the loop started (`01:22`, the
  clock time as its tooltip), an icon for its kind (tool call, text, reasoning) with the kind as its accessible
  name, and the text. A tool call's name is in the delegating blue followed by its argument summary in mono.
  Text is in the secondary ink. Each `[redacted]` the mod put in is marked in red.
- *Following.* The list follows the newest entry. Scrolled up, it stops following and a **Jump to latest**
  pill brings it back.
- *Header.* An **Expand** button (`aria-haspopup="dialog"`) and, while the loop runs, a **Refresh every**
  dropdown (5s, 10s, 20s, 30s, 60s; default 5s; remembered per browser in `localStorage` under
  `podium.activityEvery`, with try/catch).
- *Fetching.* The panel fetches `GET /api/fleet/sessions/:id/agents/:agentId/activity`
  ([7.1](../07-server/07-01-endpoints.md)) at once and then on that interval, only while the panel or its modal is open and the
  tab is visible. Each fetch renews the server's lease.
- *Starting empty.* A viewer sees only what arrived after their first fetch, so it starts with "Watching from
  now. Earlier activity is not kept, and nothing is kept after you close this."
- *Footer.* One row that keeps its height whatever the text says (each text on one line; the count is cut with
  an ellipsis and carries its full text as a tooltip; the time reads "Updated Ns ago" from the first second,
  never "just now"): "Last N of M since you started watching" (or "Nothing yet") and "Updated Ns ago". Then
  the line "Kept only while someone is watching. Closing this clears it. Secrets are removed before they leave
  the session."
- *Finished.* A finished agent (or an ended session) is fetched once more for its last entries, offers no
  dropdown, and says "Agent finished, no more updates".
- *Stored history (#432).* When the Admin keeps the Activity history and a reply carries `history`, the window
  changes as follows. Under the default policy none of it applies and the window is as described above.
  - A viewer who may read it (`canRead`) gets the newest stored page from
    `GET /api/fleet/respond/sessions/:id/activity-history` ([7.1](../07-server/07-01-endpoints.md)), and the live entries after it
    without repeating one the page already holds. The 20-entry cap no longer applies. An ended loop still loads
    its stored page.
  - Under the list, while older entries are stored, a row says "Showing the newest N" with a **Show older**
    button (a small button; the row is as tall as the button). Older entries are prepended without moving what
    the viewer was reading.
  - The footer count reads "412 stored entries since 2026-10-12" (one entry: "1 stored entry"), and the time
    reads as above. The line under it says how long entries stay and who can read them: "Kept until 2026-11-11,
    then purged." (when the policy is a period), "Kept until the session ends, then removed." or "Kept until the
    session is removed from Podium.", each followed by "Only the owner and the Admin can open it. Secrets are
    removed before they leave the session." The modal shows the same line.
  - A viewer who may not read it sees no entries. The list says "History is kept for this session. Only Ed and
    the Admin can open it." (or, when not signed in, "Sign in as Ed or an Admin to open it."; for a session owned
    by `Admin`, "Only an Admin can open it." and "Sign in as an Admin to open it."; on the History page, which does
    not know whether the viewer is signed in, the plain line is followed by "Sign in if that is you."), the count says
    "Nothing to show", and the line under says stored activity can hold anything an agent read or ran, so it is
    not shown to other viewers. A refusal from the history route (401 or 403) shows the same.
  - A failure to load stored history does not stop the live entries; the next fetch asks again.
- *Expand* opens the same feed, larger, in the console's modal, with the same blur, Esc, X, click-outside,
  focus trap and focus return as the Report modal (one shared `Modal` component), and the dropdown in its
  header. It shares the panel's fetching.
- *Option off.* When the option is off (`activityFeed: false`), a dashed note says "Recent tool calls and text
  appear here while the agent works." and names the `activityFeed` option (Send an agent's recent activity)
  and the 300-character cut. Nothing is fetched. For a mod older than 0.13.0 the note says to update instead.
- *Admin flag off.* When the Admin has turned the feed off (the `activity-feed` flag, *Feature flags* above),
  the section shows a dashed note instead, "The activity feed is turned off by the Admin." with "Someone with
  Admin access can turn it back on in Admin > Settings > Feature flags. Nothing is fetched or kept while it is
  off.", and no list, no Refresh every dropdown and no Expand button. An open modal shows the same note.
  - This note takes the place of the reporter-option and update notes when both apply.
  - The panel learns it from `StateBody.features` and from the route's `enabled: false`. While the panel is
    open it keeps asking the route on its interval (no lease is taken while the flag is off), so the feed
    starts again by itself, empty, when the flag is turned back on.
- *Output off (#431).* A Bash row's output block says in words why there is none: "Output is turned off by the Admin."
  (the `activity-output` flag, with "Someone with Admin access can turn it on in Admin > Settings > Feature
  flags."), or "Output is turned off for this machine." (naming the `activityOutput` option, "Send a Bash command's
  output"). An older reporter sends no `command`, so a cut row shows its 300 characters with the note "cut at 300
  characters; this reporter sends no more" and no chevron. The Expand and Respond modals and the replay follow the
  same words.
  - A call that finished before the panel was open has its command and no output, since output is captured only while
    a viewer has the panel open. The mod still reports that the call finished (`done`, `failed`, `exitCode`, #598), so
    the row shows its status mark on the line and beside Output, and the block says "Output was not collected." and
    "Output is only collected while this panel is open." The Admin's flag and the machine's option, when off, are said
    in place of that, and the status mark still shows. A stored-history row says "Output is not kept in history." and
    "Only the command is stored. Output is shown while someone is watching the session and is gone after."
  - A call with no `done` is told by its loop. The newest entry of the feed, a Bash call with no `done` and no output,
    while the loop is working, says "Running." and "The output appears here when the command finishes.", and its line
    says "running". Any other call with no `done` (an older call, one a later entry follows, or any call of a loop
    that has ended) says "Output was not collected." with no status mark. An older reporter sends no `done` without
    output, so its rows read this way, apart from the newest one while the loop works.
  - A failed call with no exit code shows a cross and the one word "Failed"; with a code, "Exit N, failed". A call that
    succeeded shows a bare check with "Succeeded, exit 0" for a screen reader.
- A settings-hooks session has no mod and shows no Activity section.

**Tools used**
- One chip per tool with its call count, most used first and ties by name, in the Skills chip style, under the
  label "Tools used (N calls)".
- The five most used show. With more, a "Show all N" button (`aria-expanded`) shows every tool and then reads
  "Show fewer".
- A green dot on a chip marks the tool used last (with a visually hidden "last used"). When that tool is not
  among the five shown, a line "Last used: name" says so.
- An agent with no calls shows "None seen".
- When the reporter sent no `toolCounts` (older than 0.2.0), the panel shows the "Last tool  name (N calls)"
  line instead and no chips.
- When that reporter is a mod below 0.2.0 (not a settings-hooks session, which has no mod to update), one note
  under the line says tool counts need podium-reporter 0.2.0 or later, gives the version the session reports
  and the update command, and points at `/reload-plugins`.

## Data flow

`useFleet` loads `/api/fleet/state`, opens the SSE stream, applies `session`/`activity`/`removed`/`wall`/`tick`
with a pure reducer, and on reconnect refetches state. Elapsed times tick locally every second from `startedAt`
so numbers move between server messages. Memory: keep at most 150 events; keep `series` as sent.

## Copy resume command and Copy fork command

Copy `resumeCommand` or `forkCommand` with `navigator.clipboard.writeText` inside the click handler and show
"Copied" with a check for 1.6 s. When the clipboard refuses, nothing changes and the cell stays as it was;
there is no fallback field (#352). Nothing is sent to the server, stored or logged. Podium never runs the
command: the person pastes it into a terminal.

<!-- nav:start -->
---

Up: [8. The UI](README.md) · Next: [8.2 Components](08-02-components.md)
<!-- nav:end -->
