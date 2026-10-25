---
title: "What leaves a session"
description: "See what data leaves a session, where it goes and how secrets are removed first."
group: "Getting started"
order: 10
---

# What leaves a session

Data leaves a session only to the server URL you set, and only the fields
[REPORTER.md](../REPORTER.md#what-leaves-the-session) lists. Text is cut to fixed limits, and anything that looks like a
secret is replaced with `[redacted]` before it is sent. Podium does not read whole conversations or send whole files, except through the opt-in options that REPORTER.md lists.

| What | When it leaves the session |
|---|---|
| An agent's whole task prompt and final answer | Only if you turn on the mod's `fullPrompts` option (off by default) |
| What an agent is doing (recent tool calls and the text it writes, each cut to 300 characters) | Only if you turn on the mod's `activityFeed` option (off by default), and even then only while someone has that agent's panel open in the console, unless the server's Admin chooses to keep activity history, which stores it for every running agent until the Admin's period ends |
| The diff of one changed file | Only if you turn on the mod's `fileDiff` option (off by default) and the Admin turns on the File diff switch, and only when the session's owner opens that file in the console. It is source code with anything that looks like a secret replaced by `[redacted]` on your machine (best effort, not a guarantee; files such as `.env` and keys are never sent), shown to that one person and not kept by the server |
| What a session waits on you for (a question with its options, a plan, or a tool's arguments) | Only if you set the mod's `respond` option (`off` by default) and the server takes answers. Only the session's owner and an Admin can see it, and the server keeps it in memory only |
| Everything a session does, whole: prompts, tool inputs and results | Only if you turn on the mod's `sessionRecording` option (off by default), the Admin turns on Session recording, and the session's owner or an Admin chooses to record it. Secrets are replaced on your machine (best effort). Kept 6 hours by default, readable only by the owner and an Admin, and marked as recorded for everyone while it runs. See [REPLAY.md](../REPLAY.md) |
| Your name and your machine | Only once you set the mod's `userName` option (empty by default) |
| The model's thinking | Never |

Once `userName` is set, each report carries that name, the machine's short host name and a random id the mod keeps for
this machine. The mod keeps the host name it first read in `podium-machine-name` in the Claude config directory, next
to the id, so one machine keeps one name when the network changes the name your system reports. If the name is wrong,
delete that file and the next session reads it again. Everyone who can open the console sees them. Podium never reads your operating system user name or
`git config` for this.

The name shown on a session comes from the token that sent it, not from `userName`. The server checks that the two match,
so nobody can report under your name without your token.

<!-- nav:start -->
---

Previous: [Updating the mod](09-updating-the-mod.md) · Up: [User guide](README.md) · Next: [Remove it](11-remove-it.md)
<!-- nav:end -->
