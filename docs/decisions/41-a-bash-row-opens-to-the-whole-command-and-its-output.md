---
title: "41. A Bash row opens to the whole command and its output (#431)"
description: "A Bash row opens to its whole command and output, with output behind its own switches, held in memory only and captured only for a live viewer."
group: "Project internals"
number: 41
date: "2026-10-21"
status: "accepted"
order: 41
---

# 41. A Bash row opens to the whole command and its output (#431)

**Context.** The Activity feed showed a Bash call as one line cut to 300 characters, with no result. A person had to open
the terminal to see whether a command worked. #432 and #353 changed what the feed may keep since the issue was written,
so some of its first assumptions (output "in memory only", captured "only for a watched loop") no longer hold as written.

**Decision.** Every Bash row is closed by default (only Bash: the mod sends a whole command and output for no other tool). A click on the
row opens it to the whole command, then the output with its exit status (a bare check for exit 0, a cross and "Exit N,
failed" otherwise); a second click or the Collapse button closes it. Command and output wrap. The same row serves the
agent panel, the Expand modal, the Respond modal and the session-recording replay. The replay shows the result its
recording already holds (#353); it adds no second copy.

- **Two switches.** The whole command rides the existing `activityFeed` option and `activity-feed` flag. Output has its own
  reporter option and its own Admin feature flag, both off by default.
- **Output is never stored.** It is not in `podium.sqlite`, `activity.sqlite`, the state, the stream or the logs. The server
  holds it in memory only, on the feed's lease. A test checks that a secret in output is found in none of them.
- **Output is captured only while a viewer has the feed open.** A keep policy under #432 lists a loop as watched with no
  viewer; that listing never asks the mod for output; only a live viewer lease does. The reply carries a second list,
  `watchOutput`, a subset of `watch` made only of loops under a live lease while the `activity-output` flag is on. The
  mod captures output for a loop only when it is in `watchOutput` and its `activityOutput` option is on. Extending
  `watch` was rejected: it mixes lease loops with history loops, so the mod could not tell a viewer from a keep
  policy. A reply field is the smallest change: an older server sends none, which the mod reads as "no output".
- **The entry fields.** `id` (the tool call's id, so output that arrives after the entry first went out is matched to
  its entry, and the console can key an open row), `command`, `commandCut`, `output`, `outputCut`, `done`, `exitCode`
  and `failed`, all optional. Stdout and stderr go in one `output` (stdout first). Claude Code's Bash result type has
  `stdout`, `stderr` and `interrupted` but no exit code; the mod reads `isError`, and an `exitCode` only if the result
  text gives one, so `failed` may be true with no `exitCode`. The Admin flag is `activity-output`, "Bash output in the
  activity feed"; the reporter option is `activityOutput`, "Send a Bash command's output" (mockup
  `mockup/podium-feed-expand-admin.html`, approved).
- **The command is kept.** The Activity history (#432) stores the whole command, redacted and cut at 20,000 characters with
  a visible `[cut off at 20000 characters]` marker.
- **Limits.** Command 20,000 characters and output 20,000 characters per entry, each with the marker, the same size as the
  full prompt cap (`fullText`). The report-wide 60,000-character cap (`activityChars`) stays as it is for the 300-character
  summaries; commands and output count against a separate per-loop budget, because 20 entries of 40,000 characters each
  would be 800,000 characters and the old cap would drop nearly all of them. The budget is 200,000 characters of commands
  and output per report (`LIMITS.activityDetailChars`), shared over the orchestrator and the agents, the orchestrator
  first, each from its newest entry back. An entry that does not fit loses its output, then its command, and keeps its
  summary. Why 200,000: it holds ten whole entries (a 20,000-character command and output), enough for a window of
  recent work, and with the 60,000 of summaries and the 120,000 of full text it stays near 380,000 characters, under
  the 512 KB body limit (`BODY_LIMIT`) for ordinary text. JSON escaping and non-ASCII text can push it past that, so
  the mod must also check the serialized size of a report, as the recording does at 480,000 bytes, and drop output
  first when over.
- **Claude Code's own cut.** A Bash result of about 90 KB or more arrives as a short `<persisted-output>` stub. The row
  shows what the mod received, so for that case it shows the stub.
- **Redaction.** `redactBounded` in `mod/podium-reporter/hooks/recording.ts`, as the recording uses. No third approach.

**Why.**

- Output holds more than a command does (file contents, environment dumps, tokens the redactor does not know), so it
  gets its own consent and its own default, apart from the command.
- Capturing only for a live viewer keeps a keep policy from turning every running loop into a standing copy of its output.
- Not storing output means the Admin's retention and size cap never have to account for it.

**Alternatives.**

- Output on the `activityFeed` option. Rejected: it would grant output to everyone who allowed the command line.
- Storing output under the keep policy, as #353 does for recordings. Rejected: a recording has its own three yes answers;
  the feed does not.

**Cost.**

- Redaction in 1,000-character pieces can miss a secret across a cut (see `docs/REPLAY.md`), and it hides some harmless
  long lines as `[redacted]`.
- A person who opens a row after the command finished may find no output, because it was not captured before the feed
  was open.
- A result over about 90 KB shows a stub, not the output.

**Amended (#598): a finished call says so, with or without output.** Under #431 a Bash entry got `done` only together with
output, so a call still running and one that finished before the panel opened looked alike, and the row said "Output was
not collected." for both.

- **What the mod sends.** While `activityFeed` is on, the mod sends `done`, `failed` and `exitCode` on a Bash entry
  whenever the call finishes, with or without output. Output itself is unchanged: it still needs the `activityOutput`
  option, the `activity-output` flag and the loop in `watchOutput`.
- **What the server does.** It keeps the three fields with the entry in memory, as it keeps the rest of the entry. The
  Activity history stores none of them; it stores only the whole command, as before.
- **What the row says.** No `done` and the loop active: "Running." and the word running on the line. `done` with no
  output: "Output was not collected." and the status mark (a bare check for exit 0, a cross and "Exit N, failed" or
  "Failed"), on the line and beside Output. No `done` and the loop not active: "Output was not collected." with no mark,
  a stale call whose end was never reported.
- **An older mod.** It sends no `done` without output, so its rows keep today's wording: running while the loop is
  active, otherwise "Output was not collected." with no mark. An older server drops `done`, `failed` and `exitCode`
  from a session that does not report `activityOutput: true`, so it ignores the new use and its rows stay as they
  were; with the option on it keeps them, which only helps. Neither case is an error, since the fields are optional on
  the entry.
- **A call that throws.** It returns no result, so the mod marks nothing: `done` stays unknown, and the row reads as
  it does for a stale call. A denied call is `done` and `failed` as before, and its reason is output, so it is sent
  only with the output switches on.
- **Running or stale (console).** Only the newest entry of the feed can read as running: a Bash call with no `done`
  and no output, last in the list, in a loop that is working. An older mod never sends `done` without output, so any
  earlier call with none may have finished long ago; a later entry, text included, means the call returned. A call
  that runs beside another reads as not collected until it reports, which claims nothing false. The flag and option
  wording stay ahead of "Running.", since output will not come; the line still says running. The replay is unchanged:
  it knows from the recording whether a call has a result and never says running.
- **Why.** The mod knows when a call ends; the server cannot tell a finished call from a running one without being told.
  The mockup is `mockup/podium-feed-expand.html`, "Rows without output".

<!-- nav:start -->
---

Previous: [40. A session can be recorded whole, with three yes answers (#353)](40-a-session-can-be-recorded-whole-with-three-yes.md) · Up: [Decisions](README.md) · Next: [42. Podium makes its own CA, and the reporter authenticates with a certificate (#577)](42-podium-makes-its-own-ca-and-the-reporter.md)
<!-- nav:end -->
