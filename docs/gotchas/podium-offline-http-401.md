---
title: "/podium says \"offline\" and \"Last error: HTTP 401\""
description: "The server wants a token and the mod sends none or a wrong one; get yours with podiumctl token and enter it in the plugin settings."
group: "Project internals"
area: "Connecting the mod"
date: "2026-10-11"
status: "open"
order: 1
---

# `/podium` says "offline" and "Last error: HTTP 401"

**You see:** `/podium` reports `Connection: offline` with `Last error: HTTP 401`.

**Why:** The server has a token and the mod is not sending a valid one. A person's token only works with the
`userName` it was made for. A revoked or rotated-away token is refused too.

**Do:**

1. Get the token with `podiumctl token`. On a shared server, ask the owner for your own token.
2. Enter it with `/plugin configure podium-reporter@eengelking-marketplace`.

The mod logs the refusal once and tries again about once a minute, so queued reports go out within a minute of the
settings being right.

<!-- nav:start -->
---

Up: [Gotchas](README.md) · Next: [The status line says "update mod", "update available" or "upgrade server"](status-line-update-mod-or-upgrade-server.md)
<!-- nav:end -->
