# Issues inbox

A short-lived inbox for findings that turn up while doing other work and are not yet GitHub issues. It is not a
backlog: once a finding is real work, it becomes a GitHub issue and its entry is deleted from this file.

To add an entry, write a heading with a one-line summary, then what you saw, where, and why it matters. Do not
start work on an entry; filing and authorizing are separate steps.

To clear it, ask for `cii`: each entry is checked against the open issues for a duplicate, grouped by root cause,
filed with the `github-issue-filing` skill, and removed here.

## Entries

### Recording redaction is piece-wise, so a secret across a cut can be missed (#353)

The file diff's redactor costs time with the square of a line's length. `redactBounded` in
`mod/podium-reporter/hooks/recording.ts` therefore redacts a line longer than 1,000 characters in pieces (cut at a space
when it has one). A secret that straddles a cut is not seen. Matters because a recording keeps whole tool results, and
minified files or base64 are long lines. A linear-time redactor, or overlapping pieces, would close it. See
`docs/REPLAY.md`, "What redaction does not cover".

### Claude Code hides a Bash or MCP result of about 90 KB from the mod, so the 100,000-character cut is only unit-tested (#353)

In a live run (Claude Code 2.1.305), Claude Code replaces a Bash or MCP result of about 90 KB or more with a short
`<persisted-output>` stub before the mod's hook sees it, and a Read stopped at a line count well before 100,000 characters.
So the recording holds the stub, and nothing reached the mod above the 100,000-character cut. Whether a whole large result
should be fetched from the file the stub names is a design question. The cut and its marker are covered by unit tests only.

### Hot-reloading the mod during a recording lost later prompts (#353)

When the mod's files were edited while a session was recording, the mod reloaded and prompts after the reload were not
recorded for at least a minute, although the server still said `recording`. The cause is not found (a new `session.start`
or the grant not being read again are the suspects). It touches someone developing the mod, not a normal session.

### A prompt sent within about 2 s of pressing Record can be lost (#353)

Nothing before the mod's next report after **Record** is kept (SPEC 6.4), so a prompt sent in that gap is not recorded.
The person gets no hint. A short wait in the picker's confirmation, or a line in the layer, could say so.

### Recording redaction hides some text that is not a secret (#353)

A long identifier line and a `.claude/…/toolu_….txt` path inside a `<persisted-output>` stub came out as `[redacted]` in a
live run. The rule is best-effort and errs towards hiding. Compare against the file diff's redactor when its cost is fixed.

### The live checks left open after the tmux run (#353)

`scripts/podium-live-recording.sh` was run for `--help`, `server`, `api` and `clean` only; `session` and `stop` were not
run through it (the live run used scratch scripts). Not exercised live: the `gap` mark after a dropped queue, a fork, and
thinking text on models other than `claude-haiku` and `claude-sonnet-5-5` at medium and high effort, where chunks arrived
with empty text. If a model delivers text, SPEC 6.4 ("Thinking") needs a decision about keeping it.

### `npm run typecheck:mod` fails against Claude Code 2.1.305's types (not #353)

Three errors at `mod/podium-reporter/hooks/register.ts` (the tool names `podium_peers`, `podium_send` and
`podium_request_access` are not in the generated union). It fails the same way on `development`, so it is not from any
recent change; CI does not run it. The check that matters for a release (`typecheck:mod`) is red until the names are typed.

### Replay footer mixes counts, and Jump to next failure can look enabled with nothing to jump to (#353)

In the replay page, the footer counts rows in one place and entries in another, so the numbers do not agree with each
other. **Jump to next failure** looks enabled for a loop filter that shows no rows. Cosmetic, found in review of the
replay; `frontend/src/fleet/components/ReplayPage.tsx`.

### The recording load measurement used simulated traffic (#353)

The 5 s batch, the 512 MB and 4 GB limits and the disk figures come from `scripts/podium-recording-load.mjs` driving made-up
sessions on one machine. Real sessions have not been measured, so the defaults may need to change. Measure a few real
recorded sessions over several hours and compare bytes per loop per hour.
