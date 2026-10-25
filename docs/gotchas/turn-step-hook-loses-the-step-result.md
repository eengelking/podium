---
title: "A turn.step hook that reads the stream loses the step's result"
description: "A for await loop throws away the stream's return value; read the result from await stream.result after the loop."
group: "Project internals"
area: "Developing"
date: "2026-10-13"
status: "open"
order: 50
---

# A `turn.step` hook that reads the stream loses the step's result

**You see:** Every watched step reports no usage, no stop reason and no blowout.

**Why:** `turn.step` is a streaming hook. `yield* next(e)` passes the chunks on and evaluates to the step's result, but
`for await (const chunk of next(e))` throws the result away, because a generator's return value is not a value of the
loop. The activity feed (#118) has to see the text chunks, so for a watched loop the reporter keeps the stream, reads it
with `for await`, yields each chunk on as it came, and then takes the result from `await stream.result`. Only a watched
loop takes this path. Every other step still uses `yield* next(e)`.

**Do:** Do not forget `await stream.result` after the loop. The same applies to a test that drives `$.turn.step` by hand:
read it with `next()` until `done`, as `stepOnce` in `register.test.ts` does.

<!-- nav:start -->
---

Previous: [Finished nested agents are missing from $.agent.list()](finished-nested-agents-missing-from-agent-list.md) · Up: [Gotchas](README.md) · Next: [A mod fix did not reach anyone](mod-fix-did-not-reach-anyone.md)
<!-- nav:end -->
