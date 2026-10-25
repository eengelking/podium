---
title: "Architecture"
description: "How Podium was built: the shape of the system, how each part works, where the build departed from the spec, and what is still open."
group: "Project internals"
entries: "list"
---

# Architecture

This is how Podium was built, written for a contributor who wants to understand the code. It covers the shape of
the system, how each part works, where the build departed from the spec and why, what was verified, and what is
still open.

Related documents:

- [docs/spec/](../spec/README.md) owns intended behavior. Section numbers cited here as "SPEC x.y" point into it.
- [docs/decisions/](../decisions/README.md) owns why a choice was made. "DECISIONS n" points into it.
- [docs/gotchas/](../gotchas/README.md) is the short, practical version of the known issues below.
- [ATLAS.md](../atlas/ATLAS.md) is a table of every part of Podium and every reporter hook, and where each runs. Read it for
  the map before the detail below; [the interactive version](../atlas/podium-atlas.html) opens in a browser.

Podium is a live fleet console for Claude Code sessions. This repo holds the reporter mod
(`mod/podium-reporter/`), an Express server (`server/src/fleet/`) and a Vite frontend (`frontend/src/fleet/`),
with the default view at `#/`. An earlier usage dashboard lived here until it was removed (DECISIONS 15).

## Pages

<!-- entries:start -->
- [How Podium fits together](01-how-podium-fits-together.md): The shape of the system: how the reporter mod, the server and the UI connect, plus the design standards and the docs site.
- [Components](02-components/README.md): Which files own each part of Podium, which issue introduced it and how it works, one page per part.
- [Spec questions](03-spec-questions.md): The numbered places where the spec was silent, ambiguous or wrong, the reading chosen and why.
- [Deviations from the spec](04-deviations-from-the-spec.md): The deviations from the spec that change behavior a reader of the spec would expect.
- [Known issues](05-known-issues.md): The numbered known issues in the build, with their reasons; the short version is GOTCHAS.
- [Browser checklist (T4.2)](06-browser-checklist.md): The checks run in Chrome against the dev server and what each found.
- [Mod API findings](07-mod-api-findings.md): What the engine's mod API was checked to do against SPEC's assumptions, with the evidence for each.
- [Dependencies added](08-dependencies-added.md): The dependencies added to the project since the build and why each is there.
- [Phase log](09-phase-log.md): What each build phase delivered, from the contract and scaffolding to the optional extensions and the code review pass.
- [Running as a service](10-running-as-a-service.md): How podiumctl runs the server as a container or a standalone process, and how secrets, boot and the mod fit.
<!-- entries:end -->
