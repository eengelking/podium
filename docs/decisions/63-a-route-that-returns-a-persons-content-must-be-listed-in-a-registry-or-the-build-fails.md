---
title: "63. A call that returns a person's content must be listed in a registry, or the build fails (#1080)"
description: "adminReads.registry.ts lists each read of a person's content and what an Admin gets; a scan fails npm test on a read that is not listed."
group: "Project internals"
number: 63
date: "2026-11-08"
status: "accepted"
order: 63
---

# 63. A call that returns a person's content must be listed in a registry, or the build fails (#1080)

## Context

PROJECT.md says an Admin never reads a person's content in silence. The audit in #1043 found seven reads that broke that rule, and #1072 to #1082 fixed them one at a time. Each fix holds today, but nothing stops the next route from returning a message, a prompt or a tool input to an Admin with no notice. The rule was kept by a reviewer remembering it, and the audit itself was a one-off read of the route files.

## Decision

`server/src/fleet/adminReads.registry.ts` lists every call a route makes that returns a person's content. Each entry says what an Admin who makes the call gets: `told` (the read is recorded and the person is told, and a named test case signs in as an Admin and asserts it), `owner-only` (an Admin is refused, and a named case shows it) or `open` (anyone who can load the console may read it, with the decision or open issue that says so). `server/src/fleet/adminReads.test.ts` scans the route files against it, in the style of `storage/neutral.test.ts`, and fails `npm test` when:

- a route calls a listed read from a file the entry does not name;
- a store or service method that returns a row with a `text`, `prompt`, `answer`, `input`, `question` or `plan` field has no entry and is not named in `NOT_A_READ` with its reason;
- an entry is no longer true: a call, a recording call, a test case or a decision it names is gone.

The development pattern is added to `docs/PATTERNS.md`.

## Why

- A rule that has no exception needs a check with no exception. The scan costs a developer one entry when they add a read, and that is the moment they decide who is told.
- The registry is the audit, kept current. A reviewer reads one file to see every way a person's content reaches an Admin, and what each one does.
- Naming the test case ties every `told` entry to a behavior that is run, not only to a call that exists. Deleting or renaming the case fails the scan.

## Alternatives

- **A review checklist only.** It is what failed to be a check before. A reviewer finds a missing notice by luck.
- **A route inventory, with every route classified.** It catches a new route whatever it calls, but it lists 83 routes, most of which touch no content, and every one needs an entry whatever it does. The registry lists only the reads.
- **A behavior case written for each entry inside the scan test.** Each read needs its own consent, recording and session setup, which the existing tests already carry. The scan names those cases and checks that they exist.

## Cost

- The scan knows only what it can read. A read added through a method the scan does not recognise as returning content (its return type is not a row with a content field, or it returns `unknown`) is not caught, and a reviewer still has to see it. The scan covers the store interfaces and the service classes, not a read that builds its answer inline in a handler.
- The scan matches methods by name. A new store method that returns content and shares a name with a listed call (`page`, `thread`, `view`) is treated as covered, and a name in `NOT_A_READ` exempts every method of that name. A reviewer still reads a new read; the check makes a missing entry the usual case to fail, not every case.
- A developer who adds a read adds an entry and, if the Admin is told, a test case. That is the point of the check, and it is also the cost.
- `open` entries rely on the decision or issue they name to stay true. The scan checks that a decision exists, not that it still says so.

<!-- nav:start -->
---

Previous: [62. An agent's text and live activity are gated to the owner and an Admin, and the other open fleet reads stay open (#1076)](62-an-agents-text-and-live-activity-are-gated-to-the-owner-and-admin-and-the-rest-of-the-open-fleet-reads-stay-open.md) · Up: [Decisions](README.md)
<!-- nav:end -->
