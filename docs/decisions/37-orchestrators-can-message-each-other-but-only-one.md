---
title: "37. Orchestrators can message each other, but only one person's own (#347)"
description: "Podium carries messages only between one person's own orchestrators, with owner-granted rights and switches off by default, widening the trust model."
group: "Project internals"
number: 37
date: "2026-10-18"
status: "accepted"
order: 37
---

# 37. Orchestrators can message each other, but only one person's own (#347)

**Context.** The maintainer had a development agent on a Mac and needed `systemd` tested on Linux, so a second
agent ran on a Linux machine and the maintainer pasted text between the two by hand. Podium already knows every
live session and owner, so it could carry that text. But this is a new kind of traffic: text one agent wrote
becomes input to another. #347 made the policy question the first step, since it could end the idea.

**Decision.** Podium carries messages between one person's own orchestrators, on any of their machines and any
OS (`docs/spec/` 1, 5.3, 5.9, 7.7 and 8.1). The server (#412), the mod (#414), My reporters (#415), the Admin's pages
(#416), Traffic (#417) and an owner's stricter limits (#436) are built. #347 records the design and the follow-up
issues, and `docs/MESSAGING.md` the setup.

- Only between reporters with the same owner. The server refuses a link between two owners.
- Podium carries the messages itself, through the reporter and the server, in the direction reporting already
  goes. It does not use Claude Code's own `SendMessage`.
- Rights belong to a pair of reporters and go one way, with a right to see and a right to send, and a reply
  needs its own right. A right to send is with or without approval.
- Three switches, all off by default: the Admin's flag, the `peers` option on each machine, and a right the
  owner gives on a new page, My reporters. An Admin can propose a right; only the owner can accept it. An
  Admin's pause applies at once.
- A message is a new turn in an orchestrator whose turn has ended, framed as a podium-reporter message, never
  as the person's own words. It never reaches an agent an orchestrator launched, and only an orchestrator sends.
- Secrets are replaced on the sending machine. The text is kept on the server for 30 days, and only the owner
  and an Admin can read it, on a new Traffic page and on My reporters.

**Why.**

- Anthropic's terms allow messaging within one person's sessions, but leave messaging between people unclear,
  so it is not built (the findings, with sources and dates, are on #347):
  - Claude Code ships cross-session messaging itself, and the mods API offers `$.session.send`,
    `$.prompt.submit` and `$.tool.register`.
  - The Consumer Terms forbid making an account available to anyone else, the Claude Code legal page says Pro
    and Max limits assume ordinary, individual use, and the Usage Policy in force from November 12, 2026 adds
    services that route requests through consumer subscriptions to its list of unauthorized access. Person B's
    agent starting turns in person A's session may fall under those, and nothing addresses consent or a
    self-hosted relay. It stays blocked until Anthropic answers the questions on #347.
- Claude Code's own messaging reaches another machine only through Remote Control, which needs a claude.ai
  sign-in and does not work with an API key, and it delivers between tool calls during a turn. Podium has people
  on API keys, and #347 wants a message never to interrupt a turn.
- A message sent with `$.prompt.submit` during a turn already waits for the turn to end (verified for #206), so
  delivering at a turn's end needs nothing new.
- A reporter is the stable unit. Sessions and agents come and go, so a right on them would not outlast the
  session.
- The owner's acceptance, and the `peers` option the server cannot change, keep the person in charge of what
  enters their sessions, even against an Admin or a compromised server.
- Keeping the text is what makes the exchange worth having: the maintainer wants to read what the agents said.
  Limiting who can read it follows the file diff (DECISIONS 36), since a message can hold source code.

**Alternatives.**

- Use Claude Code's `SendMessage` and `ListAgents`, with Remote Control on through `remoteControlAtStartup`, and
  have the reporter only watch and gate them. Rejected: no API keys, and delivery mid-turn.
- Messaging between people, with each owner accepting the link. Blocked on the terms, not rejected.
- Rights per session or per agent, dragged around by the Admin. Rejected: they do not outlast a session, and an
  Admin should not decide what enters a person's sessions.
- Showing a message that waits for approval as an ask in Respond, with the amber band. Rejected: the receiving
  session is working, not waiting on its person, and the band means it is waiting.
- Keeping nothing, as responding does, or redacting only in the console. Rejected: the first makes the exchange
  unreadable afterwards, and the second would leave the secret on the server.
- A list-of-links view on My reporters as well as the grid and the board. Dropped as too complex.

**Cost.**

- The trust model widens again. Anyone holding a person's token can put text into that person's linked
  orchestrators. That is why the switches are off by default and approval is the default for a new right.
- A message is another agent's text in a session. A receiving session in auto mode can act on it without asking.
  Its permission prompts still apply, but what auto mode allows is not a prompt. The #411 spike found the
  auto-mode classifier does not take a plugin's text as the person's intent, and the model refused the risky
  requests once Podium's opening line was there. Without that line it tried one (SPEC 5.3), so in accept-edits
  or bypass mode the line and the model's judgment are the only guard.
- Conversation text is stored on disk, which responding never does, and redaction is best effort.
- The design rests on the mods API, which is early access. The #411 spike checked it on Claude Code 2.1.303: a
  tool cannot be kept from subagents, so it refuses their calls; background agents do not hold a message back;
  and a toast plus `/podium`, registered to run mid-turn, answer a request (SPEC 5.3). A later version can change
  any of it.
- A managed organization that allows only managed mods turns the whole reporter off, messaging included.
- A spend cap and a hop count across chains (A to B to C) are not designed. The round-trip cap per link is the
  only loop guard. The #411 spike did not test chains.

<!-- nav:start -->
---

Previous: [36. A file's diff is source code, so only its owner can open it (#319)](36-a-files-diff-is-source-code-so-only-its-owner.md) · Up: [Decisions](README.md) · Next: [38. The Plan list ends with the done steps, in the order the server saw them finish (#454)](38-the-plan-list-ends-with-the-done-steps-in-the-order.md)
<!-- nav:end -->
