# Session recording and replay

Podium can record one session whole, orchestrator and agents together, and play it back later: every prompt, what the
model wrote, each tool call with its full input and its full result. This page is for whoever turns that on and uses it:
what it is, the three yes answers it needs, what is and is not captured, the notice, where it is stored, how long, the
limits, who can read it, how to stop and delete a recording, the replay view, what was measured, and what is still open.

It is the most Podium ever keeps of a conversation, so read [What is captured](#what-is-captured) and
[What redaction does not cover](#what-redaction-does-not-cover) before you switch it on.

The exact rules are in [SPEC.md](SPEC.md): what is recorded and kept in
[6.4](SPEC.md#session-recording-opt-in-353), the reporter's side in
[5.3](SPEC.md#session-recording-from-the-reporter-353) and [5.9](SPEC.md#59-mod-configuration-userconfig), who may read
it in [7.7](SPEC.md#session-recording-353), the routes in [7.1](SPEC.md#71-endpoints), and the screens and the notice in
[8.1](SPEC.md#session-recording-353-mockuppodium-recordinghtml). Where this page and the spec differ, the spec wins. Why
it was built this way is [DECISIONS 40](DECISIONS.md#40-a-session-can-be-recorded-whole-with-three-yes-answers-353).

## Contents

- [What it is](#what-it-is)
- [The three yes answers](#the-three-yes-answers)
- [Record a session](#record-a-session)
- [What is captured](#what-is-captured)
- [What redaction does not cover](#what-redaction-does-not-cover)
- [The notice](#the-notice)
- [Where it is stored and for how long](#where-it-is-stored-and-for-how-long)
- [Limits](#limits)
- [Who can read it](#who-can-read-it)
- [Stop, keep and delete](#stop-keep-and-delete)
- [The replay](#the-replay)
- [What was measured](#what-was-measured)
- [Open follow-ups](#open-follow-ups)

## What it is

The Activity feed shows what an agent is doing now, in short lines, and only the last 20. A recording keeps all of it,
whole, from the moment you press Start, so you can see what happened and why after the fact. Say an agent made a change
you did not expect: open the replay, find the tool call, read the file it had just read.

What it is:

- Per session, and per loop within it: you choose the orchestrator and which of its agents and forks.
- Off until three things are on, and visible to everyone for as long as it runs.
- Read-only. A replay never runs anything or sends anything to the session.

What it is not:

- Not a transcript reader. Podium still reads no transcript file. The mod records what it sees as the session runs.
- Not a complete record. [Gaps](#gaps) lists where it can be missing something.
- Not safe for secrets. Redaction is best effort.

## The three yes answers

Nothing is captured or stored unless all three are yes. Each reply from the server carries the three answers, and the
mod captures only while they are all true.

| # | Who | What | Default |
|---|---|---|---|
| 1 | The Admin | Turns on the **Session recording** feature flag (`session-recording`) in Admin > Settings > Feature flags. It needs the server's auth on: with no token the switch is unavailable | Off |
| 2 | The session's owner, or an Admin | Chooses to record this session and which loops, with **Record** on the orchestrator page | Not chosen |
| 3 | The session's owner, on their machine | Sets the reporter's `sessionRecording` option ("Allow session recording") to on | Off |

The third is the one the owner holds on the machine, so the browser cannot overrule it. If a session is chosen but the
option is off, the console says "This session's reporter does not allow recording", the owner's terminal says so, and
nothing leaves the machine. Turning the flag or the option off ends capture at once. An Admin turning the flag off also
stops every recording, and what was recorded stays until it expires. The option is described in
[REPORTER.md](REPORTER.md#options).

## Record a session

1. Open the session's orchestrator page. The **Recording** cell is the last in the facts panel, after Fork.
2. Press **Record**. The picker lists the orchestrator, its agents and its forks, each with a box. It tells you before
   you start if the owner has not allowed recording, how long a recording is kept, and which of the five states applies.
3. Press **Start recording**. Nothing before that moment is kept, and a short delay before capture begins is normal.
   A loop that starts later is not recorded unless you add it by choosing again.

The owner and an Admin can both start, stop and delete, and an Admin can do it without the owner knowing. That is why
the notice cannot be hidden and the owner's terminal is told every time. Everyone else sees the state and no button.

The Admin sets the limits in Admin > Settings > Session recording and sees every recording in the Recordings table
there. Both are covered in the [user guide](USER_GUIDE.md#session-recording) and [SERVER.md](SERVER.md#session-recording).

## What is captured

For each recorded loop, in the order things happened ([6.4](SPEC.md#session-recording-opt-in-353) is the contract):

| Entry | What it holds |
|---|---|
| Prompt | The task prompt an agent starts with, the person's prompt, and a message sent from Podium (with its sender) |
| Text | What the model wrote in each request, whole |
| Tool | Each call with its whole input: a Bash command in full, a Write's content, an Edit's old and new text |
| Result | That call's whole output: a file's contents for Read, command output for Bash, a Grep's matches. Marked failed when it failed |
| Thinking | A mark where the model thought, with no text |
| Clear, compact | A mark for a `/clear` or a compaction, with who sent it when it came from Podium |
| Decision | An answer or approval sent from Podium that Claude Code took: a question's answer, a plan approved or sent back, a tool allowed once or denied |
| Gap, stopped, limit | Marks where entries were lost on the machine, or where the recording ended |

A text longer than 100,000 characters is redacted and then cut, with a visible `[cut off at 100,000 characters]` marker.

Not captured: the system prompt, a request's whole message list, images, a file that is not a tool's result, the
settings and the environment. Cost, tokens and the plan are already in the session's state.

### Thinking text is not available

The mod receives the model's thinking as chunks that arrive with empty text. It was tested on `claude-sonnet-5-5` at
medium effort, in the main loop and in a subagent (the research is on [#353](https://github.com/eengelking/podium/issues/353)).
The recording therefore keeps a mark for each block and no text, and the replay says "Thinking: text is not available"
so it never reads as if the agent did not think. Other models, other efforts and forks were not tested
([open follow-ups](#open-follow-ups)).

### What is not marked

- **A question answered in the terminal, or a permission prompt nobody answered from Podium, leaves no decision row.** The
  mod cannot see a permission prompt that was answered in the terminal. What ran, and whether it was refused, is still in
  the tool's result.
- A question's result is recorded only when Claude Code hands it over as text. An `AskUserQuestion` result is an
  object, so that call shows with no result.
- A decision is recorded only once Claude Code took it. A Podium answer the terminal beat, or one nobody collected,
  leaves nothing. The mod names the sender itself, because only it knows what it took.

### Gaps

- While the server cannot be reached, the mod queues entries in memory up to 8 MB. Past that the oldest go and a gap
  row says how many. Nothing is kept across a restart of the session's process.
- A tool whose result the mod cannot read is recorded without its result, and the replay says so.
- A `/compact` or `/clear` a person types while one sent from Podium is running can be marked as Podium's.
- Batches go out every 5 seconds, so a session that dies loses up to the last 5 seconds.

## What redaction does not cover

Before anything leaves the machine, the mod replaces what looks like a secret with `[redacted]`, using the same rules as
the file diff: provider tokens, JWTs, private key blocks, credentials in URLs, authorization headers, values of keys
whose name says they are secret, and long random-looking values. A `Read`, `Edit` or `Write` of a file on the never-send
list (`.env`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc` and the others in [6.4](SPEC.md#session-recording-opt-in-353)) keeps
the path and withholds the contents. The server adds no second pass.

That is best effort. It does not catch:

- a secret of a shape the rules do not know;
- a secret split across two entries or by the 100,000 character cut;
- **a secret straddling a cut in a very long line.** The redactor's cost grows with the square of a line, so the mod
  redacts a line longer than 1,000 characters in pieces. A secret that falls across a piece boundary can be missed;
- a secret the model wrote in its own words ("the password is hunter2");
- a secret inside base64 or another encoding;
- a secret in a file whose name is not on the never-send list, including what a Bash command printed;
- personal data of any kind.

A recording holds whatever the session saw. The three yes answers and the owner-and-Admin read rule are the control.

## The notice

A recorded session says so, to everyone who can open the console, for as long as it is recorded:

- On the wall, the card gets a second band in the critical color: "Recording everything" or "Recording N of M loops",
  who started it and when it goes.
- On the orchestrator page, a layer above the page's band says what is kept, who started it, which loops are and are not
  recorded, and when it is deleted, with **Stop recording**, **Open replay** and **Delete recording** for the owner and
  an Admin.
- In the owner's terminal, the mod writes the same words when capture starts, again after `/clear` and after a
  compaction, and when it stops or hits a limit ([5.3](SPEC.md#session-recording-from-the-reporter-353) has the text).

**It cannot be dismissed.** It is not a wall notice. There is no X and no switch, on the wall or in Admin. A wall
notice is an informational note that someone may close for everyone. Consent is not that: the people whose work is being
kept have to be able to see that it is, and an Admin can start a recording without the owner's knowledge. The notice
shows state only and never any content. The approved exception to the wall-notice rules is recorded in the
[changelog](../CHANGELOG.md).

## Where it is stored and for how long

Recordings live in the Activity history's second file, `activity.sqlite`, beside `podium.sqlite`, in their own tables
(`rec_sessions` and `rec_entries`), so the main database's backups, vacuum and retention are not slowed by them. They
appear in Admin > Server > Stored activity with Source set to Recordings. The data path and the tables are in
[ARCHITECTURE.md](ARCHITECTURE.md#session-recording).

**Retention** is the Admin's, in Admin > Settings > Session recording:

- *Keep a recording for*: 6 hours by default, at least 1 hour and at most 7 days.
- It is counted **per part**, from when that part was recorded, not from when the recording started. A purge runs every
  5 minutes and removes what is older, so a short time is honored within a few minutes, and a long recording drops its
  oldest part first.
- The time shown as "kept until" is when the oldest part still held goes.
- A session's own retention also applies. The shorter of the two wins.
- A shorter setting removes recordings that are already older, and the form says so.
- A session that ends keeps its recording until it expires. Deleting the session removes its recording.

A backup of the database folder holds a recording until a purge or a delete removes it, and a delete does not change
copies made earlier.

## Limits

All three numbers are the Admin's, saved in one row, and enforced by the server, so changing them needs no restart.

| Limit | Default | Range | When reached |
|---|---|---|---|
| Keep a recording for | 6 hours | 1 hour to 7 days | The oldest part is purged |
| Limit for one session | 512 MB | 8 MB to 4 GB, never above the disk budget | That recording stops, with a `limit` row and a line in the owner's terminal |
| Disk budget, all recordings | 4 GB | 64 MB to 100 GB | Every running recording stops, with a `limit` row |

- **A start needs headroom.** A new recording is refused (`409`, "the disk budget has no room for a new recording") when
  the stored total plus one full request, 480,000 bytes, is above the budget. Deleting a recording makes room.
- The budget and the cap are checked as a batch is stored, so a recording can pass its limit by about one batch (480 KB).
- **Batches.** The mod sends at most every 5 seconds, up to 200 entries and 480,000 bytes a request. A queue that passes
  256 KB goes at the next flush tick without waiting out the 5 seconds. Each entry is numbered per loop, so a retry is
  dropped on the server and an entry is stored once.
- Sizes are the stored text's bytes. The Admin's usage line counts recordings, bytes and the budget.

The defaults come from a measurement ([below](#what-was-measured)) made with simulated traffic, so they may change when
real sessions are measured.

## Who can read it

Only the session's owner and an Admin can read, choose, stop, delete or open the replay of a recording, with the same
sign-in and the same owner test as the Activity history ([7.7](SPEC.md#session-recording-353)). Everyone else gets `403`,
or `404` while the flag is off.

Everyone sees that a session is recorded, who started it, which loops and when it goes, and never any content. The
History row's line "recording kept until <time>" shows only to the owner and an Admin.

The Admin log records each action with who did it and the session, and never any text:

| Kind | When |
|---|---|
| `recording_started` | A recording was started or its loops changed |
| `recording_stopped` | A person stopped it |
| `recording_deleted` | It was deleted, with entries and bytes |
| `recording_limit` | The session limit or the budget stopped it |
| `recording_read` | A replay was opened (a read without `before`, so paging back does not repeat it) |
| `recording_settings_changed` | The three limits, before and after |
| `recording_purged` | A purge run that removed something, with counts and sizes |

The flag itself is `feature_changed`, like every flag. The text is never logged anywhere.

## Stop, keep and delete

- **Stop** ends capture for the whole session. The server writes a `stopped` mark naming who and when. **What was
  recorded is kept** until it expires, can still be replayed, and can be deleted. The mod's last batch may still be on
  its way, so the server takes entries from a stopped recording whose time is at or before the stop.
- **Delete** removes the whole recording for good and stops capture if it is still running. It does not touch the
  session, History or the live feed. It asks first and says what goes.
- The owner can end capture at any time by turning the `sessionRecording` option off. That does not delete what was kept.
- **`/clear` gives the session a new id.** If the old session had a running recording with the orchestrator among its
  loops, the new session inherits the choice, the starter and the start time, and the old recording stops with no
  `stopped` row. The owner's consent does not carry over: the new session needs its own `sessionRecording` option.
  Nothing is carried when the flag is off or the new session already has a recording.
- A recording that hit a limit reads like a stopped one, with the limit named. Start again by deleting it first.

## The replay

**Open replay** (on the orchestrator page's layer, in History for an ended session, and in Admin's Recordings table)
opens a page of its own at `#/?open=<id>&replay`. It survives a reload, and a viewer who may not read it sees a refusal at
the same address. A back link returns to the orchestrator page.

- It is the Activity feed's rows, oldest first, with the loop's name before each row and each tool call's result
  collapsed under it. A failed call uses the failure box.
- A **loop filter**, a position slider and **Jump to next failure** move through it.
- Compactions, clears, gaps, stops and limits are marked rows.
- A prompt, clear or compact that came from Podium, and a decision, show who sent it ("You, from Podium" for your own).
  A decision is a row right after the call it answers: `Answered a question`, `Approved a plan`, `Sent a plan back`,
  `Allowed a tool once` or `Denied a tool`, with what was chosen. One that refused something uses the failure styling.
- **It loads the newest 200 rows** and **Show older** pages back. The whole recording is stored; it is not all loaded.
- The header says thinking text is not available, and each place the model thought has a row that says so.
- States: loading, a failed load with Try again, nothing recorded yet, a delete asking first, a stopped recording, one at
  its limit, and a viewer who is not the owner.

## What was measured

The limits above were chosen from a measurement of the server's write load, made with simulated traffic.
`scripts/podium-recording-load.mjs` reproduces it (`node scripts/podium-recording-load.mjs --help`): it starts a
throwaway server and drives sessions through the mod's own recorder, so redaction, the cut and the batching are the
real ones. `scripts/podium-recording-seed.mjs` seeds a throwaway server with recordings to look at.

In short, on one Apple M5 over loopback, with 20 busy sessions of 4 loops each:

- The server writes 3 to 12 times what it ingests, and much of the cost is per commit, so fewer, larger batches are the
  lever. A batch every 5 seconds instead of every second cut requests 3.4 times, writes by 29% and CPU by 35%.
- A busy loop costs about 9.5 MB of disk an hour, so a busy session of 4 loops holds about 225 MB over the default 6
  hours. That is why the per-session default is 512 MB and the budget 4 GB.
- The caps stopped recording as specified, and a purge of a full budget finished in under a second.

The tables, the method, the caveats and the maintainer's decision are in [6.4](SPEC.md#session-recording-opt-in-353)
("Measured write load"). **Real sessions have not been measured.**

## Open follow-ups

Not yet tracked as GitHub issues; they are in [ISSUES.md](ISSUES.md):

- The redactor is quadratic on long lines, so the mod redacts in pieces and a secret straddling a cut can be missed.
- A live check of tool-result text for Bash, Read, Grep and an MCP tool, `/clear` and `/compact` from Podium, a denied
  permission prompt and an answered question is still owed.
- The thinking-text research covered only one model at one effort.
- The replay footer mixes row and entry counts, and Jump to next failure looks enabled for a filter with no rows.
- The load measurement used simulated traffic.
