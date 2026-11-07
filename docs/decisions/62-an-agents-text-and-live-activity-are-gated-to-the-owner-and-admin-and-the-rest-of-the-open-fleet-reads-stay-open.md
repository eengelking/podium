---
title: "62. An agent's text and live activity are gated to the owner and an Admin, and the other open fleet reads stay open (#1076)"
description: "R5 and R6 move behind sign-in with the Admin notice; the session view, events and history stay open as how the wall looks."
group: "Project internals"
number: 62
date: "2026-11-07"
status: "accepted"
order: 62
---

# 62. An agent's text and live activity are gated to the owner and an Admin, and the other open fleet reads stay open (#1076)

## Context

The audit in #1043 found five fleet reads that need no sign-in, so the server cannot say who the reader is:

- R5, `GET /api/fleet/sessions/:id/agents/:agentId/text`, returns an agent's whole prompt and answer, which can be tens of kilobytes.
- R6, `GET /api/fleet/sessions/:id/agents/:agentId/activity`, returns an agent's recent tool calls and takes the viewer's lease on that loop.
- R7, `GET /api/fleet/sessions/:id`, `/events` and `/history`, return names, states, counts and the event lines the wall shows.

PROJECT.md says an Admin never reads a person's content in silence, with no exception. An Admin who opens R5 or R6 reads in silence today, because nobody is named as the reader and nobody is told. SECURITY.md listed all five as open on purpose, as how the wall looks.

## Decision

R5 and R6 are gated: they need a sign-in as the session's owner or an Admin. When an Admin reads one, the owner is told in the console and in `podium-reporter` (the red notice naming the Admin, the permanent record line without the text, the reporter callout to the person only, and an Admin log entry). R7 stays open, as how the wall looks to anyone who can open the console.

This entry records the decision. It builds no gate. The work is its own issue.

## Why

- A prompt and an answer, and the tool calls of a running agent, are the person's own content. They are not on the wall, and the code already keeps them out of the state and the stream for that reason. The rule that names content applies to them.
- R7 is what the wall already shows to everyone: names, states, counts and the event lines. Gating it would take away what the console is for, and would change it for every viewer.
- Splitting at R5 and R6 uses a line the code already draws: what is in the state and the stream is open, and what is fetched on open is not.

## Alternatives

- **Gate R5, R6 and R7.** The strictest option. It changes the wall for every viewer, and R7 mostly repeats what the wall shows.
- **Declare all five out of the rule.** Nothing to build, but it makes an exception to a rule that has none, for whole prompts and answers.

## Cost

- The console no longer opens an agent's text or live activity for a viewer who has not signed in. A viewer who is not the owner or an Admin sees a refusal in place of the text.
- R7's event lines are not audited. If one is found to hold content that the wall does not show, it is filed as its own issue and moves to the gated side.
- Until the build issue merges, R5 and R6 stay open, and SECURITY.md says so.

<!-- nav:start -->
---

Previous: [61. Chat keeps each audience in its own table, and a person may write to another person's agent only with its owner's approval (#1034)](61-chat-keeps-each-audience-in-its-own-table-and-a-person-may-write-to.md) · Up: [Decisions](README.md)
<!-- nav:end -->
