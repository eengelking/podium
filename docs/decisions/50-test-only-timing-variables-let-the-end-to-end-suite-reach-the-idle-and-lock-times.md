---
title: "50. Test-only timing variables let the end-to-end suite reach the idle and lock times (#791)"
description: "Three environment variables shorten the Admin idle lock, the sign-in idle end and the lockout for a test server, behind one flag; there is no clock."
group: "Project internals"
number: 50
date: "2026-10-29"
status: "accepted"
order: 50
---

# 50. Test-only timing variables let the end-to-end suite reach the idle and lock times (#791)

**Context.** Three states of the sign-in could not be tested in a browser because their times were fixed in the code: Admin locks after 10 idle minutes, a sign-in to respond ends after 12 idle hours, and five wrong tries lock an address for 15 minutes (the lock is shared by Admin's unlock and the console's sign-in to respond). DECISIONS 49 left them out and tracked them in #791.

**Decision.** Each time has a test-only environment variable, read once at start by `parseTestTimings` in `server/src/testTimings.ts`.

- `PODIUM_TEST_ADMIN_IDLE_MS`, `PODIUM_TEST_SIGN_IN_IDLE_MS` and `PODIUM_TEST_LOCK_MS` are whole milliseconds, 1 to 999999999.
- They count only when `PODIUM_TEST_TIMINGS=1`. A timing set without the flag, a bad value, or a flag that is not `0` or `1` stops the server at start, the way a bad `PODIUM_FAILURE_LIMIT` does. A stray variable can never shorten the lock of a real server.
- When any is active, the server logs a `warn` event `server.test_timings` that says never to set it on a real server.
- The number of wrong tries stays 5, and the defaults stay 10 minutes, 12 hours and 15 minutes. A unit test pins them.
- The server's code reads the numbers it is given and has no other path to them. Nothing a person sees changes.
- The end-to-end specs `admin/idle-lock.cy.js`, `admin/lockout.cy.js` and `respond/sign-in-idle.cy.js` restart the throwaway server with the variables through `cy.resetServer({ env: [...] })`. `scripts/e2e-up.sh` already passes `env=` through, so it did not change.

**Why.**

- Three numbers read at start are the smallest change that makes the states reachable, and the code they feed is the code that runs in production.
- The flag makes the variables inert unless someone says they are for a test, and a mistake is loud at start instead of quiet in production.

**Alternatives.**

- A test clock (inject or fake `Date.now`) would let a spec jump forward, but every place that reads the time would have to take it, and it would make the server's behavior depend on a second source of time. It would also reach the one-hour Silent state and the 24-hour Traffic range, which this change does not. Those stay open in the coverage map.
- Unit tests only leave the browser side unchecked: the lock screen, the message and the return to a signed-out page.
- Waiting the real times is not possible: 12 hours cannot be a spec.

**Cost.**

- Three more variables in `index.ts` and one flag to explain. They are not in `docs/SERVER.md`'s settings table, because no person should set them.
- The sign-in idle spec takes about 70 s, because the page checks its sign-in once a minute. The Admin idle lock spec takes about 12 s and the lockout spec about 8 s.
