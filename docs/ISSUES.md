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

### A live check of recorded tool results and Podium commands is still owed (#353)

The mod reads a call's whole result from what `next(e)` returns for `tool.call` (SPEC 5.3 marks this as an assumption).
Still to check in real sessions: the result text for Bash, Read, Grep and an MCP tool; `/clear` and `/compact` sent from
Podium; a denied permission prompt; and an answered question. Report any tool whose result the mod cannot see.

### Thinking-text research covered one model at one effort (#353)

The finding that `thinking` chunks arrive with empty text comes from `claude-sonnet-5-5` at medium effort, in the main loop
and in a subagent. Other models on Podium's list, other efforts and a fork were not tested. If any delivers text, SPEC 6.4
("Thinking") needs a decision about keeping it.

### Replay footer mixes counts, and Jump to next failure can look enabled with nothing to jump to (#353)

In the replay page, the footer counts rows in one place and entries in another, so the numbers do not agree with each
other. **Jump to next failure** looks enabled for a loop filter that shows no rows. Cosmetic, found in review of the
replay; `frontend/src/fleet/components/ReplayPage.tsx`.

### The recording load measurement used simulated traffic (#353)

The 5 s batch, the 512 MB and 4 GB limits and the disk figures come from `scripts/podium-recording-load.mjs` driving made-up
sessions on one machine. Real sessions have not been measured, so the defaults may need to change. Measure a few real
recorded sessions over several hours and compare bytes per loop per hour.
