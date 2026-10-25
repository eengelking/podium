---
title: "npm run test:mod fails with 'Permission to use AskUserQuestion has been denied'"
description: "A fake tool.check that answers ask is denied by Claude Code 2.1.310's test engine; the mod's tests answer allow and set ask only where a test needs it."
group: Project internals
date: 2026-10-25
status: fixed
fixed_in: "#718"
area: Developing
order: 53
---

# npm run test:mod fails with "Permission to use AskUserQuestion has been denied"

**You see:** `npm run test:mod` fails 30 or so tests in `respond.test.ts`, `recordingAnswers.test.ts` and
`peersMod.test.ts`, with `TypeError: w.dialog.resolve is not a function` or an answer that is `undefined`. A call the
test makes returns "Permission to use AskUserQuestion has been denied".

**Why:** Those tests fake `tool.check` and answered `ask`. Claude Code 2.1.310's test engine decides an `ask` itself,
with nobody to approve it, and denies the call before it reaches the test's `tool.call` handler. Claude Code 2.1.301,
where the tests were written, passed an `ask` through. The failures were the same on `v1.3.0` and on `development`
because the engine changed, not the mod. `test:mod` does not run in CI, so nothing showed it until a release was
prepared (#718).

**Do:** In a test that fakes `tool.check`, answer `allow` and set `ask` only in the test that calls `$.tool.check`
and needs one (`checkDecision.value = 'ask'` in `respond.test.ts`). Two tests in `register.test.ts` also hard-coded
the mod's version; they read `VERSION` from `register.ts` now, so a release does not break them.
