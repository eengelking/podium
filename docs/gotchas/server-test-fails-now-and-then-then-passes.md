---
title: "A server test fails now and then with a 404, a 401 or a body of {}, and passes on the next run"
description: "supertest can reach another process on 127.0.0.1; keep testSetup.ts in the vitest setup files and bind test servers to 127.0.0.1."
group: "Project internals"
area: "Developing"
date: "2026-10-14"
status: "open"
order: 47
---

# A server test fails now and then with a 404, a 401 or a body of `{}`, and passes on the next run

**You see:** A server test fails once, then passes on a rerun.

**Why:** supertest listens on the wildcard address and then connects to `127.0.0.1`. On macOS, if another process holds
`127.0.0.1:P`, the wildcard bind of the same port `P` still succeeds, and connections to `127.0.0.1:P` go to the other
process. So a busy machine (the full run's own workers, the container, a second run, a browser) sometimes answers a
test's request with someone else's server (#137).

**Do:** The fix is already in place. Keep it working:

- `server/src/testSetup.ts` makes a bare `listen(0)` bind `127.0.0.1`. Vitest loads it for every file. A new test setup
  file that replaces `setupFiles` must keep `testSetup.ts` in the list.
- A test that starts its own server should say `127.0.0.1` too.
- It binds with Node's internal `_listen2`, because supertest reads the port the moment `listen(0)` returns and a public
  `listen(0, '127.0.0.1')` is not synchronous. `testSetup.test.ts` fails if a Node upgrade breaks that.

To check for the flake, run several full runs at once. Before the fix, six loops of `npx vitest run` in parallel failed
about 7% of runs, and none of 60 failed after. Keep it to three loops.

- Let the sockets drain between rounds (`netstat -an -p tcp | grep -c TIME_WAIT` under a few
  hundred).
- A run opens about 3,000 connections and macOS has about 16,000 ephemeral ports. With vitest 5, six loops run out of
  them and fail with `listen EADDRNOTAVAIL 127.0.0.1` all over the suite. That is the machine, not a test.
- One real timing flake remains: `shipper.test.ts` "sends a full batch on its own" waits a fixed 20 ms for a gzip to
  finish and fails now and then under load, on vitest 2 as well.

<!-- nav:start -->
---

Previous: [A prompt sent to Claude Code with tmux send-keys stays in the box unsent](tmux-send-keys-prompt-stays-unsent.md) · Up: [Gotchas](README.md) · Next: [The frontend build says Property 'toBeInTheDocument' does not exist on type 'Assertion'](frontend-build-tobeinthedocument-type-error.md)
<!-- nav:end -->
