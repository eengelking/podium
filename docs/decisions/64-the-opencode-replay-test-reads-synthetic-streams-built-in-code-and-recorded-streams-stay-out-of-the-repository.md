---
title: "64. The OpenCode replay test reads synthetic streams built in code, and recorded streams stay out of the repository (#1025)"
description: "scripts/opencode-streams.ts builds the five streams the replay test needs, docs/fixtures/opencode/ is ignored, and the live test removes what a run leaves."
group: "Project internals"
number: 64
date: "2026-11-08"
status: "accepted"
order: 64
---

# 64. The OpenCode replay test reads synthetic streams built in code, and recorded streams stay out of the repository (#1025)

## Context

#879 committed five recorded OpenCode 2.2.5 event streams to `docs/fixtures/opencode/` for the #848 spike, and
`scripts/opencode-reporter.test.ts` replayed them. They are raw output of a live run and carry about 239 session, 84 message and
15 call ids. A review found no credential, personal path, email, host or real model traffic in them, but the maintainer wants
recordings of this kind out of the repository.

## Decision

- The replay test reads streams built in code by `scripts/opencode-streams.ts`: `short-session`, `subagent`, `permission`,
  `question` and `compaction`, with the shapes OpenCode puts on its bus and short made-up ids. The test asserts what it asserted
  before.
- The five recorded files are removed from the tree, and `docs/fixtures/opencode/` is in `.gitignore`, so a recording made by a
  live run is never staged.
- The live-test skill compares `git status --ignored` before and after a run, removes only what the run added, and names it in
  the report.
- The files are removed going forward only. History is not rewritten: no force-push, no changed hash and no re-made tag. The
  commits that hold the files stay as they are.

## Why

The streams are small, so building them in code keeps the check in CI with no OpenCode installed and no recording to carry. A
stream a person can read in a test is easier to change when OpenCode changes a shape than a 13 KB recording.

## Alternatives

- **Record at run time.** Needs OpenCode, so it cannot run in CI.
- **Skip when the folder is absent.** CI would stop checking the replay.
- **Remove the files from history.** Considered in the issue and not taken: it moves every hash after #879, and the files hold no
  secret.

## Cost

The synthetic streams are written by hand, so they can drift from what OpenCode really sends. A new OpenCode event the reporter
should handle needs its stream added here, from a live run the person makes and does not commit.
