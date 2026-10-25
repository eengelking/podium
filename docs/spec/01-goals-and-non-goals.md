---
title: "1. Goals and non-goals"
description: "What Podium is for, the goals it must meet, and the things it must not become."
group: "Reference"
section: "1"
order: 1
---

# 1. Goals and non-goals

## Goals

1. Show all live Claude Code sessions on this machine, updating within about 2 seconds of a change, with no
   page refresh. A new session appears by itself. An ended session leaves by itself.
2. Per orchestrator: name, working directory, git branch, whether it is a worktree, ahead/behind/modified
   counts, model, effort, status, context fill, estimated cost, token count, elapsed time, resume command and fork command.
3. Per orchestrator: the plan it is working through (from its task list), step states, and which agent owns
   which step where that can be determined.
4. Per agent (subagent or fork): parent, kind, type, description, model, effort, status, context fill, tokens,
   estimated cost, elapsed time, skills it loaded, last tool, and a failure record when it failed.
5. Make context-window blowouts impossible to miss: count them per loop, flag a loop or session that blew
   out twice or more as likely to have lost context, and show when each one happened.
6. Make a failure explorable: show the failing call, its output, and the evidence for the likely cause.
7. Sort and filter: by status, model, context blowouts, context fill, cost, newest; agents by any column.
8. Activity stream that is capped in memory, pages 12 at a time, and links each row to the thing it is about.
9. Charts per orchestrator for the last 60 seconds: tokens per second, peak context in any loop with
   blowout markers, subagents running. Fleet-level sparklines for cost and tokens.
10. Color themes (Podium, Solarized, Nord, Gruvbox, Catppuccin, GitHub), each with light and dark, picked from
    a dropdown with a light, dark or system mode. Resizable side panels, keyboard accessible, usable at phone
    width.
11. Survive restarts: sessions, agents and events persist in SQLite. A restart of the server loses nothing
    that was already reported.
12. A simulator script that feeds the server realistic reports so the UI can be developed and demoed with no
    Claude sessions running.
