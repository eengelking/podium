---
title: "72. An Admin responds only when the owner allows it, and every message names its sender (#1251)"
description: "An Admin needs the owner's allow, per reporter and off by default, to respond to a person's session. Every message from Podium is framed with its sender."
group: "Project internals"
number: 72
date: "2026-11-20"
status: "accepted"
order: 72
---

# 72. An Admin responds only when the owner allows it, and every message names its sender (#1251)

*Amends 28: the owner or an Admin could answer a waiting session. An Admin now needs the owner's allow. Builds on 62, whose Admin read notices stay as they are.*

## Context

An Admin, or the admin secret, could send a message, run `/clear` or `/compact`, or answer a question, plan or tool prompt on any person's session. The owner was not asked and saw only a terminal line. Chat already asks the owner before another person's message reaches their agent (#1034), so an Admin had more reach into an agent than any other person.

The maintainer also found that a message from Podium Chat reached the Claude Code model as bare text. Only the engine's own wrapper said it came from a plugin. OpenCode prefixed an unquoted label, so the two harnesses read differently, and the text could hold a line that looked like Podium's own.

## Decision

- **An Admin responds to a person's session only when that person has allowed it.** The allow is kept for one of the owner's reporters, is off by default, and is the owner's alone to give and take back. It is a link from the Admin (`person:admin`) to the reporter in `peer_rights`, the table that holds a person's link to another person's agent, so no table or column changed in any storage adapter.
- **The owner sets it in My reporters**, as an "Admin may respond" column in Your reporters (`PUT /api/fleet/respond/peers/reporters/:key/admin-respond`). That page exists while the Admin has orchestrator messaging on, so with it off an Admin cannot be allowed.
- **A session owned by Admin or by no one needs no allow.** There is nobody to give it, and an Admin responds to those as before.
- **An Admin still reads.** The Respond window opens for an Admin, shows the ask in full and tells the owner, as 62 requires. Without the allow the answer controls and the message box are replaced by one note that says why.
- **A refused try is told.** The Admin gets a refusal in words. The server records it in the Admin log without the text, on the owner's `act:` thread, and in the reporter as a callout shown to the person and never sent to the model.
- **Every message from Podium is framed in `plugin/core/peers.ts` (`podiumPrompt`), the same in every harness:** the sender, a rule line, the text with every line quoted, and an end line. The sentences that say where to answer follow the end line. An Admin's message says the sender is an Administrator, that the owner allowed it, and that the owner's own instructions do not change because of it. The server marks each message with `via` (`chat`, `channel` or `console`) and, for an Admin's, `admin` and `owner`. A reporter that gets a message with no `via` keeps the text as it was.
- **A command tells the model nothing and needs nothing.** `/clear` and `/compact` are run by the host, not submitted as a prompt. The person sees who sent them in the terminal line, as before.

## Why

- Responding to an agent is a trust the owner gives. Chat and the Admin's own stops already follow that, so an Admin's reach into a session is the exception that had no guardrail.
- Reusing the link keeps the allow in the table that already answers "may this person send to this agent", with the same pause and remove behavior and the same contract cases.
- Framing in `plugin/core/` makes the two harnesses read the same. Quoting the text and closing it stops a line inside it from passing as Podium's.

## Alternatives

- **A new column on the owner's settings.** One switch for every reporter, but a schema change and migration in all three adapters. The allow is per reporter either way, which the link already is.
- **Dim Respond for an Admin without the allow.** Rejected: the Respond window is how an Admin reads someone's waiting ask (#1073), so dimming it would remove that read.
- **Put the switch in the Activity window.** An owner opens it only after something is already blocked. My reporters is where an owner already sets what others may do with their reporters.

## Cost

- With orchestrator messaging off, there is no My reporters page, so an Admin cannot be allowed to respond. The cost is the page's existing dependency on that switch.
- A reporter older than this version ignores `via` and keeps the old text for a message. The server still refuses an Admin without the allow, so only the framing is missing.
- An Admin can still discard a message that has not been handed over yet (`DELETE /respond/deliveries/:id`). That is the Admin's power to stop and is not changed here.

<!-- nav:start -->
---

Previous: [71. A message handed over mid-turn is read between tool calls (#1264)](71-a-message-handed-over-mid-turn-is-read-between-tool-calls.md) · Up: [Decisions](README.md)
<!-- nav:end -->
