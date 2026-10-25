---
title: "6.4 Failure and excerpt rules"
description: "How failures are classified, how text is redacted, and what the opt-in full text, activity, recording and diff options send."
group: "Reference"
section: "6.4"
order: 4
---

# 6.4 Failure and excerpt rules

Module: `failures.ts` (pure).

## Failure candidates and classes

- On every `tool.call` result with `isError` or a `{ deny }`, store a candidate on the loop:
  - the tool name;
  - a summary of the call (Bash: the command; Edit/Read/Write: tool + `file_path`; others: tool + first
    argument, ≤ 300 chars);
  - the exit code parsed from the result text where present (best effort, `null` otherwise);
  - the last 12 lines of the result text.
- A loop that ends `failed` takes its most recent candidate (≤ 60 s old) as the failure's `tool`, `call` and
  `outputTail`.
- The failure's class:
  - `deny` gives `Blocked by permission`.
  - `turn.complete.reason === "error"` gives `Model API error`, unless a candidate exists.
  - `refusal` gives `Refusal`.
  - `stopReason === "model_context_window_exceeded"` or blowouts ≥ 3 gives `Context window exhausted`.
  - `aborted` gives `Aborted`.
  - Otherwise `Tool error` if a candidate exists, else `Unknown`.
- `evidence` lines are factual and generated, never invented: blowout count and times, repeated identical
  failing calls ("same call failed 3 times"), repeated reads of one file, the permission denial text.
- A loop with a failure candidate that later ends `done` is `done`. The candidate is discarded.

## Redaction and excerpts

- **Redaction.** Before anything leaves the machine, truncate to the limits above and replace anything that
  looks like a secret with `[redacted]`. The reporter unit-tests this. What counts as a secret:
  - `sk-ant-[A-Za-z0-9_-]{10,}`
  - `ghp_[A-Za-z0-9]{20,}`
  - `AKIA[0-9A-Z]{16}`
  - `Bearer [A-Za-z0-9._-]{20,}`
  - values after `password=`, `token=`, `secret=`, `apikey=`, `api_key=`
- **Excerpts** are the first 400 characters, whitespace collapsed.

## Full text (opt-in)

With the `fullPrompts` option on, the mod also keeps each agent's whole task prompt and final answer.

- Each is redacted by the rule above, with line breaks kept, and cut to 20,000 characters with a visible
  `[cut off at 20,000 characters]` marker.
- A text goes out once, in the first accepted report after it exists (the prompt when the agent starts, the
  answer when it finishes; a replacement answer goes out again), so heartbeats stay small.
- One report carries at most 120,000 characters of full text (the 512 KB body limit, [7.7](../07-server/07-07-hardening.md)).
  An agent whose text does not fit goes out in a later report, and a text counts as sent only when the report
  that carried it was accepted.
- Everyone who can open the console can read them, which is why the option is off by default.
- The server keeps them in `agent_texts` ([7.2](../07-server/07-02-database.md)) and serves them from
  `GET /api/fleet/sessions/:id/agents/:agentId/text`. The state and the stream carry only their lengths
  (`promptChars`, `answerChars`).

## Activity feed (opt-in, observed only, #118)

With the `activityFeed` option on, the mod can send a loop's recent work.

**What is sent**
- Each tool call is one entry: the tool's name and a short summary of its arguments (Bash the command,
  Read/Edit/Write the path, Grep the pattern and path, Agent the description, otherwise the first argument).
- The visible text of each model request is one entry (whitespace collapsed).
- Each is redacted by the rule above and cut to 300 characters. A loop keeps its last 20, and one report
  carries at most 60,000 characters of them.