13. Answer a session that waits on its person from the browser (#206, `mockup/podium-respond.html`): an
    AskUserQuestion form, a plan to approve, a tool's permission prompt, or a turn that ended. The terminal
    keeps working the whole time, and whichever answers first wins. Off unless the Admin and the session's
    owner both turn it on ([5.9](05-mod-api/05-09-mod-configuration-userconfig.md), [7.7](07-server/07-07-hardening.md)).

## Non-goals (do NOT build these)

**Control surface.** There is no general control surface (DECISIONS 28 replaced "Podium only observes").
Podium can answer a session that waits on its person, and only in the ways Claude Code's own dialogs offer:

- answer an AskUserQuestion (an option, a typed answer, or a message in place of an answer);
- approve a plan in one of three modes, or send it back with feedback;
- allow one tool call once, or deny it with a reason;
- send a new message, and run `/clear` or `/compact`.

All of it goes through podium-reporter inside the session, which fetches it from the server. The server never
connects to a session. It is off unless the Admin turns on **Respond from Podium** and the session's owner sets
the reporter's `respond` option ([5.9](05-mod-api/05-09-mod-configuration-userconfig.md)), and only the session's owner or an
Admin can use it ([7.7](07-server/07-07-hardening.md)).

Podium also carries messages between one person's own orchestrators, on any of that person's machines
(#347, DECISIONS 37). A message is a new turn in an orchestrator whose turn has ended, written by another
orchestrator. It is off unless the Admin turns on **Orchestrator messaging**, the reporter's `peers` option is on
at both machines, and the owner gave that pair of reporters the right
([5.3](05-mod-api/05-03-events-the-reporter-hooks.md#orchestrator-messaging-from-the-reporter-347), [7.7](07-server/07-07-hardening.md#orchestrator-messaging-347)).

Podium never:

- types into a terminal or opens one (the web terminal of #21 was not built);
- changes a session's permission rules ("always allow" stays in the terminal);
- runs any other slash command (`/model` and `/effort` included);
- edits a plan's text;
- starts, stops, resumes or kills a session or an agent;
- carries a message between two people's sessions, or delivers one to an agent an orchestrator launched
  (DECISIONS 37);
- lets a message between orchestrators answer an ask, run a command, or change a mode or a rule.

The dashboard may also copy a resume command or a fork command to the clipboard and remove a heartbeat-lost card from the live
view early ([7.5](07-server/07-05-lifecycle-timers.md)). Neither sends anything to a session.

**Hosting.**

- No hosted service. Several people may report to one server, each with their own token
  ([7.7](07-server/07-07-hardening.md)), but it is still one server you run yourself. The server binds to `127.0.0.1` by
  default. In the container image it listens on all interfaces inside the container, and the port is published
  only on the host's `127.0.0.1` ([4.4](04-architecture.md#44-packaging-running-and-distribution)). Reaching it from other
  machines is an explicit choice (`--bind`). Over plain HTTP it needs a trusted network or a TLS proxy. With
  built-in TLS turned on ([7.7](07-server/07-07-hardening.md), *Built-in TLS*) the server opens a second port, for reporters only, that
  needs a client certificate. The console stays on plain HTTP.
- No hosted deployment, accounts, or cloud sync. A container on the same machine is not a hosted deployment.

**Cost.** No billing accuracy. Cost is an estimate from token counts and a price table. The UI always labels
it as an estimate. Never present it as an invoice.

**Conversation content.** No reading of conversation transcripts. Podium sends short excerpts only
([section 6.4](06-reporter-protocol/06-04-failure-and-excerpt-rules.md)), never whole messages or files. There are five opt-in exceptions:

- With the `fullPrompts` option on, an agent's own task prompt and final answer go out whole (up to 20,000
  characters each, [6.4](06-reporter-protocol/06-04-failure-and-excerpt-rules.md)), never the conversation around them.
- With the `activityFeed` option on (#118), while someone watches an agent's panel, that loop's recent tool
  calls and the text it writes between them go out as short entries (300 characters each, the last 20,
  [6.4](06-reporter-protocol/06-04-failure-and-excerpt-rules.md)), and only for as long as someone watches. If the Admin has chosen to
  keep the Activity history (#432, off by default), they go out for every running loop of the session whether
  or not anyone watches, and the server stores them until the Admin's period ends; only the session's owner
  and an Admin can read what is stored ([7.7](07-server/07-07-hardening.md)).
- With the `activityFeed` option on, a Bash call's whole command (up to 20,000 characters, redacted) goes with its
  entry, and the Activity history stores it like the rest of the entry (#431). A command's output goes out only
  with the separate `activityOutput` option on, only while a viewer has that loop's feed open, and is never stored
  ([6.4](06-reporter-protocol/06-04-failure-and-excerpt-rules.md)). Whether the call has finished and how it ended (`done`, `failed`,
  `exitCode`) is not output: it goes with the entry whenever the call finishes, with or without output (#598).
- With orchestrator messaging on (#347), the text of a message one orchestrator sends another goes to the
  server and is kept there for 30 days, with secrets replaced on the sending machine. Only its owner and an
  Admin can read it ([7.7](07-server/07-07-hardening.md#orchestrator-messaging-347)).
- With session recording on (#353, `mockup/podium-recording.html`), everything one session's orchestrator and its
  chosen agents do goes to the server whole: prompts, the model's text, tool inputs and their results, file contents
  and command output, with secrets replaced on the machine. It needs three yes answers (the Admin's `session-recording`
  flag, a choice by the session's owner or an Admin, and the reporter's `sessionRecording` option, off by default),
  it is kept for 6 hours unless the Admin sets longer (7 days at most), and only the session's owner and an Admin can
  read it. The session is marked as recorded on its card and its page for as long as it is, and the owner's terminal
  says so ([6.4](06-reporter-protocol/06-04-failure-and-excerpt-rules.md#session-recording-opt-in-353), [7.7](07-server/07-07-hardening.md#session-recording-353)).

The model's thinking text is never sent. A recording marks where the model thought and says that the text is not
available ([6.4](06-reporter-protocol/06-04-failure-and-excerpt-rules.md#session-recording-opt-in-353)).

**Other exclusions.**

- No usage dashboard. The earlier one was removed (issue #30); it is not replaced.
- No terminal UI or pane inside Claude Code in this spec. A minimal `/podium` command and a status-line entry
  are in scope; a full pane is deferred ([section 11](11-out-of-scope-and-deferred.md)).
- No accounts, passwords, per-person read permissions or roles beyond one: administrator. Authentication is a
  token per person plus an admin secret that opens the Admin section (signed in with the name `Admin`). A
  person in the built-in Administrators group may open Admin with their own name and token too
  ([section 7.7](07-server/07-07-hardening.md)). A person also signs in to the console with their own token, but only to
  respond to their own sessions and to manage their own reporters on My reporters (7.7). Reading the console
  stays open, except a file's diff and the text of a conversation between orchestrators.
- No new chart or UI libraries beyond those in [section 2](02-tech-stack.md). Charts are inline SVG, as in the
  mockup.

---

<!-- nav:start -->
---

Up: [Specification](README.md) · Next: [2. Tech stack](02-tech-stack.md)
<!-- nav:end -->
