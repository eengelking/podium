---
title: "Specification"
description: "The build spec: what Podium must do, its intended behavior and requirements, one page per section."
group: "Reference"
entries: "list"
---

# SPEC: Podium, a live fleet console for Claude Code orchestrators

| | |
|---|---|
| Status | Implemented. Amended after the first build for the container, `podiumctl` and the marketplace install ([section 4.4](04-architecture.md#44-packaging-running-and-distribution)) |
| Weight class | Phased (single implementing agent, one phase at a time) |
| Visual reference | `mockup/podium.html` (authoritative for look, layout, copy and behavior of the UI) |
| API reference for the mod | The `plugin-authoring` skill and its bundled `types/claude-code.d.ts` (see [section 5.1](05-mod-api/05-01-where-the-truth-is.md) for how to find it) |

Podium shows every Claude Code session running on one machine in one browser tab. Each session is an
**orchestrator**: a main agent that can launch **subagents** (blank slate) and **forks** (a copy of the
orchestrator that keeps its context). For each orchestrator, Podium shows:

- its model and effort, and its plan;
- the tree of agents it launched, and what each agent costs;
- how full each context window is, and whether it blew out that window;
- why anything failed;
- which git branch or worktree it works in.

Orchestrators appear when a session starts and disappear when it ends, with no refresh.

Podium is built from three parts:

- a **reporter mod** that runs inside every Claude Code session and sends snapshots;
- a **server** that stores and serves them;
- a **browser UI** that renders them live.

This repo began with an earlier app (`server/`, `frontend/`) that charted Claude Code and Admin API usage.
Podium was added next to it, and that usage dashboard has since been removed (issue #30).

## How to read this document

This is the source of truth for intended behavior. `docs/architecture/` records how it was built.

| If you want | Read |
|---|---|
| What Podium is for, and what it will not do | [Section 1](01-goals-and-non-goals.md) |
| How the pieces fit and run | Sections [2](02-tech-stack.md) to [4](04-architecture.md) |
| How the reporter mod talks to Claude Code | [Section 5](05-mod-api/README.md) |
| The data that crosses the wire | [Section 6](06-reporter-protocol/README.md) |
| The server: routes, storage, timers, security | [Section 7](07-server/README.md) |
| The browser UI | [Section 8](08-ui/README.md) |
| The build order and acceptance tests | [Section 9](09-phased-build-plan.md) |

## Pages

<!-- entries:start -->
- [1. Goals and non-goals](01-goals-and-non-goals.md): What Podium is for, the goals it must meet, and the things it must not become.
- [2. Tech stack](02-tech-stack.md): The technology choices for the mod, server, database, UI and tooling, with the reason for each.
- [3. Glossary](03-glossary.md): The terms the spec uses (session, orchestrator, agent, fork, blowout and more) and what each one means.
- [4. Architecture](04-architecture.md): How the three parts fit: repo layout, ports, who owns which data, and packaging, running and distribution.
- [5. The Claude Code mod API: everything the reporter needs](05-mod-api/README.md): The reference for the Claude Code mod API the reporter uses: what is verified, what is assumed, and where to look.
- [6. The reporter protocol](06-reporter-protocol/README.md): The data that crosses the wire between the reporter and the server: the report, its rules and version compatibility.
- [7. The server](07-server/README.md): The server's requirements: routes, database, ingest, view types, timers, the live stream and hardening.
- [8. The UI](08-ui/README.md): What the browser UI must do and how it is built: requirements, components, tokens and accessibility.
- [9. Phased build plan](09-phased-build-plan.md): The build order in phases 0 to 5, with the tasks and acceptance tests of each.
- [10. Rules for the implementing agent](10-rules-for-the-implementing-agent.md): The repository rules, quality bar, order of work and report an implementing agent follows.
- [11. Explicitly out of scope / deferred](11-out-of-scope-and-deferred.md): What is out of scope or deferred, and what the design must not preclude.
- [12. Open questions and flagged assumptions](12-open-questions.md): The open questions and flagged assumptions an implementer verifies, with where each answer is recorded.
<!-- entries:end -->
