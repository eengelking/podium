---
title: "46. A context names one reporter config file, in ~/.podium/contexts.json (#606)"
description: "A context is a name for a reporter config file in ~/.podium/contexts.json; a context that fails falls back to the newest file."
group: "Project internals"
number: 46
date: "2026-10-27"
status: "accepted"
order: 46
---

# 46. A context names one reporter config file, in ~/.podium/contexts.json (#606)

*Context.* With built-in TLS (decision 42) a reporter takes its server, CA, name and certificate from one config file, and it
picks the newest in `~/.podium/`. A person with two servers (a home one and a work one, or a test server beside the real one) had
no way to choose except `PODIUM_REPORTER_CONFIG`, set before Claude Code starts.

*Decision.*

- A **context** is a name for one reporter config file, kept in `~/.podium/contexts.json` with a `current` one, as a kubeconfig
  keeps contexts and `current-context`. The config file's format does not change.
- The reporter chooses in this order: `PODIUM_REPORTER_CONFIG`, `PODIUM_REPORTER_CONTEXT` (one terminal), `current`, then the
  newest file. With no contexts, it behaves as before.
- The same verbs (`list`, `show`, `add`, `rename`, `remove`, `use`) are in `/podium context` and in `podiumctl context`, on the
  same file. `add` checks the file exists and is a reporter config.
- A context that cannot be used is reported (`/podium`, debug log) and the reporter falls back to the newest file.
- A running session keeps the config it started with (decision 29); `use` changes the next session and says so.

*Why.* A name over a file reuses everything the file already carries, so no server address, CA or certificate is copied and
nothing about authentication changes. An environment variable per terminal is the one way to run two sessions on two servers
today, because the engine gives a mod no storage for one session's choice (#230). Both commands are needed: `/podium` is where
the person is when a session is open, and `podiumctl` is where they are when none is. The file is plain JSON, so each is small.

*Falling back.* The maintainer chose to show the problem and use the newest file over stopping, so a typo in a context does not
silence a reporter. This differs from a bad `PODIUM_REPORTER_CONFIG`, which sends nothing (#645): that variable names one file
on purpose, and a context is a convenience over the folder. The cost is that a session can report to a server other than the one
the person meant, with the problem shown beside it.

*Cost.* Two copies of the file format (`mod/podium-reporter/hooks/contexts.ts` and `bin/podiumctl`), kept equal by a test.
