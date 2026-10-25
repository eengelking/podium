---
title: "The wall"
description: "Read the wall: the tiles at the top and the card for each session, and filter them."
group: "Getting started"
order: 4
---

# The wall

The default view (`#/`) is a card per session. At the top are six tiles: Orchestrators live, Subagents running, Context
blowouts, Plan steps done, Est. cost today and Tokens, last minute. Below them you can:

- filter by status (All, Running, Waiting, Stale, Blowouts),
- sort (Status, Model, Context blowouts, Context used, Cost, Newest),
- search by name, project or branch.

## What a card shows

- The session's name and status.
- Its project and git branch (or worktree, with ahead and behind counts and how many files changed).
- Its model, effort and context fill.
- Its plan with the current step, or "No plan reported. Agents were launched ad hoc." (see
  [Gotchas](../../gotchas/session-shows-no-plan.md)).
- A strip with one square per agent.
- Its cost, tokens and running time.

Tokens is the context the session and its agents hold right now, the same figure Claude Code shows for an agent. Hover it
for the definition. A path or branch that is too long for the card is shortened (the path from the front, the branch at
the end). Hover it to see the full value.

## Card states

| State | What it means |
|---|---|
| Red callout | The session has blown out its context window twice or more, which usually means it has lost context |
| **Waiting** | The session wants you: a permission prompt, a question, or the end of its turn. The card says whether it needs your approval or your input |
| **Stale** | The session has stopped reporting. The card says how long until it goes away by itself |

A stale card has a **Remove** button (also on its rail row, and **Remove now** on its page) to clear it at once. The
session stays in History, and the card comes back if the session reports again.

<!-- nav:start -->
---

Previous: [What it costs to run](03-what-it-costs-to-run.md) · Up: [Reading the console](README.md) · Next: [The board](05-the-board.md)
<!-- nav:end -->
