---
title: "Traffic"
description: "Traffic, the map of which orchestrators message which, was replaced by Chat in 1.6. Where its conversations went."
group: "Getting started"
order: 15
---

# Traffic

**Traffic** was replaced by [Chat](16-chat.md) in 1.6. It was a map and a table of which orchestrators message which, and what they said. The same
conversations are now Chat's Direct Messages, with the same Pause link and Remove link in the menu on each one, and you can read back, page to older
messages and add to one. There is no Traffic link in the top bar, and the old address, `#/traffic`, opens Chat at once.

- **Where to go:** open **Chat** from the top bar. The map and the per-range counts have no Chat equivalent; read the conversations there.
- **Who can read a conversation:** its owner and an Admin, as before, and you are told when an Admin reads yours (see [Chat](16-chat.md)).
- **Programs that read the old data:** `GET /api/fleet/peers/traffic` keeps working until 1.9, when it is removed with the page's code. Move to the routes in
  [SPEC 7.1](../../spec/07-server/07-01-endpoints.md#routes-for-chat-1034) before then. See [Deprecations](../../DEPRECATIONS.md#the-traffic-page).

<!-- nav:start -->
---

Previous: [My reporters](14-my-reporters.md) · Up: [Reading the console](README.md) · Next: [Chat](16-chat.md)
<!-- nav:end -->
