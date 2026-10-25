---
title: "40. A session can be recorded whole, with three yes answers (#353)"
description: "A session can be recorded whole only with three yes answers and a notice nobody can hide, at the cost of a secret that redaction may miss."
group: "Project internals"
number: 40
date: "2026-10-20"
status: "accepted"
order: 40
---

# 40. A session can be recorded whole, with three yes answers (#353)

**Context.** The Activity feed shows the last 20 short lines of a loop, and #432 (DECISIONS 39) can keep them. Neither
answers "what exactly did this agent read and run, and why". A recording keeps all of it, whole, which is the most Podium
ever holds of a conversation. The details are in [REPLAY.md](../REPLAY.md).

**Decision.**

- **Three yes answers, the third on the machine.** The Admin's `session-recording` flag, a choice of the session by its
  owner or an Admin, and the reporter's `sessionRecording` option, off by default. The option is the owner's consent and
  the browser cannot overrule it. It is a separate option, not a level of `activityFeed` or `respond`.
- **The notice is not a wall notice and cannot be hidden.** No X and no switch, on the wall or in Admin, and the owner's
  terminal is told every time. This is an approved exception to DECISIONS 22.
- **Expiry is per part.** Each part goes the Admin's keep time after it was recorded, and the time shown to a person is
  when the oldest part still held goes.
- **The mod names the sender on decisions.** An answer or approval from Podium is recorded by the mod, where it takes the
  answer and knows Claude Code took it, with the sender, never by the server.
- **A separate consent route.** `GET .../recording/consent` tells the picker whether the owner allowed recording and how
  long recordings are kept, before anything is chosen.
- **Stored apart from the main database.** In `activity.sqlite`, in their own tables, sharing DECISIONS 39's store, purge
  and Stored activity page.
- **The limits come from a measurement.** A 5 second batch, a 256 KB early flush, 512 MB for one session and 4 GB for
  all recordings, from simulated traffic (SPEC 6.4, "Measured write load").

**Why.**

- Whole prompts and results can hold anything the session saw, so each party who could be harmed by it has a switch:
  the Admin for the server, the owner for the machine, and the person choosing for the session.
- Consent that anyone could dismiss is not consent. An Admin can start a recording without the owner, so the owner has
  to see it and hear it every time.
- Per-part expiry means a short keep time is honored within a purge run, and a long recording sheds its oldest part
  instead of living until its last.
- Only the mod knows what Claude Code took. A server-written decision could claim an approval that never happened.
- The wall's `SessionView` goes to everyone, so whether the owner allowed recording cannot ride on it.
- A separate file keeps a fast-growing table out of the main database's backups, vacuum and retention.
- A batch every 5 seconds instead of every second cut the server's writes for 20 busy sessions by 29% and its CPU by 35%,
  at the price of a replay that trails by up to 5 seconds. The first defaults (256 MB, 2 GB) would have stopped a busy
  session of 8 loops after about 3.4 hours, while the trouble was still going on.

**Alternatives.**

- A level of `activityFeed` or `respond`. Rejected: neither implies recording, and recording implies neither.
- A closable notice with a switch, like DECISIONS 22. Rejected for the reason above.
- The server recording decisions as it delivers them. Rejected: it cannot tell what Claude Code took.
- Recording thinking text. Not possible today: the chunks arrive with empty text.

**Cost.**

- A recording can hold a secret that redaction missed (REPLAY.md, "What redaction does not cover"). Redaction of a very
  long line is done in pieces of 1,000 characters, so a secret across a cut can slip through.
- It is not complete. The mod's queue is bounded, a session that dies loses up to 5 seconds, and a question or permission
  prompt answered in the terminal leaves no decision row.
- Thinking text is not available, and only one model at one effort was tested.
- The limits come from simulated traffic, not real sessions, so they may change.
- The Admin can read every recording and start one without the owner, which is why the notice cannot be hidden.

<!-- nav:start -->
---

Previous: [39. The Admin can keep the activity feed, in a second SQLite file (#432)](39-the-admin-can-keep-the-activity-feed-in-a-second.md) · Up: [Decisions](README.md) · Next: [41. A Bash row opens to the whole command and its output (#431)](41-a-bash-row-opens-to-the-whole-command-and-its-output.md)
<!-- nav:end -->
