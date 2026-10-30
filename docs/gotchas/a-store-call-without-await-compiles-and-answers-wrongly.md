---
title: "A store call without await compiles and answers wrongly"
description: "Every storage call returns a promise; a missing await passes the type checker. Await it, and keep Storage.tx free of other waits."
group: "Project internals"
area: "Developing"
date: "2026-10-28"
status: "open"
order: 58
---

# A store call without await compiles and answers wrongly

**You see:** A setting that is clearly stored reads as empty or as its default, an Admin action runs but leaves no line in the
Admin log, or a test fails now and then on a value that was written a moment before. Type checking and lint pass.

**Why:** Every store call is async (since #313). A promise is a valid value almost everywhere, so TypeScript accepts it in
`x ?? promise`, `!promise`, `if (promise)` and as a statement whose result is dropped. The condition is then decided by the
promise, which is always truthy, and the work runs where nothing waits for it. Two real cases came up in that change: a
settings value read without `await` answered `{}`, and two audit calls in the Admin router were not awaited, so the log line
could land after the response. Related: a `Storage.tx` callback holds the connection's lock until it returns, so a network
call, an OpenSSL run or a timer awaited inside it makes every other request wait. A read followed by a write over several
awaits is also not atomic on its own.

**Do:**

1. Put `await` on every store call. `node scripts/promise-misuse.mjs server/tsconfig.json --tests` finds a promise used in a
   condition, under `!`, `&&`, `||` or `??`, in a comparison, or left floating, and `npm test` runs it over the server and the
   scripts. A deliberate case takes `// promise-ok: <why>` on the same or the previous line; the reason is required.
2. Do the non-storage waiting before or after `Storage.tx`, never inside it.
3. Wrap a read-then-write across awaits in `tx`, or run it in a `Serializer` turn (`fleet/serial.ts`).
4. In a test, `await fleet.flush()` before checking the history, and `await fleet.init()` after building a second `Fleet` to
   stand in for a restart.

The rules are written out in [Storage](../architecture/02-components/19-storage.md#rules-for-calling-it).

<!-- nav:start -->
---

Previous: [The Activity section says to turn on activityFeed, but the option is on](activity-feed-says-turn-on-the-option-but-it-is-on.md) · Up: [Gotchas](README.md) · Next: [Blowouts 1x on a card that is nowhere near full](blowout-on-a-card-nowhere-near-full.md)
<!-- nav:end -->
