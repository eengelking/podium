---
title: "7. The server"
description: "The server's requirements: routes, database, ingest, view types, timers, the live stream and hardening."
group: "Reference"
entries: "list"
section: "7"
order: 7
---

# 7. The server

## Pages

<!-- entries:start -->
- [7.1 Endpoints](07-01-endpoints.md): Every server route, grouped as fleet, responding and Admin routes, with its purpose.
- [7.2 Database (SQLite)](07-02-database.md): The SQLite databases: path, pragmas, migrations and tables.
- [7.3 Ingest rules and derivation](07-03-ingest-rules-and-derivation.md): What the server does with each valid report, and the values it derives from it.
- [7.4 View types](07-04-view-types.md): The types the server sends to the UI, defined once in protocol.ts.
- [7.5 Lifecycle timers](07-05-lifecycle-timers.md): The sweeper's timers and their defaults: when a session goes stale, lingers and is dropped.
- [7.6 SSE stream](07-06-sse-stream.md): The live event stream: headers, events and when each is sent.
- [7.7 Hardening](07-07-hardening.md): Binding, tokens, TLS and the other protections the server must apply.
<!-- entries:end -->

<!-- nav:start -->
---

Previous: [6. The reporter protocol](../06-reporter-protocol/README.md) · Up: [Specification](../README.md) · Next: [8. The UI](../08-ui/README.md)
<!-- nav:end -->
