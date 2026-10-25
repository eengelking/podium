---
title: "32. Throttling wrong admin-secret guesses on the report routes (#255)"
description: "A per-address throttle counts distinct wrong admin-secret guesses on the report routes, never person tokens, but can lock out a reporter on a shared address."
group: "Project internals"
number: 32
date: "2026-10-16"
status: "accepted"
order: 32
---

# 32. Throttling wrong admin-secret guesses on the report routes (#255)

**Context.** Admin's unlock and the console sign-in lock a source after five wrong tries, but
`X-Podium-Token` on `POST /report`, `POST /hook`, `DELETE /sessions/:id` and the mod's respond routes had no
limit, and a secret found there opens Admin (31). Counting those in the shared lockout would let one
reporter with a stale token lock out every other reporter on `127.0.0.1`.

**Decision.** A separate throttle per source address (`GuessThrottle`).

- It counts *distinct* wrong values (kept as hashes), locking at five for 15 minutes.
- A person's token is never counted or throttled. It has 192 random bits, so it cannot be guessed, and stale
  or revoked ones are the common misconfiguration.
- While throttled, any non-person credential gets `429` with `Retry-After`, including the right admin
  secret.
- A short `PODIUM_TOKEN` (under 24 characters) is warned about at start.

**Alternatives.**

- Counting every wrong token in the shared lockout (the stale-reporter lockout above).
- A throttle that lets the right secret through while locked, which would let a guesser learn the right one
  from the one response that differs, so it limits nothing.
- Delaying wrong answers instead of refusing, which holds connections open.

**Cost.**

- An attacker who shares an address with an admin-secret reporter can lock that reporter out for 15 minutes
  (its reports are retried about once a minute and recover when the lock ends).
- Reporters with a person's token are untouched, which is another reason to give each person one rather than
  reporting with the admin secret.
- Behind a container's port mapping or a proxy, clients may all show one source address and then share one
  throttle. The Admin lockout already has the same limit, and Podium sets no `trust proxy`.
- The counter is in memory, so a restart clears it.

<!-- nav:start -->
---

Previous: [31. Security sweep (#249): what was found, what was fixed, what is accepted](31-security-sweep-what-was-found-what-was-fixed-what.md) · Up: [Decisions](README.md) · Next: [33. Refusing a Host the server does not expect (#256)](33-refusing-a-host-the-server-does-not-expect.md)
<!-- nav:end -->
