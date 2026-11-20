---
title: "71. A message handed over mid-turn is read between tool calls (#1264)"
description: "Claude Code adds it as context to the main loop's next tool result and OpenCode steers it in, so an agent reads it before its turn ends."
group: "Project internals"
number: 71
date: "2026-11-20"
status: "accepted"
order: 71
---

# 71. A message handed over mid-turn is read between tool calls (#1264)

*Amends 70: a busy agent no longer waits for the end of its turn to read a message, where its harness has a way to add context between tool calls.*

## Context

Decision 70 handed a message over within seconds and ended it with a note, but a live run showed that both harnesses queued the submitted prompt behind the running turn. A message that mattered more than the work (the runner example in #1252) still waited for the whole turn. The #1033 spike had found that OpenCode's `delivery: 'steer'` lands a prompt at the next step of a running turn, in 4 of 4 runs on two models, and that Claude Code's `$.prompt.submit` has no such mode. Claude Code does have a classic hook that adds context to a tool result: `PostToolUse` takes `additionalContext`, which the engine hands to the model with the result.

## Decision

- **OpenCode** submits a message handed over while any of the root's sessions is executing with `delivery: 'steer'`, and an idle one with `queue` as before. The frame, the quoted text, the mid-turn note and the limits (the owner's allow, the respond switches, `accepts`) are the shared ones from `plugin/core/peers.ts`.
- **Claude Code** does not submit a prompt for a message handed over while the main loop works. The reporter holds the framed text (`plugin/claudecode/hooks/midTurn.ts`) and the main loop's next `PostToolUse` or `PostToolUseFailure` returns it as `additionalContext`, then reports `took`. A subagent's tool result takes nothing, because the message is the orchestrator's. A turn that stops before any tool result submits what is held as a prompt, so no message is lost.
- **A lead line from the reporter plugin** (`HELD_LEAD`, `plugin/claudecode/hooks/midTurn.ts`) sits above the framed message in that context. It says who adds it and why, and does not vouch for the message: the frame still says it is another agent's text and cannot approve anything.
- **Neither interrupts a tool that is running.** The agent reads the message after the tool it is on finishes, and decides, as the note says, whether it matters more than the work.
- **What a sender is told** says the agent reads it at its next step, after the tool call it is on. The Chat and Traffic "Waiting" line still says "when its turn ends"; it is standards copy (`docs/standards/`) and its change is the maintainer's decision, so it is left as it is and named in the PR.

## Why

- It is the one thing #1252 could not do and the reason the note exists: the agent can stop and respond while the work is still going.
- Each harness uses the host's own way to add context at a step boundary, so Podium types nothing into a terminal and sends no new kind of message. The person's rules, the respond switches and `accepts` still decide whether it is taken at all.

## Alternatives

- **Submit a prompt on Claude Code anyway.** It is queued behind the turn, as decision 70 found.
- **Hold it until the turn ends on both, so the harnesses read the same.** Both harnesses can read sooner, and a wall that says one reads sooner than the other would be false for no reason.

## Cost

- **Claude Code's smaller models may not act on it.** A live run (Claude Code 2.1.329, auto mode, five `sleep 20` calls) delivered the message between tool calls every time. Without the lead line haiku ignored it twice. With it, haiku ignored it in 2 of 2 runs and said it was an instruction in a tool result that the person had not given, and sonnet replied 4 seconds after it arrived in 1 of 1. A model that treats a tool result's text as untrusted is doing what it should, so the wording is not pushed further to beat that. The agent reads the message and decides, as the note says, and one that declines reads it at the latest when its turn ends. OpenCode's `steer` arrives as a user message, and its free model replied between sleeps in 1 of 1 runs.
- A message read between tool calls is context on a tool result in Claude Code, which a person sees in the transcript as hook output and not as a prompt.
- A turn with no tool call has no boundary: Claude Code hands it over when the turn stops, and OpenCode's `steer` has only been run with a tool in progress.
- OpenCode's `steer` into a session with an open permission ask has not been tried. The server holds a message at a permission prompt, so it does not arise.

<!-- nav:start -->
---

Previous: [70. A message is handed over while the agent works, and the host decides when it is read (#1252)](70-a-message-is-handed-over-while-the-agent-works-and-the-host-decides-when-it-is-read.md) · Up: [Decisions](README.md)
<!-- nav:end -->
