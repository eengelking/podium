---
title: "26. The server logs events, and can push them to a central platform"
description: "The server logs events with stable names, as text or JSON, and can push them to VictoriaLogs, at the cost of network calls and lines lost when it is down."
group: "Project internals"
number: 26
date: "2026-10-14"
status: "accepted"
order: 26
---

# 26. The server logs events, and can push them to a central platform

**Decision.** The server writes each thing it does as an event with a stable dotted name, a level and flat
fields (`server/src/logging/`, #140).

- Plain text stays the default and prints what the server always printed. `json` prints one object per line.
- When `PODIUM_LOG_SHIP_URL` is set, the server also pushes the JSON lines to that endpoint, shaped for
  VictoriaLogs' JSON line ingest, from a bounded buffer that drops the oldest lines when the endpoint is
  down.
- Only the server logs this way. The mod does not.
- Access logging is one `http.request` line per request at `debug`, so it is off at the default `info`.
- Admin changes are `admin.*` events with the action and the source address. The Admin Log table is
  unchanged.
- Node's own `fetch` and `zlib` do the work, with no logging library.

**Why.**

- The maintainer wants an agent to find out what a deployment did through the VictoriaLogs MCP server: a
  rejected report by its reason, a session's start and end.
- A push from the server needs nothing else installed, and the same JSON on stdout still serves a collector
  such as Vector or Fluent Bit for anyone who prefers that.
- The mod's logs would leave the user's machine, a different privacy decision, so they stay out until
  someone asks.
- A line per request is noise for most people, and the paths already show in the events that matter.

**Cost.**

- With shipping on, the server makes network calls on its own, and lines are lost when the endpoint is down
  longer than the buffer lasts (it says so once).
- The default text output stays what it was. The events added with the logger (sessions, reporters, sweeps,
  Admin changes, conflicts) print in text only at `debug`, which the maintainer chose so
  that turning nothing on changes nothing. A refused credential (`auth.failed`) and the `tls.*` events were
  moved out of that list in #602, folded to one line a minute, because an Admin reading a plain log to find
  out why a reporter is offline saw nothing. They are still at their own level in `json` and in what is
  shipped, so someone reading plain text at the default level sees less than an agent reading VictoriaLogs.
- Field names are checked against a deny list and strings are scrubbed, but a new field still needs its
  author to think about what it carries.

<!-- nav:start -->
---

Previous: [25. The Admin can switch the activity feed off for the whole server](25-the-admin-can-switch-the-activity-feed-off.md) · Up: [Decisions](README.md) · Next: [27. The wall's cards stretch, in at most four columns](27-the-walls-cards-stretch-in-at-most-four-columns.md)
<!-- nav:end -->
