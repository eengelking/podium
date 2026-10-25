---
title: "25. The Admin can switch the activity feed off for the whole server"
description: "An Admin feature flag switches the activity feed off for the whole server, on top of each machine's own option, at the cost of puzzling machine owners."
group: "Project internals"
number: 25
date: "2026-10-13"
status: "accepted"
order: 25
---

# 25. The Admin can switch the activity feed off for the whole server

**Decision.** On top of the reporter's `activityFeed` option (24), Admin > Settings > Feature flags has an
**Agent activity feed** switch (`activity-feed`). It is on by default, kept in the `settings` table with the
other Admin settings, and written to the admin log. The feed needs both.

- With the flag off, the server grants no lease, lists nothing in `watch`, keeps nothing a mod sends, and
  drops what it held when the flag goes off. The activity route answers `enabled: false`.
- Open panels keep asking on their interval and say the Admin turned it off, so turning it back on resumes
  the feed without a reload.
- The store is a generic list of flags, `FEATURES`, so the next feature that needs an off switch adds one
  entry.

**Why.**

- The reporter option belongs to whoever runs each machine, and the feed is read by everyone who can open
  the console. The person who runs the server needs a way to stop it for everyone without asking every
  machine to change a setting, and to have that recorded.
- Default on, because the reporter option is already off by default, so a flag that also started off would
  make the feature take two steps to try for no added safety.

**Cost.**

- A machine with the option on still captures nothing while the flag is off, which can puzzle its owner
  until the panel's note explains it.
- Open panels keep making one small request per interval while the flag is off.
- A flip sends every browser a full snapshot, which is fine for a switch that changes rarely.

<!-- nav:start -->
---

Previous: [24. An agent's activity is sent only while someone watches it, and never kept](24-an-agents-activity-is-sent-only-while-someone.md) · Up: [Decisions](README.md) · Next: [26. The server logs events, and can push them to a central platform](26-the-server-logs-events-and-can-push-them.md)
<!-- nav:end -->
