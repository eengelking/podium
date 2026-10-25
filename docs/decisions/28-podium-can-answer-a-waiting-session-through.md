---
title: "28. Podium can answer a waiting session, through the reporter, not through a terminal"
description: "The owner or an Admin can answer a waiting session from the browser through the reporter, widening the trust model, so five switches default to off."
group: "Project internals"
number: 28
date: "2026-10-15"
status: "accepted"
order: 28
---

# 28. Podium can answer a waiting session, through the reporter, not through a terminal

**Context.** The maintainer's real goal behind #21 was answering a session that stopped to ask, without going
back to the terminal or the desktop app.

**Decision.** Podium is no longer observe-only (this supersedes 1). When a session waits on its person, the
owner or an Admin can answer from the browser (#206, `docs/spec/` 5.3 and 7.7):

- an AskUserQuestion form (an option, a typed answer, or a message in place of an answer)
- a plan (approve in one of three modes, or send it back with feedback)
- a tool's permission prompt (allow once, or deny with a reason)
- a turn that ended (a new message, `/clear` or `/compact`)

How it works:

- Everything goes through podium-reporter. Its hooks race Claude Code's own dialog against an answer from the
  server, and whichever comes first wins, so the terminal keeps working the whole time.
- The mod fetches answers from the server, in the same direction as reporting, and the server never connects
  to a session.
- It is off unless five switches are on: authentication, the Admin's **Respond from Podium** flag, the
  Admin's activity feed flag, and on the machine the reporter's `respond` option and `activityFeed` option.
- The `respond` option has four levels, so the person running a session decides how much it accepts, and the
  mod enforces that itself.
- "Always allow", any other change to permission rules, and every slash command but `/clear` and `/compact`
  stay in the terminal.
- The web terminal asked for in #21 was not built.

**Why.**

- A browser terminal into the session's tmux would do far more than the goal needs and cover too few
  sessions. It hands the browser raw keystrokes into the session, works only for sessions inside tmux, can't
  see the host's tmux from the container, and would need SSH or a tunnel for another machine.
- The Claude Code mod API gives a narrower path that reaches every session the reporter already sees.
- A spike against a real Claude Code 2.1.301 session (comments on #206) showed each case working, once a
  plan approval echoes the tool's input back as `updatedInput`.
- A held request lets an answer land within a second or two, and needs no listening port in the session.
- `/model` and `/effort` were left out. `/model` also saves the model as the default for new sessions, and
  `/effort` opens a confirmation only the terminal can answer.

**Cost.**

- The trust model is no longer "the mod can only report". Anyone holding a person's token, or the admin
  secret, can put text into that person's opted-in sessions. So the switches are off by default, every
  answer needs a credential even though reads are open, and each answer is written to the admin log without
  its text.
- The browser now signs in with a token, which travels over plain HTTP unless a TLS proxy is used.
- Plan approval rests on behavior Claude Code doesn't document (anthropics/claude-code#97656 is open), so the
  mod confirms that each approval took and otherwise leaves the plan to the terminal.
- Where an organization manages Claude Code, PermissionRequest hooks don't run in a user-installed plugin,
  so tool permissions and plan approval can't be answered there.
- A pending answer is kept in memory only, so a server restart loses it.
- The mod's hooks for an open ask now wait on the network on purpose, which the reporter never did before.

<!-- nav:start -->
---

Previous: [27. The wall's cards stretch, in at most four columns](27-the-walls-cards-stretch-in-at-most-four-columns.md) · Up: [Decisions](README.md) · Next: [29. A session keeps the Podium identity it started with](29-a-session-keeps-the-podium-identity-it-started.md)
<!-- nav:end -->
