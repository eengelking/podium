---
title: "About"
description: "See which Podium server, libraries, database and reporter versions are running, and copy them to share."
group: "Getting started"
order: 14
---

# About

What software this server and its reporters are running, in one place. Open **About** at the bottom of the Server
group. Nothing here is collected from a machine for this page: the server reads its own facts, and the reporter
versions are the ones reporters already sent.

- **Podium server.** The version and, when the server is not a tagged release, the build it came from. **Running as**
  says Container or Stand-alone. **Started** gives the time and how long the server has been up, and **System** the
  operating system and architecture.
- **Built with.** Node.js and Express as the server runs them, and React and TypeScript as the console was built with.
- **Database.** The adapter in use (SQLite or PostgreSQL), the database's own version, the schema version Podium
  reached, and the size when the database can say.
- **Reporters.** One row for each reporter and version heard from in the last hour, with how many machines run it.
  When reporters are on different versions, each version has its own row. A version outside the range this server reads
  carries the same warning as on [Reporters](05-reporters.md), and **This server reads** shows that range, so a flag
  explains itself. Hooks-only senders have no version and are left out. With no reporter connected the page says so.

**Copy details** puts everything on the page on the clipboard as plain text, so you can paste it into a bug report or a
chat. The button reads **Copied** for a moment, and **Copy failed** when the browser refuses. The page reads again every
30 seconds, so a reporter that connects appears without a reload.

A newer release being available is not shown here.

<!-- nav:start -->
---

Previous: [Admin log](13-admin-log.md) · Up: [Admin](README.md)
<!-- nav:end -->
