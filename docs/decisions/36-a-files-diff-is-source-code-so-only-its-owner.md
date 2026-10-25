---
title: "36. A file's diff is source code, so only its owner can open it (#319)"
description: "A file's diff is read on demand and reaches only the session's owner, redacted on the machine and never stored, at the cost of best-effort redaction."
group: "Project internals"
number: 36
date: "2026-10-18"
status: "accepted"
order: 36
---

# 36. A file's diff is source code, so only its owner can open it (#319)

**Context.** The Files tab lists what a session changed, as paths and counts (5.7). The maintainer wanted a click
to open the diff. That is source code, and the rest of the console is readable by anyone who can reach the server
(7.1), so the text could not simply join the report.

**Decision.** The text is read on demand and leaves the machine only for the session's owner.

- The owner's browser asks; the server lists the request in the next reply to the session's mod; the mod runs
  `git diff` for that one path and answers; the server hands the answer to the waiting request and forgets it.
- Three things must be on: the reporter's `fileDiff` option, the Admin's `file-diff` flag, and authentication.
  The flag and the option are off by default.
- Only the signed-in person whose name is the session's owner may ask. An Administrator who is not the owner may
  not, and neither may the admin secret, except for a session owned by `Admin`.
- The mod redacts the text before it leaves the machine, on removed lines too, and never reads the diff of a
  path such as `.env` or a key file. The server keeps nothing: not in the database, the state, the stream, a log
  line or the admin log, which records only that a path was opened and by whom.

**Why.**

- Sending every diff in every report would put all of a person's source on a server whose reads are open. On
  demand puts nothing on the server for a file nobody opens.
- Redaction on the machine means the server and the console never see a secret the rules caught, so a leak
  would need a rule to miss it.
- Owner-only, rather than owner or Admin, keeps the number of people who can read the code as small as the
  feature allows. A person who needs an Admin to see it can sign in as the owner.
- It reuses what exists: the held-request and lease shape of the activity feed, the respond sign-in and its
  cookie, the shared modal, and the feed's `[redacted]` mark.

**Alternatives.**

- Sending diffs with the report, capped. Rejected for the reason above.
- Owner or Admin, as for responding. Rejected: responding changes a session, and reading code needs a stricter
  gate than that.
- Promising no redaction and leaning on the gate alone. Rejected: a gate does not help a secret that was pasted
  into a file by accident.

**Cost.** Redaction is best effort, so a secret in a shape no rule knows can still reach the owner's browser,
and the docs say so. The high-entropy rule hides some values that are not secrets. A diff is a round trip to the
machine, so it takes a moment and fails when the machine is off. The side-by-side view is drawn twice (two panes
and one column) and CSS shows the one that fits.

<!-- nav:start -->
---

Previous: [35. Trusting a reverse proxy's client address, only when told to (#305)](35-trusting-a-reverse-proxys-client-address-only-when.md) · Up: [Decisions](README.md) · Next: [37. Orchestrators can message each other, but only one person's own (#347)](37-orchestrators-can-message-each-other-but-only-one.md)
<!-- nav:end -->
