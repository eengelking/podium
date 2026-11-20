---
title: "70. A message is handed over while the agent works, and the host decides when it is read (#1252)"
description: "The server holds a message only at a permission prompt; a running turn or subagent no longer holds it. Neither harness reads it mid-turn."
group: "Project internals"
number: 70
date: "2026-11-19"
status: "accepted"
order: 70
---

# 70. A message is handed over while the agent works, and the host decides when it is read (#1252)

*Amends 37: a message no longer waits at the server for the receiver's turn to end.*

## Context

A message between agents, or from Chat to an agent, used to be handed over only when the server counted the receiver idle. In Claude Code the card stays `running` while any subagent is running or never got its stop event, so an orchestrator at its prompt with one subagent still going took nothing until every subagent ended. The maintainer reported messages that arrived long after they mattered, and suggested delivering early with an instruction to the agent to read it, carry on if it is not critical, and stop to respond if it matters more than the work.

## Decision

- **The server holds a message only while a permission prompt is open** (the message would answer it), and never hands one to a session that is `done`. A running turn and a running or stuck subagent do not hold a message back. The reply to the receiver's next report carries it, so it is handed over within about the report interval.
- **A message handed over while the agent is mid-turn ends with Podium's own note**, after the quoted text, in `plugin/core/peers.ts` (`MID_TURN_NOTE`), the same for every harness: it was sent while the agent was working, read it, carry on if it is not urgent, stop and respond if it matters more. The sender cannot set or word it, and the sender's text stays quoted. There is no urgency flag on `podium_send`.
- **Podium does not promise that the agent reads it mid-turn.** A live run on both harnesses showed that the host queues the prompt behind the running turn: Claude Code shows it as a queued prompt and takes it at turn end, and OpenCode accepts `session.prompt` within seconds but stores the message after the turn completes. Neither read a message between tool calls. What the sender is told says "handed over within seconds" and that a busy agent reads it when its turn ends.
- **The wait is recorded** in the `peers.delivered` log line as `waited_ms`, from send to the result. For OpenCode the result is the host accepting the prompt, which is earlier than the agent reads it.
- **A permission wait a subagent raised ends with that subagent's own call**, not only with a main-loop call, so a stale wait no longer holds the card at `waiting`/`permission`.

## Why

- Delivery is no longer hostage to a status that subagents and a stale wait can pin. The idle-at-prompt agent with a subagent is the case the maintainer saw.
- Handing over early costs nothing the agent does not already accept: the host queue decides when it is read, and the person's own rules, the respond switches and `accepts` still decide whether it is taken at all.
- A note the agent can weigh is safer than a rule the server applies, because only the agent knows what it is doing.

## Alternatives

- **Inject into the running turn.** Neither Claude Code nor OpenCode takes a prompt in the middle of a turn through the API the reporters use (OpenCode's `steer` was deferred in #1033). A hook that adds context between tool calls might, and is its own piece of work (#1264).
- **A sender flag for urgency.** The sender's claim about its own message would sit next to Podium's words. Rejected: the agent weighs the quoted text itself.
- **Change the card status so a subagent does not hold it at `running`.** That changes what the wall shows and is wider than delivery.

## Cost

- A busy agent still reads a message only when its turn ends. A message that matters more than the work waits for it, and the note cannot change that.
- On OpenCode, `waited_ms` and "delivered" mean the host took the message, not that the agent read it.
- A subagent that never reports its stop still holds the card at `running` (#1262).

<!-- nav:start -->
---

Previous: [69. Public channels are a catalogue inside the public audience (#1035)](69-public-channels-are-a-catalogue-inside-the-public-audience.md) · Up: [Decisions](README.md)
<!-- nav:end -->
