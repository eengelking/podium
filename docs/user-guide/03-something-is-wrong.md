---
title: "Something is wrong"
description: "Match what you see to its likely cause and fix, from a missing session to a refused report."
group: "Getting started"
order: 3
---

# Something is wrong

Find what you see, then follow the fix. [docs/gotchas/](../gotchas/README.md) has more.

| You see | Likely cause and fix |
|---|---|
| `/podium` says offline, `HTTP 401` | The token is missing, wrong or revoked, or it does not belong to the `userName` setting. Run `podiumctl token`, then `/plugin configure`. On a shared server, ask the owner for a new token |
| `/podium` says offline, no 401 | The server is not running. Run `podiumctl status`, then `podiumctl start` |
| The wall is empty | No session has the mod loaded yet, its token is wrong, or none has been sent a prompt |
| A new session is not on the wall, or its status line says `podium ● 0 live` | It has not done anything yet. Send a prompt |
| A session I closed is still on the wall | It moved to the background. `claude agents` lists it and `claude stop <id>` ends it. See [Closing a background session](04-reading-the-console/09-closing-a-background-session.md) |
| A card turned stale | The session stopped reporting (closed, crashed or lost the connection). It goes away by itself, or press Remove |
| I changed the config and nothing happened | Run `podiumctl restart` |
| The status line names a certificate, the config file or `node` | Your server uses built-in TLS. See [what each message means](../REPORTER.md#over-tls) |
| The browser cannot open the `https://…:4318` address | That port is for reporters only and needs a reporter certificate. Open the console at `http://<host>:4317`. See [Built-in TLS](../SERVER.md#built-in-tls) |
| `/podium` says `offline, retrying` with `Last error: HTTP 502` and a `TLS:` line | The reporter's connection helper answered, not the server. The `TLS:` line gives the reason, such as an expired certificate. See [what each message means](../REPORTER.md#over-tls) |
| A card shows `reporter 0.1.0 · update`, the top bar says reporters need an update, or the status line ends in `· update mod` | The mod in that session is older than the server supports. It keeps reporting meanwhile. See [Updating the mod](09-updating-the-mod.md) |
| The status line ends in `· update available` | Your mod works, but the server supports a newer one. See [Updating the mod](09-updating-the-mod.md) |
| A card or the status line shows `· upgrade server` | The mod is newer than the server supports. Upgrade the server (see [Updating the mod](09-updating-the-mod.md)) |
| The status line starts with `⚠` (`⚠ podium v1.1.0 ● 6 live`) | The mod's server URL is `http://` to another machine, so its token is not encrypted in transit. Put a TLS proxy in front of Podium (and [tell the server to trust it](../SERVER.md#behind-a-reverse-proxy)) and set the server URL to `https://...` in the podium-reporter settings, or accept the risk on a network you trust. Reporting continues |

**Asking for help or filing a bug.** Include the output of `/podium` and of `podiumctl status`.

1. Type `/podium` inside the Claude Code session that shows the problem. It is not a shell command like `podiumctl`.
2. Paste what it prints, with the output of `podiumctl status`.

The `Connection:` and `Versions:` lines say whether the mod is online, refused or out of step with the server. It does
not print your token, but check what you paste and remove any token or other secret before posting.

<!-- nav:start -->
---

Previous: [Set it up](02-set-it-up.md) · Up: [User guide](README.md) · Next: [Reading the console](04-reading-the-console/README.md)
<!-- nav:end -->
