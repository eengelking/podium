---
title: "Stored activity"
description: "Filter the stored Activity history by session, owner or age and delete what you no longer need."
group: "Getting started"
order: 11
---

# Stored activity

The Activity history Podium holds, by session. Set **Source** to Recordings to list session recordings instead
([Session recording](../04-reading-the-console/13-session-recording.md)). At the top are the totals (entries, size on disk and sessions). Filter
by session, loop, project, owner, age, or a range of dates (**Entries from** and **to**), tick sessions and delete:

- **Delete N…** removes the ticked sessions' history.
- **Delete all N that match…** removes everything the filter matches (it needs a filter).
- **Delete everything…** empties it.

Each asks first and says how many entries and how much space will go. A running session keeps being captured while the
policy keeps history. After a delete, the file is compacted so the space comes back, and a line says how much was
freed. Each delete is written to the Admin log with who did it and how much went, and never the text. A delete changes
the database only; copies of the database you made earlier are not changed. To remove something private that leaked,
delete the session's history, or use the date range to remove just the minutes concerned across sessions.

<!-- nav:start -->
---

Previous: [Data](10-data.md) · Up: [Admin](README.md) · Next: [Reporting](12-reporting.md)
<!-- nav:end -->
