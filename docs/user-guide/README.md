---
title: "User guide"
description: "Set up Podium, read the console, answer a waiting session, use Admin and fix common problems."
group: "Getting started"
entries: "list"
---

# User guide

How to set up Podium, read the console and fix common problems. It is for anyone who runs Claude Code sessions and
wants to watch them, and for the person who runs the server, whose part is in [Admin](05-admin/README.md).

Podium shows every Claude Code session on your machine in one browser tab. It watches. The one thing it can send is an
answer to a session that is waiting on you (a question, a plan, a tool's permission prompt, a message, `/clear` or `/compact`), and only
when the server's Admin and the session's owner have both turned on [answering from Podium](04-reading-the-console/12-answering-a-session-from-podium.md). It
never types into a terminal.

Related docs: [REPORTER.md](../REPORTER.md) for the mod's options, [SERVER.md](../SERVER.md) for the server's settings,
[MESSAGING.md](../MESSAGING.md) for setting up orchestrator messaging, [REPLAY.md](../REPLAY.md) for recording a session and
replaying it, and [docs/gotchas/](../gotchas/README.md) for sharp edges.

## Pages

<!-- entries:start -->
- [What you need](01-what-you-need.md): Check that your machine has the software Podium needs before you set it up.
- [Set it up](02-set-it-up.md): Start the server, install the reporter mod and check that your sessions appear in the console.
- [Something is wrong](03-something-is-wrong.md): Match what you see to its likely cause and fix, from a missing session to a refused report.
- [Reading the console](04-reading-the-console/README.md): Learn what the top bar, rail and panels show, and how to read each view of the console.
- [Admin](05-admin/README.md): Run the server as its Admin: manage people, groups, reporters, settings, prices, certificates and stored data.
- [Everyday commands](06-everyday-commands.md): Look up the podiumctl commands you use day to day and what each one does.
- [Logs](07-logs.md): Read the server's logs, choose what they hold, send them to VictoriaLogs and query them.
- [Sessions you started without the mod](08-sessions-you-started-without-the-mod.md): See sessions that started before the mod was installed, using Claude Code's settings hooks.
- [Updating the mod](09-updating-the-mod.md): Update the mod when a card says its reporter is out of date, and know what each message means.
- [What leaves a session](10-what-leaves-a-session.md): See what data leaves a session, where it goes and how secrets are removed first.
- [Remove it](11-remove-it.md): Remove Podium, its data and the mod from your machine.
<!-- entries:end -->
