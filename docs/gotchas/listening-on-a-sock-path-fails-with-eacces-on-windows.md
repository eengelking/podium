---
title: "Listening on a .sock path fails with EACCES on Windows, whatever the folder"
description: "Node on Windows has no Unix sockets, so the EACCES is an invalid pipe name, not a permission; the mod reaches the Windows helper through a request folder."
group: "Project internals"
area: "Developing"
date: "2026-10-30"
status: "open"
order: 60
---

# Listening on a .sock path fails with EACCES on Windows, whatever the folder

**You see:** On Windows 11, a Node script that does `net.createServer().listen("C:\\Users\\<name>\\.podium\\run\\x.sock")` fails with
`listen EACCES: permission denied`. It does the same with backslashes or mixed slashes, in the temp folder, and after `process.umask`. A listen on
`\\.\\pipe\\name` works. The helper's `/podium` line read `The Podium connection helper stopped: cannot listen on ... EACCES`.

**Why:** It is not a permission. Node on Windows has no Unix sockets: its local sockets are named pipes, and the path must be `\\?\\pipe\\...` or
`\\.\\pipe\\...`. Any other path is an invalid pipe name, and libuv turns `ERROR_INVALID_NAME` into `EACCES`. The way out is not a pipe either: the
engine's `$.http.fetch` takes `socketPath` as a Unix socket and refuses a pipe address as "a network location", with the message `socketPath ... refused:
a network location is not reached from here`, as for any path that starts with two separators. Node issues libuv #2537 and nodejs/node #35008 are the
open reports.

**Do:**

1. Do not give a Windows helper a socket path. The mod gives it `mailbox:<folder>` and talks through request files and the helper's stdout
   (`serveMailbox` in `helper.mjs`, `viaMailbox` in `tlsLink.ts`; DECISIONS 51, and the architecture page on built-in TLS).
2. To try a transport on a Windows machine, run a throwaway script there first. A listen that works on macOS proves nothing about Windows.
3. When the engine's `$.http.fetch` gains a CA and client-certificate option (#591), the helper and this workaround go away.

<!-- nav:start -->
---

Previous: [On Windows, /podium says offline with HTTP 502 when the config file names localhost](on-windows-podium-says-offline-http-502-when-the-config-names-localhost.md) · Up: [Gotchas](README.md)
<!-- nav:end -->