- A Bash entry also carries its call id and the whole command (#431): redacted by the same rule, line breaks kept,
  cut to 20,000 characters with a visible `[cut off at 20,000 characters]` marker (`command`, with `commandCut`).
  Only a Bash row carries a whole command; any other tool row stays at its 300-character summary.
  The mod removes ANSI escape sequences and other control characters (not line breaks or tabs) from a command and from
  output before redacting, so a colored secret is still caught. Of the tool rows, the mod sends `id` and `command` for Bash only.
- With the `activityOutput` option on, the entry gets the call's output, stdout then stderr, redacted and cut the
  same way (`output`, `outputCut`). Once the call returns, the entry also gets `done` and the exit status (`exitCode`,
  `failed`), with the option on or off (#598): these are not output.
  Claude Code's tool types carry no numeric exit code, so the mod sets `failed` from the call's error flag and `exitCode`
  only when the text of a failed call says "Exit code N" (a live run against Claude Code 2.1.306 showed that text: the
  status line, then stdout and stderr merged; the mod shows the output without the status line). A call still running has none of them. Without the option, or for a loop no viewer has open, the mod reads that status line and keeps none of the output. Claude Code swaps a result of about 90 KB or more for a short
  `<persisted-output>` stub before the mod sees it, so the entry carries that stub.
- Commands and output count against their own budget, not the 60,000 characters of summaries: one report carries
  at most 200,000 characters of them over all its loops. It is filled from the orchestrator first, then the agents
  in order, and from a loop's newest entry back. An entry that does not fit loses its output, then its command, and
  keeps its summary.
- The mod also keeps one report under 480,000 serialized bytes, as a recording's request does, since multi-byte text slips
  past a character budget: it drops output first, then commands, oldest first, until it fits.
- Thinking is not sent: `turn.step` streams `thinking` chunks, but they are left alone.
- The orchestrator, subagents and forks are all treated alike.

**When it is sent**
- Under the default policy, nothing is captured, sent or stored unless someone is watching that loop. The
  console's panel for an agent or the orchestrator takes a short lease on it
  (`GET /api/fleet/sessions/:id/agents/:agentId/activity`), and the reply to each report lists the loops under
  a live lease (`watch`, [6.1](06-01-endpoint.md)).
- Under a keep policy (see *Activity history* below) the reply also lists the orchestrator and every running
  agent of a session whose reporter has the option on, whether or not anyone watches. The mod needs no change
  for this: it captures and sends whatever `watch` lists.
- The mod captures and sends entries only for the loops listed, from the moment it sees them listed, and
  forgets a loop's entries once it is no longer listed.
- **Output has a stricter rule (#431).** The mod captures a Bash call's output only for a loop in the reply's
  `watchOutput`, which lists the loops under a live viewer lease and never a loop listed only for the Activity
  history. A command that finished before the viewer opened the feed has no output to show. When the loop leaves
  `watchOutput` the mod stops capturing and forgets what it held.

**What the server does**
- For the live window it keeps the last 20 entries of a watched loop in memory only.
- It drops them when the lease lapses, when the session leaves the live set or is deleted, and on restart.
- It never keeps an entry older than the lease in memory, so a viewer who comes back starts empty. Nothing is
  backfilled there.
- Under a keep policy it also writes every entry a report carries to the Activity history, described next.
  The live window is unchanged. The history takes the entry's `command` but never its `output`, `exitCode`,
  `failed` or `done`.
- It holds a Bash entry's output in memory only, on the lease, with the rest of the live window, and ignores it
  while the Admin's `activity-output` flag is off or the session's `activityOutput` is not true. Output is never
  written to `podium.sqlite` or `activity.sqlite`, and never put in the state, the stream or a log.
- It holds and serves `done`, `failed` and `exitCode` the same way, in memory with the entry, but without those two
  switches: they are not output (#598). They attach to a held entry that arrived without them, and a call the lease
  did not hold when it started is not held when it finishes. They survive the `activity-output` flag turning off and
  the option turning off.

**Switches**
- With the option off, the mod captures nothing, ignores `watch`, and sends `activityFeed: false`.
- The feed needs two switches: this reporter option on the machine, and the server's `activity-feed` feature
  flag (Admin > Settings > Feature flags, [8.1](../08-ui/08-01-what-the-ui-must-do.md)), which is on by default.
- Output has two more switches (#431): the machine's `activityOutput` option and the Admin's `activity-output`
  flag (off by default, needs `activity-feed`). With either off, no output is captured or kept, the whole command
  still rides `activityFeed`, and the row says in words which switch is off.
- With the flag off the server grants no lease, every reply's `watch` is empty, it drops every lease and entry
  it held at the moment the flag goes off, it keeps nothing a mod sends, and it captures nothing for the
  Activity history. Entries already stored are still purged by the policy. Turning it back on needs nothing
  else, since the next fetch takes a lease as usual.

**Activity history (the Admin keeps the feed, #432)**
- The Admin chooses how long the feed is kept in Admin > Server > Data. The choices are: *Not stored* (the
  default, and exactly the behavior above), *purge after* n hours, days, weeks or months, *purge when the
  session ends*, and *keep everything*. An optional size cap in gigabytes removes the oldest entries first.
  The choice is one JSON row, `activity_history`, in the `settings` table
  ([7.2](../07-server/07-02-database.md)) and is global.
- A keep policy needs authentication ([7.7](../07-server/07-07-hardening.md)). With no token the server treats the policy as
  *Not stored* and refuses to save another, because nobody could be told apart as the one who may read it.
- Entries go to a second SQLite file, `activity.sqlite`, in the same folder as `PODIUM_DB`, so the main
  database's backups, vacuum and retention are not slowed by it. The file has its own schema version
  (`PRAGMA user_version`), WAL, and incremental auto-vacuum. `entries` holds one row per entry (session, loop,
  a sequence number per session and loop, the entry's own time `at`, the server-clock time `t` that the purge
  and the filters use, kind, text, a Bash entry's whole command and whether the mod cut it (schema version 5, #431),
  and, for an entry sent from Podium, who sent it and its note);
  `stored_sessions` holds the name, project and owner so the Admin pages need no join into the main database.
- Every entry is stored: tool calls, text, and the answers and messages sent from Podium, each keeping its
  marker. Each was already redacted and cut to 300 characters before it left the machine, and the server adds
  no second pass. The overlapping 20-entry snapshots the mod resends are stored once.
- It is not a complete record. The mod keeps 20 entries per loop and one report carries 60,000 characters, so
  a busy session can lose entries or a whole loop's feed between two reports, and nothing is replayed after
  an outage. Capture starts when the server first lists the loop.
- A purge runs every 5 minutes. Under *purge after* it removes entries older than the period; under *purge
  when the session ends* it removes the entries of sessions that are not live; the size cap removes the
  oldest entries until the total is under it. Every run that removes something writes one `admin_log` entry,
  `activity_purged`, with the count, the size and the policy. A run that removes nothing writes nothing.
- A session's own retention ([7.5](../07-server/07-05-lifecycle-timers.md), Retention) still applies: the entries of a session
  that is deleted, or whose retention has run out, are removed with it, so the shorter of the two wins.
- Each removal compacts the file (incremental vacuum, then a WAL checkpoint) so the space comes back. Removal and
  compaction run in small chunks that give the server's other work a turn between them, so a large purge or delete
  does not stall the console, and takes longer in total than it would in one go. A delete request answers when its
  removal has finished.
- Reading it needs a signed-in browser that is the session's owner or an Admin (the same sign-in as the file
  diff, [7.7](../07-server/07-07-hardening.md)): `GET /api/fleet/respond/sessions/:id/activity-history?loop=&before=&limit=`
  answers 401 without one and 403 for anyone else. The live route's reply carries only counts about the loop's
  stored history (`history`: total, since, keptUntil, whether this viewer may read it, the owner's name), so
  the window can say what is kept without showing text.
- The Activity window shows the newest stored page and the live entries after it, and can page back
  ([8.1](../08-ui/08-01-what-the-ui-must-do.md)). Under the default policy no reply carries `history` and the window is as it
  was.

## Session recording (opt-in, #353)

A recording keeps everything the orchestrator and the agents under it do, whole, so a run can be replayed to see
what happened and why. It is the most that Podium ever keeps of a conversation, which is why it needs three yes
answers and says so wherever it is on (`mockup/podium-recording.html`). Reading it back is under *Session recording*
in [7.7](../07-server/07-07-hardening.md#session-recording-353) and the notice and the replay are in [8.1](../08-ui/08-01-what-the-ui-must-do.md#session-recording-353-mockuppodium-recordinghtml).

**The three yes answers**
1. The Admin turns on the `session-recording` feature flag (Admin > Settings > Feature flags,
   [8.1](../08-ui/08-01-what-the-ui-must-do.md)). It is off by default, and it cannot be on while the server runs without a token
   ([7.7](../07-server/07-07-hardening.md)): with no token, nobody could be told apart as the one who may read a recording.
2. The session's owner, or an Admin, chooses to record the session and which of its loops, with **Record** on the
   orchestrator page. Nothing before that moment is kept.
3. The owner allows it in the reporter: the `sessionRecording` option, off by default
   ([5.9](../05-mod-api/05-09-mod-configuration-userconfig.md)). It is the one the owner controls on the machine, so it is the one that
   cannot be overruled from the browser.

All three are carried in `recording.consent` of every reply ([6.1](06-01-endpoint.md)). If any is false the mod captures
nothing and the server stores nothing. A person who chose a session whose owner has not allowed it is told so in
the console ("This session's reporter does not allow recording"), and the owner is told in the terminal
([5.3](../05-mod-api/05-03-events-the-reporter-hooks.md#session-recording-from-the-reporter-353)). Turning the flag off, or the option off, ends capture at once; an
Admin turning the flag off also stops every recording, and what was recorded is kept until it expires.

**What is captured.** For each chosen loop (the orchestrator, a subagent, a fork), in the order things happened:
- `prompt`: the task prompt an agent starts with, the person's prompt, and a message sent from Podium.
  The mod records every prompt of a loop and cannot tell where one came from, so a message from Podium arrives as
  an ordinary `prompt` entry. The server remembers each message it delivered (loop, time, sender, text) and, when the mod's
  entry for it arrives (same loop, within 10 minutes, the same text once runs of whitespace are folded to one space), adds
  the sender as the entry's marker (`by`), as the Activity history marks them. The match is exact, never "contains": a
  short message such as "ok" does not mark a later, longer prompt that holds it. The server writes no prompt of its own: a
  delivery the mod never records leaves nothing in the recording. Redaction differs between mod and server, and Claude
  Code may rewrap or rewrite a message before the mod sees it, so a prompt whose text no longer matches exactly stays
  unmarked (it fails safe: an unmarked prompt, never a wrong sender). Only a message is remembered this way: an answer, an approval and
  `/clear` and `/compact` do not arrive as a prompt, and the mod records them itself (`decision`, `clear`, `compact`).
- `text`: what the model wrote in each request, whole.
- `tool`: each call, with its **whole** input (a Bash command in full, the content of a Write, the old and new text
  of an Edit), not the short summary the Activity feed carries.
- `result`: that call's **whole** output (a file's contents for Read, command output for Bash, a Grep's matches),
  with `failed` when it failed, and `callSeq` pointing at its call.
- `thinking`: a mark where the model thought, with no text (below).
- `clear` and `compact`: marks for a `/clear` and for a compaction, with the loop it happened in. When the command came
  from Podium, the mark carries who sent it (`by`).
- `decision`: an answer or approval sent from Podium that Claude Code took ([5.3](../05-mod-api/05-03-events-the-reporter-hooks.md#responding-from-podium)), so a replay
  shows that a question was asked, who answered it from Podium and with what, and that a plan or a tool's permission
  prompt was approved or denied and by whom, in order after the call it answers. `name` is the kind of ask it settled
  (`question`, `plan` or `permission`), `callSeq` points at the call (`AskUserQuestion`, `ExitPlanMode` or the tool),
  `by` is who sent it, `failed` is set when it refused (a deny, a plan sent back), and `text` is what was chosen, in the
  words Claude Code received it in, redacted like any other text:

  | Sent from Podium | `name` | `text` |
  |---|---|---|
  | A question's answer | `question` | one `<question>: <answer>` line per answered question; the labels or typed text |
  | A message in place of an answer | `question` | `Replied in place of an answer: <message>` |
  | A plan's approval | `plan` | `Approved the plan (<and use auto mode \| auto-accept edits \| manually approve edits>)` |
  | "No, keep planning" | `plan` | `Sent the plan back: <feedback, or "No, keep planning">`, `failed` |
  | A message in place of approving | `plan` | `Replied in place of approving the plan: <message>`, `failed` |
  | A tool allowed once | `permission` | `Allowed once` |
  | A tool denied (or a message in place of the answer) | `permission` | `Denied: <reason>`, `failed` |

  The mod records a `decision` where it takes the answer, never the server, and only once Claude Code took it: a plan's
  approval after the call resolved approved, a tool's decision after the call ended the way the decision said. A Podium
  answer the terminal beat, an approval Claude Code did not take and an answer nobody collected leave no entry. The
  mod names the sender (`by`) itself, since only it knows what it took; the server keeps `by` for `decision`, `clear` and
  `compact` from the mod and ignores it on any other kind.
- `gap`: a mark, with `lost`, where entries of a loop were dropped on the machine (below).
- `stopped` and `limit`: marks the server writes where capture ended (below).

Nothing else is captured: not the system prompt, not a request's whole message list, not an image or a file that is
not a tool's result, not the settings or the environment. Cost, tokens and the plan are already in the state.

**Limits of one entry.** A text is redacted, then cut at 100,000 characters with a visible
`[cut off at 100,000 characters]` marker and `cut: true`. The type and limits are `RecordingEntry` and
`RECORDING_LIMITS` in `server/src/fleet/protocol.ts`, copied into the mod.

**Redaction (best effort).** Before anything leaves the machine, the mod redacts every string it records, tool
inputs and results included, with the whole rule set of the file diff ([6.4](#file-diff-opt-in-on-request-319): the
secret shapes, provider tokens, JSON Web Tokens, private key blocks, credentials in URLs, authorization headers,
values of keys whose name says they are secret, and long random-looking values). A value is replaced with
`[redacted]` and the rest of the text stays. The server and the console never see the original, and the server adds no
second pass. In addition:
- A `Read`, `Edit` or `Write` of a path on the file diff's never-send list (`.env`, `.env.*`, `*.pem`, `*.key`,
  `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `credentials*`) records the call with its path and
  a result of `[withheld: this file is on the never-send list]`, and an `Edit` or `Write` records neither its old nor
  its new text. A Bash command that reads one of them cannot be recognized in general; its output is only redacted.
- Each redaction counts toward `redactions` in the log line the mod writes, never in the text.

**What redaction does not cover.** A secret of a shape the rules do not know, a secret split across two entries or by
the 100,000 character cut, a secret the model wrote in its own words ("the password is hunter2"), a secret inside
base64 or another encoding, a secret in a file whose name is not on the never-send list, and personal data of any
kind. A recording therefore holds whatever the session saw. The Admin's switch, the owner's option and the
owner-and-Admin read rule are the control, and the User Guide says that redaction is not a guarantee.

**Thinking.** The mod receives the model's thinking as `thinking` chunks of `turn.step`. On `claude-sonnet-5-5` at
medium effort, in the main loop and in a subagent, those chunks arrive with **empty text**: a thinking block exists
(its chunks are counted) and no readable text comes with it (#353, research comment). Other models, other efforts
and forks have **not** been tested. Until they are, a recording keeps a `thinking` entry for each block and no text,
and the replay says "Thinking: text is not available" in its header and on each such row, so it never reads as if
the agent did not think. If a later mod version receives text, a recording does not start keeping it without a
change to this section.

**Where it goes.** The mod sends entries in batches of at most 200 entries and 480,000 bytes
(`POST /api/fleet/sessions/:id/recording`, [7.1](../07-server/07-01-endpoints.md)), inside the 512 KB body limit. Each entry has a
`seq` per session and loop, so a retry or a resend is dropped on the server and an entry is stored once. The server
keeps recordings in the Activity history's second file, `activity.sqlite` ([6.4](#activity-feed-opt-in-observed-only-118),
*Activity history*), in their own table, so the main database's backups, vacuum and retention are not slowed by
them, and they appear on *Stored activity* with the Source set to Recordings. Capture does not wait for a viewer and
does not need the `activityFeed` option or a keep policy.

**Gaps.** A recording is not guaranteed complete.
- While the server cannot be reached the mod queues entries in memory, up to 8 MB. Past that the
  oldest entries go and one `gap` entry per loop says how many (`lost`). Nothing is kept across a restart of the
  session's process.
- An entry the mod cannot read (a tool whose result it cannot see) is recorded without its result, and the replay
  says so.
- **Answers and approvals.** A question's answer or a permission decision made in the terminal is not marked as an entry of
  its own: the mod cannot see a permission prompt that nobody from Podium answered, and a question's result is recorded
  only when the engine hands it over as text (an `AskUserQuestion` result is an object, so the call shows with no
  `result`). What ran, and whether it was refused, is still in the tool's `result`. A `/compact` or `/clear` a person types
  while one sent from Podium is running can be marked as Podium's.
- Capture begins when the first reply that allows it arrives, so a short delay after **Start** is normal.
- A loop that starts under a recorded session after **Start** is not recorded unless it was chosen; the page's layer
  names the recorded and the unrecorded loops.

**Retention and size.** All three numbers are the Admin's, in Admin > Settings > Session recording, kept as one
JSON row, `recording_settings`, in the `settings` table ([7.2](../07-server/07-02-database.md)):
- *Keep a recording for*: 6 hours by default, at least 1 hour and at most 7 days. It is counted per part, from when
  that part was recorded, and a purge every 5 minutes removes what is older, so a short time is honored within a few
  minutes. A chosen recording that holds no entry yet stays until that long after it was started (a running one whose
  session is live stays regardless), and only then goes. The time shown to a person as "kept until" is when the oldest part still held goes. A session's own
  retention ([7.5](../07-server/07-05-lifecycle-timers.md), Retention) also applies, and the shorter of the two wins. A shorter time
  removes parts that are already older.
- *Disk budget*: 4 GB by default, for all recordings together. When the stored total would pass it, every running
  recording stops, with a `limit` mark (`limit: "budget"`) at the point where it stopped. Nothing already stored is cut
  short, and a new recording cannot start while the total is at the budget, which is when it has no *headroom*: headroom
  is one full request (480,000 bytes), so a start is refused when the stored total plus 480,000 bytes is above the budget
  ([7.7](../07-server/07-07-hardening.md#session-recording-353)). Otherwise the total rests just under the budget, a start is accepted, and its first
  batch stops with `limit`.
- *Limit for one session*: 512 MB by default. A recording stops when its session reaches it, with a `limit` mark
  (`limit: "session"`), and the owner is told in the terminal.
- **The 4 GB, the 512 MB and the 8 MB queue are set from a measurement** of the write load ("Measured write load"
  below). The traffic in it was simulated: **real sessions have not been measured**, so the numbers can change when they
  are. The server enforces them from the Admin's row, so changing them needs no code change. The per-session limit
  cannot be set above the disk budget, and both defaults are inside their ranges (8 MB to 4 GB, and 64 MB to 100 GB).
- Sizes are the stored text's bytes. The budget and the cap are checked as a batch is stored, so a recording can
  pass its limit by at most one batch (about 480 KB).

**Measured write load (#353, simulated traffic).** `scripts/podium-recording-load.mjs` reproduces every number below. It starts a
throwaway server, drives sessions through the mod's own `Recorder` (so redaction, the 100,000 character cut and the batching
are the real ones), and reads the server's disk writes and CPU. It was run on an Apple M5 (macOS 27.0.1, APFS SSD) with the
load generator on the same machine, over loopback.
- **Load.** Each session is an orchestrator with 3 agents. Every loop makes a tool call about every 8 s (exponential gaps).
  A call has an input of 0.5 to 5 KB (small for Read, Grep and Glob), a result after 0.2 to 3 s, a text entry half the time
  and a thinking mark 40% of the time. The *busy* profile gives results of 1 KB to 200 KB (55% under 8 KB, 30% to 50 KB,
  the rest above, cut at 100,000 characters; mean 22 KB); *typical* has a mean of 4.6 KB. Sessions report every 5 s. This is
  made-up traffic, not real sessions; **real sessions have not been measured yet**.
- **Method.** Bytes written and CPU are the server process's own, from `proc_pid_rusage` (`ri_diskio_byteswritten`, user and
  system time). It was checked by writing a known 100 MiB file, which it read back as 100 MiB; `time -l` reports 0 block
  operations on macOS, so it is not used. Operations come from the block driver's counters in `ioreg`, which are
  **system-wide and noisy** (the same configuration read 33 to 363 operations a second; the machine's own background is
  about 40), so they say only that the load is small: tens to about 200 a second, bursts of 1,600 to 3,000 a second in the
  one-second maxima, which the baseline (470 to 730) also shows from checkpoints. The count that is exact is commits: one
  request is one transaction. Each run is 180 s after a 10 s warm-up (one is 600 s); disk per hour is that rate times 3,600.

| Sessions (loops) | Recording | Requests/s | Ingested KB/s | Server writes KB/s | Server CPU, mean | Request p95 |
|---|---|---|---|---|---|---|
| 5 (20) | off | 0 | 0 | 20 | 0.7% | n/a |
| 5 (20) | on, 1 s | 3.4 | 48 | 175 | 1.2% | 4 ms |
| 20 (80) | off | 0 | 0 | 234 | 1.9% | n/a |
| 20 (80) | on, 1 s | 13.6 | 218 | 1,280 | 4.0% | 5 to 9 ms |
| 50 (200) | off | 0 | 0 | 761 | 4.2% | n/a |
| 50 (200) | on, 1 s | 33.8 | 531 | 3,855 | 8.2% | 11 ms |
| 20 (80), typical results | on, 1 s | 13.5 | 52 | 863 | 3.4% | 4 ms |

| 20 sessions, busy | Requests/s | Server writes KB/s | Writes minus the 234 baseline | Server CPU, mean |
|---|---|---|---|---|
| batch every 1 s | 13.6 | 1,280 | 1,046 (4.8 per byte ingested) | 4.0% |
| batch every 2 s | 8.8 | 1,071 | 837 | 3.1% |
| batch every 5 s | 4.0 | 903 | 669 (3.1 per byte ingested) | 2.6% |
| batch every 10 s | 2.0 | 799 | 565 | 2.1% |

At 50 sessions a batch every 5 s took 10.0 requests/s, 2,789 KB/s of writes (against 3,855) and 4.8% CPU (against 8.2%).
Runs of the same setting differed by 3 to 8% in bytes, and the one 600 s run wrote 13% more than the 180 s ones (1,451 KB/s
for 20 sessions at 1 s), so read the writes as plus or minus 15%. Server memory stayed at 118 to 155 MB. A probe of
`/api/health` every 250 ms read a p95 of 1.6 to 3.3 ms with recording on and 1.6 to 1.7 ms with it off; its worst reading was
27 to 69 ms with recording on and 4 to 12 ms with it off. A batch is stored in one synchronous transaction, so the server
answers nothing else while it runs.

Findings:
- **The server writes 3 to 12 times what it ingests,** and much of the cost is per commit, not per byte. Beyond the baseline
  a batch cost about 40 KB plus about 2.3 times its own size: 47 KB for the typical profile's 4 KB batches, 77 KB for the
  busy profile's 16 KB ones (1 s), 167 KB for 54 KB ones (5 s) and 283 KB for 108 KB ones (10 s). (Each row goes into a table
  and three indexes, and the recording's counters change; this was not profiled further.) The *typical* profile shows it
  most: 52 KB/s ingested, 629 KB/s written beyond the baseline. Fewer, larger batches are the lever.
- **Disk per hour of recording, busy profile:** 9.3 to 9.6 MB per loop (an orchestrator or an agent) counted by the server,
  9.9 to 10.2 MB in the file (about 6% more), so a session of 4 loops is about 38 MB an hour (40 MB in the file). The 600 s
  run gave 9.3 and 9.9, the 180 s runs 9.6 and 10.1. With the typical profile it is 2.3 MB per loop (2.7 in the file), 9 MB
  for a session of 4. At the default 6 hours of retention, the busy session holds about 225 MB, and 20 busy sessions fill
  4.5 GB.
- **The caps stop recording as specified.** At the per-session limit (8 MB, and the then default 256 MB) the recording held 7.94
  and 255.94 MB, its state read `limit` with `limit: "session"`, the last row was the `limit` mark, a later batch got `403
  recording is off`, and starting it again got `409` (delete it first). At the disk budget (64 MB, and the then default 2 GB)
  every running recording stopped with `limit: "budget"` and its mark, at 63.96 and 2,047.92 MB stored; the file held
  2,058 MB, 0.5% more. The server took 164 MB/s from a single poster. Deleting one recording let a new one start.
  One gap, since fixed: a start was refused only when the total was at or above the budget, but a recording stops when the
  next entry would pass it, so the total rested a little under the budget and a start was accepted; its first batch then
  stopped with `limit` ("budget"). A start now needs headroom (see *Disk budget*).
- **The purge keeps up.** The server purges every 5 minutes. With 20 busy sessions writing for 11 minutes and every row
  older than 30 s moved back by 7 hours every 10 s (a stand-in for waiting out the retention), the stored total made a
  sawtooth: it grew to 56 to 67 MB (5 minutes of writing) and fell to about 7 MB at each of the two runs, which removed 7,497
  and 8,666 entries; the file fell back to 8.6 MB. Requests stayed at a p95 of 8 ms. A full budget (2,048 MB, 21,685 rows,
  all aged) was removed in one run in under a second (polled every 250 ms), the file went from 2,058 MB to under 1 MB, and
  `/api/health` read a p95 of 2.0 ms and a worst of 95 ms. The first run is 5 minutes after the server starts.

Caveats: the traffic is invented; the server and the generator share one machine (the generator used 2 to 13% of a core);
the runs are minutes long and the hours are an extrapolation; the purge run ages rows by rewriting their time, so it also
adds writes of its own and says nothing about the write load; the system-wide operation counts are not a measurement of
the server alone.

**Decision (the maintainer's, from the measurement above; the traffic was simulated).**
- **Batch interval: 5 s instead of 1 s.** It cuts requests by 3.4 times, the server's writes for 20 busy sessions by 29%
  (36% beyond the baseline) and its CPU by 35%. The cost is a replay that trails a live session by up to 5 s, and up to 5 s
  of entries lost if the session's process dies. 10 s saves a further 12% only. Because one request is at most 480 KB, 5 s
  allows a session 96 KB/s on average, so the mod also sends at once, at its next flush tick, when its queue passes 256 KB.
- **Batch size: unchanged, 200 entries and 480,000 bytes.** At 5 s the mean batch was 7 entries and 54 KB, the largest 370 KB.
  The limits are not what is reached.
- **Limit for one session: 512 MB instead of 256 MB.** A busy session of 4 loops holds about 225 MB over 6 hours, close to
  256 MB, and one of 8 busy loops would reach 256 MB after about 3.4 hours and stop recording while the trouble is still
  going on.
- **Disk budget: 4 GB instead of 2 GB.** 2 GB holds 6 hours of about 9 busy sessions of 4 loops (about 37 typical ones).
  Reaching it stops every recording at once, so it should be a safety stop, not the normal limit.
- **The mod's queue: unchanged, 8 MB.** It is memory, not disk; the largest queue in the runs was 370 KB, so 8 MB is ample.

**Stopping, keeping and deleting.**
- **Stop** ends capture for the whole session (the orchestrator and every agent and fork). The server writes a
  `stopped` mark with who stopped it and when. What was recorded is **kept** until it expires, can still be
  replayed, and can be deleted. Stopping is for the session's owner and an Admin. The mod sends in batches, so
  its last batch can still be on its way when the person stops: the server takes entries from a stopped recording
  whose `at` is at or before the stop time, and refuses any after it. A recording that stopped for a limit, a
  deleted one, and any batch while the flag or the owner's option is off are refused as before.
- **Delete** removes the whole recording for good, and stops capture if it is still running. It does not touch the
  session, History or the live feed. Deleting is for the session's owner and an Admin.
- **`/clear`.** A `/clear` gives the session a new id. When the server sees the first report of a session whose
  `clearedFrom` names a recording that is running (with the orchestrator among its loops), the new session inherits the
  choice, the starter and the start time, recorded for the orchestrator's loop; the old recording stops, with no `stopped`
  mark and no one named. The owner's consent does not carry over: the new session still needs its own `sessionRecording`
  option, which its own report states. Nothing is carried when the flag is off or the new session already has a recording.
- A session that ends keeps its recording as it is (capture ended with it) until it expires. Deleting the
  session, or its own retention running out, removes the recording with it.
- The owner can also stop capture on the machine at any time by turning the `sessionRecording` option off. It ends
  capture; it does not delete what was kept.

**Access.** Only the session's owner and an Admin can read, stop, delete or open the replay of a recording, with the
same sign-in and the same owner test as the Activity history ([7.7](../07-server/07-07-hardening.md#session-recording-353)). The wall and the
orchestrator page show to **everyone** that a session is recorded, who started it, which loops and when it goes (the
notice, [8.1](../08-ui/08-01-what-the-ui-must-do.md#session-recording-353-mockuppodium-recordinghtml)), and show nothing of its content.

## File diff (opt-in, on request, #319)

With the `fileDiff` option on, the mod can send the diff of one file in the Files list
([5.7](../05-mod-api/05-07-git-queries.md)) when someone asks for it.

**What is sent**
- The diff of one path against the same base the list counts from (the session's starting commit, or the
  fallback base the list names): `git -C <toplevel> diff <base> -- <path>`, with `-M` and the old path for a
  renamed file, and `git diff --no-index -- /dev/null <path>` for an untracked one.
- The path must be one the current `session.files` lists. Any other is refused with `status: "unavailable"`.
- A diff is cut at 2,000 lines or 200,000 bytes, at a line boundary, and says so: `truncated: true`, with the
  `shownLines` and `totalLines` it kept and had. A binary file sends no text (`status: "binary"`); a path that
  matches the never-send list sends none either (`status: "withheld"`): `.env`, `.env.*`, `*.pem`, `*.key`,
  `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `credentials*`. A diff whose size cannot
  be bounded (more than 5 MB read, or a file the list counts at more than 200,000 changed lines) is
  `status: "too-large"` and is not read into the report. A single line is cut at 4,000 characters and ends with
  ` … [line cut]`.
- The mod answers with `PUT /api/fleet/sessions/:id/diffs/:requestId` ([7.1](../07-server/07-01-endpoints.md)).
- **Redaction.** The mod redacts the text before it leaves the machine, on every line it sends: removed, added
  and context lines alike, since a secret that was just deleted is still a secret. The server and the console
  never see the original. A value is replaced with `[redacted]` and the rest of the line stays, so the diff
  still reads. The rules go further than the shapes in the redaction rule above, because a diff can show
  any file, not only a `.env`:
  - the shapes in the redaction rule above;
  - provider tokens: `sk-…` keys, GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), GitLab
    `glpat-`, AWS access key ids (`AKIA`, `ASIA`) and a 40-character secret after `aws_secret`, Google
    `AIza…`, Slack `xox[abprs]-…`, Stripe `sk_live_`, `rk_live_` and `whsec_`, npm `npm_…`, SendGrid `SG.…`,
    Twilio `SK…`, Azure storage `AccountKey=…`, and Anthropic and OpenAI keys;
  - JSON Web Tokens (three base64url parts, the first two starting `eyJ`);
  - a private key block (`-----BEGIN … PRIVATE KEY-----` to the matching `END`), every line of its body, with
    the line count kept;
  - a password or token in a URL (`scheme://user:secret@host`) and in a connection string;
  - an `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie` or `X-Api-Key` header value, and a
    `Basic …` or `Bearer …` credential;
  - the value of a key whose name says it is a secret (`password`, `passwd`, `pwd`, `secret`, `token`,
    `api_key`, `apikey`, `access_key`, `private_key`, `client_secret`, `auth`, `credential`, `salt`, with any
    prefix or suffix, in any case and with `-` or `_`), written with `=`, `:` or `:=`, bare or quoted, in env,
    JSON, YAML, TOML, code or a command line, including `--password foo` and `-p foo` after a known client;
  - a long random-looking value: 24 or more characters of base64 or base64url with a digit and a Shannon entropy
    of at least 4.0 bits per character (40 or more letters-only characters need 4.3), or 32 or more hex characters
    with an entropy of at least 3.0 that are not a 40- or 64-character hash on its own. A path, a UUID, a
    lockfile `integrity` hash and an identifier are not.
- Redaction is best effort, because a secret can take any shape. The unit tests hold the shapes above and a
  list of lines that must not be changed. Each redaction counts toward `redactions` in the reply. The
  `fileDiff` option, the Admin's flag and the owner-only gate stay the control, and the User Guide says
  that redaction is not a guarantee.
- The console draws each `[redacted]` in bold, in the critical color.

**When it is sent**
- Nothing is read for a file nobody opens. The console asks only when a signed-in owner or Admin opens a
  file's modal, the server lists the request in the next reply's `diffs`, and the mod answers once. A request
  the mod has not answered in 15 seconds is dropped and the console says so.

**What the server does**
- It hands the text to the one browser request that is waiting and then forgets it. It keeps no copy: not in
  the database, not in the state or the stream, not in a log line, an error or the admin log, and not for a
  second viewer. Opening the modal again asks again.
- It drops a pending request when its session leaves the live set or is deleted, and on restart.

**Switches**
- Three must be on: the reporter's `fileDiff` option on the machine, the server's `file-diff` feature flag
  (Admin > Settings > Feature flags, [8.1](../08-ui/08-01-what-the-ui-must-do.md)), off by default, and authentication
  ([7.7](../07-server/07-07-hardening.md)). Who may ask is under *File diff* in [7.7](../07-server/07-07-hardening.md).
- With the option off the mod reads nothing and ignores `diffs`. With the flag off the server lists no
  request, refuses the browser route, and drops what is pending.

## Who and where

- A report names a person only when the user has set the `userName` option, which is empty by default. It
  then also carries `machine` (the short host name and the mod's own random id, never a hardware id).
- Nothing else that identifies the person or the machine is sent. The operating system user name and
  `git config` are never read for it.
- Everyone who can open the console sees both.
- Without a person's token ([7.7](../07-server/07-07-hardening.md)) the name is a label anyone can claim, so the server records
  an owner only from a token.

<!-- nav:start -->
---

Previous: [6.3 Plan building rules](06-03-plan-building-rules.md) · Up: [6. The reporter protocol](README.md) · Next: [6.5 Models, windows, prices](06-05-models-windows-prices.md)
<!-- nav:end -->
