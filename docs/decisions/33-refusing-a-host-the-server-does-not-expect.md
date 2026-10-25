---
title: "33. Refusing a Host the server does not expect (#256)"
description: "The server answers 403 to a Host it does not expect, to stop DNS rebinding, so reaching it by a name needs PODIUM_ALLOWED_HOSTS and a restart."
group: "Project internals"
number: 33
date: "2026-10-16"
status: "accepted"
order: 33
---

# 33. Refusing a Host the server does not expect (#256)

**Context.** The reads take no token (7.1), and the server did not look at `Host`. A page on another site can
rebind its own name to `127.0.0.1` and then read the fleet, including every agent's prompt and answer, as its
own origin. It cannot reach Admin or respond, which need a cookie that rebinding never carries (31).

**Decision.** A check ahead of every route answers `403` to a `Host` that is not a loopback name or address,
the bound address, or a name in `PODIUM_ALLOWED_HOSTS` (7.7). `localhost` always works, with nothing to list.

**Why.** A server bound to `0.0.0.0` (or `::`) allows any IP-literal `Host` by default:

- What a rebinding page controls is a DNS name, and the browser sends that name in `Host`. An address typed
  in the bar is not resolved, so no other site can make a browser send one for this server, and allowing it
  costs nothing.
- Refusing addresses on a wildcard bind would break the supported `--bind 0.0.0.0` use for no gain, and
  would make the owner list every address the machine has.
- A name is never allowed unless listed, on any bind.
- On a specific bind (`--bind 192.168.1.5`) only that address is allowed, besides loopback.
- In container mode the server cannot see the host's bind address (it listens on `0.0.0.0` inside), so it
  takes any address there. The container's published port is still limited to the bind address by Podman.

**Cost.** Reaching a server by a name (`box.lan`, a reverse proxy's name) needs `PODIUM_ALLOWED_HOSTS` and a
restart, and a reverse proxy that rewrites `Host` has to send a name that is listed. A request with no `Host`
(HTTP/1.0) is refused.

<!-- nav:start -->
---

Previous: [32. Throttling wrong admin-secret guesses on the report routes (#255)](32-throttling-wrong-admin-secret-guesses-on-the-report.md) · Up: [Decisions](README.md) · Next: [34. What the Admin log says about a delivery the server lets go of (#333, #334, #329)](34-what-the-admin-log-says-about-a-delivery-the-server.md)
<!-- nav:end -->
