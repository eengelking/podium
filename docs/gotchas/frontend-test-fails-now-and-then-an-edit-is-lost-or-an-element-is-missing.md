---
title: "A frontend test fails now and then, with an edit put back or an element not found, and passes on the next run"
description: "React 19 runs a component's mount effects after the commit; keep the idle wait in setupTests.ts so findBy and waitFor settle before a test edits."
group: "Project internals"
area: "Developing"
date: "2026-10-30"
status: "open"
order: 61
---

# A frontend test fails now and then, with an edit put back or an element not found, and passes on the next run

**You see:** An Admin or top-bar test fails once and passes on a rerun, a different test each time. The message is
"Unable to find role=alert", a count that is still the old one, or a Save that finds nothing to save. It happens more on a
slow machine and on the CI runner.

**Why:** React 19's scheduler yields to the browser after every commit, so a component's `useEffect` callbacks run in a
later task than the commit that drew it. React 18 ran most of them in the same task. A `findBy` or `waitFor` can return as
soon as the page changes, and a test that then edits a form does it while the form's mount effects are still waiting. A
form that copies its saved settings into a draft in an effect (`PeerLimitRow`, `HistoryForm`, `DaysRow` and others) then
writes the saved value back over the edit. A count that a list pushes up through an effect is just as likely to be read
before it arrives. Whether the effect or the test's next step goes first depends on a 1 ms clock, so it comes and goes (#290).

**Do:** The fix is already in place. Keep it working:

- `frontend/src/setupTests.ts` wraps Testing Library's async wrapper so every `findBy` and `waitFor` also waits until
  React's scheduler has nothing left to run. A new setup file that replaces `setupFiles` must keep it, and `scheduler`
  stays a dev dependency of the frontend because the wrapper imports it.
- Do not add `await act(async () => {})` to a test to cover the same gap. It waits for one task, the scheduler can yield
  again, and it has to be repeated in every test, so the next unpatched one fails instead.
- Wait for what the test depends on. If an assertion reads something a different request brings (a count from another
  list), wrap it in `waitFor`.
- The standards pages are built from the same renders, so `renderSample` (`standards/build.tsx`) waits the same way, and an
  Admin screen waits for the count its sample shows.

To check for the flake, run the six Admin files at once: `npx vitest run` on `messaging`, `certificates`, `activityVerify`,
`admin`, `activityHistory` and `pagePill`, twelve copies in parallel, for a few rounds. Before the wait, 12 of 96 such runs
failed; with it, none of 48 did. One run at a time hides it.

<!-- nav:start -->
---

Previous: [Listening on a .sock path fails with EACCES on Windows, whatever the folder](listening-on-a-sock-path-fails-with-eacces-on-windows.md) · Up: [Gotchas](README.md) · Next: [npx tsc prints Version 6 although the project is on TypeScript 7](npx-tsc-says-version-6-but-the-project-is-on-typescript-7.md)
<!-- nav:end -->
