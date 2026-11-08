---
title: "7.6 SSE stream"
description: "The live event stream: headers, events and when each is sent."
group: "Reference"
section: "7.6"
order: 6
---

# 7.6 SSE stream

`GET /api/fleet/stream` sends `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, and flushes headers at once. Messages (`event:` name, `data:` one JSON line):

| Event | Data | When |
|---|---|---|
| `snapshot` | the full `/state` body | on connect, and when the Admin changes a model price or a feature flag |
| `session` | one `SessionView` | on change (throttled per session) |
| `activity` | one `ActivityView` | new event |
| `removed` | `{ sessionId, reason: 'done'\|'dropped'\|'deleted' }` | leaves the live set |
| `wall` | `{ notices, showBackgroundSessions, cardTitleMachine }` | when an Admin setting or a closed notice changes the wall's notices (8.1) |
| `chat` | `{ rev, scope: 'public'\|'group'\|'dm' }` | a Chat thread changed, or an Admin began reading one. It carries no text, no person's name, no count and no id, because every open console receives it: `rev` is a change counter and `scope` says which kind of thread. A console asks the Chat routes, which check who is asking, for its own person's counts and for anything else (#1034) |
| `replay` | `{ rev }` | an Admin opened, paged or left a replay of someone's recorded session (#1075). It carries a change counter and nothing else, because every open console receives it: the owner's console reads who is replaying from `GET /api/fleet/respond/recording-reads`. |
| `tick` | `{ serverTime, kpis }` | every 2 s (also serves as keepalive; the client treats 6 s of silence as disconnected) |

The registry removes a client on `close`/`error`, and a write that throws never crashes the process. Supports 100 simultaneous clients. Send `retry: 2000`.

<!-- nav:start -->
---

Previous: [7.5 Lifecycle timers](07-05-lifecycle-timers.md) · Up: [7. The server](README.md) · Next: [7.7 Hardening](07-07-hardening.md)
<!-- nav:end -->
