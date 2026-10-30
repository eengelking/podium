---
title: "On Windows, /podium says offline with HTTP 502 when the config file names localhost"
description: "A config issued for https://localhost:4318 cannot work from another machine; edit its # server: line to an address that machine reaches."
group: "Project internals"
area: "Connecting the mod"
date: "2026-10-30"
status: "open"
order: 59
---

# On Windows, /podium says offline with HTTP 502 when the config file names localhost

**You see:** On another machine, the Windows 11 desktop app for example, `/podium` shows `Connection: offline, retrying` and `Last error: HTTP 502`,
though the file is found: the `Home folder:` line is there, and `TLS:` does not say `config unreadable`. The `TLS:` line gives no reason, because the mod words certificate problems and has nothing to say about a server it cannot reach.

**Why:** The reporter sends to the address in the config file's `# server:` line, and ignores the `serverUrl` option once a file is found. A file
issued while the console was opened as `https://localhost:4318` says `localhost`, which on the other machine is itself, where nothing listens. The
helper's connection is refused and it answers 502 (the same shows over a socket on macOS and Linux). The address must also be one the server
certificate covers: the certificate names `localhost`, `127.0.0.1` and the machine's address when the server was started with it.

**Do:**

1. Open the config file in a text editor and change the `# server:` line to an address that machine reaches, for example `# server: https://192.168.1.20:4318`.
   Leave every other line as it is.
2. Start a new session and run `/podium`. `TLS:` should say `connected over HTTPS`.
3. If `TLS:` names the address instead (`ALTNAME`), the server certificate does not cover it: start the server so that it does, then ask an Admin for a new file
   (Admin > People), which is issued for the address you open the console at.

<!-- nav:start -->
---

Previous: [Blowouts 1x on a card that is nowhere near full](blowout-on-a-card-nowhere-near-full.md) · Up: [Gotchas](README.md) · Next: [Listening on a .sock path fails with EACCES on Windows, whatever the folder](listening-on-a-sock-path-fails-with-eacces-on-windows.md)
<!-- nav:end -->
