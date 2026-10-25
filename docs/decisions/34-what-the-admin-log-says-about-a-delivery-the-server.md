---
title: "34. What the Admin log says about a delivery the server lets go of (#333, #334, #329)"
description: "The Admin log writes one respond_dropped row for each delivery the server lets go of, with no text, at the cost of many rows when responding is turned off."
group: "Project internals"
number: 34
date: "2026-10-16"
status: "accepted"
order: 34
---

# 34. What the Admin log says about a delivery the server lets go of (#333, #334, #329)

**Context.** #304 made the Admin log follow an answer from `respond_sent` to what became of it. Three ways to
lose one still left the log ending at `respond_sent`:

- the session was deleted (`dropSession`)
- responding was turned off (`clear`)
- a message the session had queued when it ended

A retried final result also answered `404`, and #327 left open whether it should answer `200`.

**Decision.** Each of those writes one `respond_dropped` row per delivery that has no result yet, with the
sender as actor and the short delivery id, never the text.

- The reasons are "the session was deleted first" and "responding was turned off first" (both "before any
  result came back", since a handed-over answer may have reached the session). For a queued message at
  session end the reason is "the session ended while it was still queued, so Podium cannot tell whether it
  was read".
- A delivery with a result already has its row. `endSession` followed by `dropSession` writes one row, not
  two.
- Turning responding off writes a row for each delivery, not one row with a count. The row's value is that
  its id pairs with the `respond_sent` row, and a count cannot be paired. The noise is bounded by what was
  waiting (at most the per-session message limit plus one answer per open ask).
- For the retry, `404` is the contract. The mod drops a queued result on any response, so a `404` is not
  retried, and a finished-delivery record would add memory state and a clear path for no visible gain.

**Alternatives.**

- One summary row for `clear()`.
- Answering `200` to a retried final result from a bounded record of finished ids.
- A `respond_result` row for a queued message at session end, which would claim an outcome Podium never saw.

**Cost.** Turning responding off with many waiting items writes many rows. A mod that is not the bundled one
and retries on `404` would retry once per tick until its own limit.

<!-- nav:start -->
---

Previous: [33. Refusing a Host the server does not expect (#256)](33-refusing-a-host-the-server-does-not-expect.md) · Up: [Decisions](README.md) · Next: [35. Trusting a reverse proxy's client address, only when told to (#305)](35-trusting-a-reverse-proxys-client-address-only-when.md)
<!-- nav:end -->
