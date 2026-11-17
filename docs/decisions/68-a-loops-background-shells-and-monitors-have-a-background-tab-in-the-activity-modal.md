---
title: "68. A loop's background shells and monitors have a Background tab in the Activity modal (#897)"
description: "The Activity modal lists the shells and monitors one loop started, with output behind its own switches, held in memory only and read for a live viewer."
group: "Project internals"
number: 68
date: "2026-11-17"
status: "accepted"
order: 68
---

# 68. A loop's background shells and monitors have a Background tab in the Activity modal (#897)

**Context.** An orchestrator with background shells running showed a blue indicator and nothing else. A person could not tell how long a shell had run,
what state it was in, or whether it was stuck, because a background shell is not a foreground `Bash` row and #431's expandable row never reached it. The
research (the comment on #897, Claude Code 2.1.326 and OpenCode 2.2.5, each checked live) found what each harness reports: both give a shell's command,
state, owner and an output file; OpenCode also reports a start time and an exit event; Claude Code has monitors and OpenCode has none.

**Decision.** The Activity modal gets a second tab, **Output | Background**. Output is the existing feed, unchanged. Background lists the shells and
monitors **one loop** started, in the feed's own rows, and is mirrored on the feed everywhere else: the one modal and its height, the Refresh every select,
the footer lines, the scroll that follows the newest row and its "Jump to latest", and the message box only in an orchestrator's modal.

- **Scope is per agent, not per owner.** The modal is opened for one orchestrator, subagent or fork and lists what that agent started. There is no owner line
  and no owner filter. The reporter still attributes each item to the agent that started it (Claude Code: `agentId` on the starting call, or the hook's
  agent for a task it did not see start; OpenCode: the session in `shell.created`), because that is how an item reaches the right agent's modal. This
  replaces the issue's first "every owner" wording.
- **Switches.** The list (label, state and times) rides `activityFeed`, as the feed does. The whole command and the output have their own reporter option,
  `backgroundOutput`, and their own Admin flag, `background-output`, both off by default, and are sent only for a loop in the reply's `watchBackground`, the
  loops under a live viewer lease. A separate field, as DECISIONS 41 did, because the lease loops and the keep-policy loops must stay apart.
- **This changes SPEC 5.3.** The rule "a shell's command is never kept" held for the waiting state (#119, #128), which still names a task by its first word.
  The whole command now goes, but only under the same consent as the shell's output, and in `backgroundItems`, never in `background`.
- **Held in memory only.** On the server with the loop's activity lease. Nothing of an item is in a database, the state, the stream or a log, and a test
  finds a secret printed by a shell in none of them. Output is redacted with `redactBounded` and cut at 20,000 characters, from the front, with a visible marker.
- **Limits.** A loop sends every running item and the 20 latest finished ones (at most 60); a report keeps commands and output within 200,000 characters.
  There is no "Show older": nothing is stored, so there is nothing older to fetch.
- **An Admin never reads in silence.** The list and the output reach the console through the activity route, whose read by an Admin is recorded in the Admin
  log (who, whose and when, never the text), told to the person in the console and in `podium-reporter` (#1082). No second path exists.
- **What a harness cannot say, the console says.** A time is "first seen" where the harness reports no start time (Claude Code). A shell that ended with no
  exit code reads "Ended without an exit code", never "killed". OpenCode says in words that it has no monitors. An older reporter says it does not send
  background items. A finished item's run time comes from `endedAt`, which the reporter sets when it learns the item ended.
- **Quiet.** A running item whose last output is 5 minutes old or more reads "Quiet for N min" under its state, with a shape and the warning color. An item
  whose reporter cannot read the file has no time of last output and is never called quiet.
- **Reading the files.** Only the file the harness itself named is read, and only after it is checked to be a regular file inside the folder the harness
  writes in, not a link (a Claude Code subagent's `.output` links to its transcript). OpenCode's `info.file` must end in `.out`; Claude Code's id must be
  a short token, and the file is `<tasks folder>/<id>.output`. The rules are in `plugin/core/background.ts`, over a file system each harness passes in,
  because the Claude Code mod has no Node. A timer reads a watched loop's files every 3 seconds, so a shell that ended during a long turn does not look
  alive until the next Stop.

**Why.**

- A command and its output are the person's own content, so they get the consent, the memory-only holding and the Admin notice DECISIONS 41 and #1082 set.
- Mirroring the feed means a person who moves between the two tabs finds the same modal, and the code is the feed's own.
- One shared core means both harnesses cut, redact and word an item the same way.

**Alternatives.**

- Every owner's items in one list with an owner filter. Rejected by the maintainer: the Activity modal is per loop, and the filter implied one window over everything.
- Storing finished items. Rejected: it would put a person's command output in a database for an Admin's retention to account for.
- Extending `background` (#119). Rejected: it is built for the waiting state, holds 20 tasks and 120 characters, and never carries a command.

**Cost.**

- On Claude Code the output folder comes from a hook's `scratchpad_dir`, which the mod's typed hook input does not list. Where a hook does not carry it,
  the list shows with no time of last output, no exit code of its own and no output, and the row says the output was not collected. A file over 4 MiB is not
  read there, because the host reads a file whole.
- Claude Code reports no start time, so its times are "first seen" and a shell started before the reporter loaded shows the time it was first seen.
- A killed shell is not probed on Claude Code; it ends without an exit code, as on OpenCode.

<!-- nav:start -->
---

Previous: [67. A PR adds a changelog fragment, and release-prep assembles the fragments](67-a-pr-adds-a-changelog-fragment-and-release-prep-assembles-them.md) · Up: [Decisions](README.md)
<!-- nav:end -->
