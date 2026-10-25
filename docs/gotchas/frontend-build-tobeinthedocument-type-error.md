---
title: "The frontend build says Property 'toBeInTheDocument' does not exist on type 'Assertion'"
description: "vitest 5 and jest-dom declare Assertion with different type parameters; frontend/src/jest-dom.d.ts redeclares the matchers."
group: "Project internals"
area: "Developing"
date: "2026-10-16"
status: "open"
order: 48
---

# The frontend build says `Property 'toBeInTheDocument' does not exist on type 'Assertion'`

**You see:** The frontend build fails with that TypeScript error.

**Why:** vitest 5 declares `Assertion<R, T>` with two type parameters, and `@testing-library/jest-dom` declares it with
one, so TypeScript drops jest-dom's own matcher types.

**Do:** `frontend/src/jest-dom.d.ts` redeclares them for two parameters. If a jest-dom release fixes its types, delete
that file.

<!-- nav:start -->
---

Previous: [A server test fails now and then with a 404, a 401 or a body of {}, and passes on the next run](server-test-fails-now-and-then-then-passes.md) · Up: [Gotchas](README.md) · Next: [Finished nested agents are missing from $.agent.list()](finished-nested-agents-missing-from-agent-list.md)
<!-- nav:end -->
