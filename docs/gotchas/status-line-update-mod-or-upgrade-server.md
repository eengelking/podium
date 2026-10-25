---
title: "The status line says \"update mod\", \"update available\" or \"upgrade server\""
description: "The mod and server versions are out of step; update the mod and run /reload-plugins, or upgrade the server."
group: "Project internals"
area: "Connecting the mod"
date: "2026-10-13"
status: "open"
order: 2
---

# The status line says "update mod", "update available" or "upgrade server"

**You see:** The status line ends in `· update mod`, `· update available` or `· upgrade server`, or a card is
marked `· update` or `· upgrade server`. The status line always starts with the mod's version, for example
`podium v0.11.1 ● 3 live`.

**Why:** The server and the mod are released separately, and the server keeps a range of mod versions it reads
correctly (SPEC 6.8).

| Message | Meaning |
|---|---|
| `update mod` | The mod in this session is older than the range. |
| `upgrade server` | The mod is newer than the range. |
| `update available` | The mod is inside the range, but the server supports a newer `major.minor`, so a newer mod exists. |

Reports still arrive in every case. Only `major.minor` is compared, so a patch release never triggers a message.
A version the server cannot read (the simulator's `0.1.0-sim`) shows nothing. A mod older than 0.3.0 cannot show the
message itself, but the console still marks its card.

**Do:** For `update mod`, update the mod, then reload it in the session. A running session keeps the version it loaded
until you do.

```sh
claude plugin update podium-reporter@eengelking-marketplace
```

Then run `/reload-plugins` in the session. If the update says it is already at the latest version, refresh the listing
first with `claude plugin marketplace update eengelking-marketplace`. `/podium` prints both versions, which tells you
which way you are out of step. The full steps are in [Updating the mod](../user-guide/09-updating-the-mod.md).

<!-- nav:start -->
---

Previous: [/podium says "offline" and "Last error: HTTP 401"](podium-offline-http-401.md) · Up: [Gotchas](README.md) · Next: [The token option has no row in the /config menu](token-option-missing-from-config-menu.md)
<!-- nav:end -->
