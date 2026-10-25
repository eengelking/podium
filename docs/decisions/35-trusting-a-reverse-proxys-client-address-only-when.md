---
title: "35. Trusting a reverse proxy's client address, only when told to (#305)"
description: "PODIUM_TRUST_PROXY names the proxy hops to trust, off by default and never true, so the owner must know the proxy's address or hop count."
group: "Project internals"
number: 35
date: "2026-10-18"
status: "accepted"
order: 35
---

# 35. Trusting a reverse proxy's client address, only when told to (#305)

**Context.** Podium set no `trust proxy` (31, 32). Behind the TLS proxy the docs recommend, `req.ip` was the
proxy for every request: the admin log's `source` showed the proxy, the Admin and sign-in lockout and the
admin-secret throttle were shared by everyone behind it, and `req.secure` was false, so the session cookies
were not `Secure`.

**Decision.** `PODIUM_TRUST_PROXY` names the hops to trust and goes to Express `trust proxy` (7.7). Off by
default. It takes a hop count, or addresses, CIDR ranges and `loopback`, `linklocal`, `uniquelocal`.

**Why.**

- Express already does the right thing for a named hop: it reads `X-Forwarded-For` from the right and stops at
  the first address it does not trust, so a value a client put to the left of the proxy's is ignored.
- `true` is refused. It trusts every hop, so any client could send its own `X-Forwarded-For` and pick its
  source, which defeats the lockouts and falsifies the audit. A setting that can be turned into that by one
  word should not accept the word.
- A malformed value stops the server at start, since trusting nothing silently would leave the lockouts shared
  and trusting too much would leave them spoofable.
- Off by default keeps a server with no proxy exactly as it was.

**Alternatives.**

- Accepting `true`, as Express does.
- Reading `X-Forwarded-For` ourselves, which repeats `proxy-addr` with fewer checks.
- Turning trust on when the bind is loopback, which guesses that a local listener is a proxy.

**Cost.** The owner has to know their proxy's address or hop count and must name only a proxy that overwrites
`X-Forwarded-For`. A hop that passes a client's header through lets that client choose its source. The
setting needs a restart.

<!-- nav:start -->
---

Previous: [34. What the Admin log says about a delivery the server lets go of (#333, #334, #329)](34-what-the-admin-log-says-about-a-delivery-the-server.md) · Up: [Decisions](README.md) · Next: [36. A file's diff is source code, so only its owner can open it (#319)](36-a-files-diff-is-source-code-so-only-its-owner.md)
<!-- nav:end -->
