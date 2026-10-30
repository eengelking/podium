---
title: "52. A machine takes part in messaging while any live session does (#838)"
description: "The server derives a reporter's peers value from its live sessions, so a claude -p run that reports false cannot switch the machine Off."
group: "Project internals"
number: 52
date: "2026-10-30"
status: "accepted"
order: 52
---

# 52. A machine takes part in messaging while any live session does (#838)

**Context.** The server kept one `peers` value per reporter (machine) and the latest report from any session won. The report sends `session.peers` per session, true only with the `peers` option on and an interactive session (SPEC 5.9). A machine with an interactive session and a `claude -p` run, which reports `false`, therefore flipped with each report. My reporters showed "Off on the machine", its controls locked, and other orchestrators were told the machine had messaging off, though one of its sessions took part.

**Decision.** A reporter takes part while any of its live sessions last reported `peers: true`. Each session's last reported value is kept on `reporter_sessions.peers`. A report with `peers: true` sets the reporter On. A report with `peers: false` sets it Off unless another live session of the same reporter last reported true. A session that has ended or been dropped no longer counts. A report with no `peers` (an older reporter) changes nothing, and a reporter with no live session keeps its last value, as before.

**Why.** The server cannot tell "the option is off" from "this session is not interactive" in one report, but it can compare sessions. With the option off every session reports false, so the machine still reads Off; with it on, one interactive session is enough. The mod needs no change.

**Alternatives.**

- Ignore `peers` from a session that is not interactive. This leans on the report carrying that signal for every case, and the mod's `interactive` logic is a separate issue (#833).

**Conflict with the spec.** SPEC 5.9 says `peers` is "set once per machine", while the report sends it per session. This decision reads the stored machine value as derived from its sessions. The spec text is not reworded here; the maintainer decides whether it should be.
