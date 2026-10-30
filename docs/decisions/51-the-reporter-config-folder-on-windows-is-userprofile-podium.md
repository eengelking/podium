---
title: "51. The reporter config folder on Windows is %USERPROFILE%\\.podium (#834)"
description: "The mod takes the home folder from HOME, else USERPROFILE, else HOMEDRIVE plus HOMEPATH, so Windows uses the same .podium folder name as macOS and Linux."
group: "Project internals"
number: 51
date: "2026-10-30"
status: "accepted"
order: 51
---

# 51. The reporter config folder on Windows is %USERPROFILE%\.podium (#834)

**Context.** On Linux and macOS the reporter reads `~/.podium/` (`reporter-config-<name>-<epoch>.pem`, `contexts.json`, the helper's `run/` folder). The mod found the home folder from `HOME` alone. Windows sets `USERPROFILE` and normally not `HOME`. On a Windows 11 machine with the file saved in `C:\Users\<name>\.podium`, `/podium` showed "Sign-in: a plain token", because the mod found no home, no file, and no reason to say so.

**Decision.** The folder on Windows is `%USERPROFILE%\.podium`. The mod finds the home folder from `HOME`, else `USERPROFILE`, else `HOMEDRIVE` plus `HOMEPATH` (`resolveHome` in `mod/podium-reporter/hooks/reporterConfig.ts`); an empty value counts as unset. `HOME` still wins, so macOS and Linux do not change.

- `/podium` shows a `Home folder:` line with the folder and the variable it came from, or says that none was found and names the three variables. A missing home does not stop the plain-token path.
- On Windows the mod and the helper talk through a folder, not a socket. Node on Windows has no Unix sockets: its local sockets are named pipes, a `.sock` path is an invalid pipe name, and libuv reports that as `EACCES`. That is why a probe on Windows 11 (build 10.0.26300, Node 26) failed on every `.sock` path, in any folder, with or without `umask`, and listened only on a pipe. The engine's `$.http.fetch` takes `socketPath` as a Unix socket and refuses a pipe address (`\\.\pipe\...`) as "a network location", as it does for any path that starts with two separators. So the helper opens nothing there. The mod writes each request as `req-<id>.json` in `~\.podium\run\<session>\`; the helper takes a file once it parses as JSON (the engine does not write a file in one step), deletes it, answers it with its own request handler in memory (`stream.duplexPair`), and prints one `res <id> <base64>` line on stdout, which the mod already reads. Routes, certificate checks and error headers are therefore the ones used over a socket. The helper is given `mailbox:<folder>` in place of the socket path, and removes requests an earlier helper left behind when it starts.
- The `TMPDIR` fallback, the socket-folder `chmod` and the stale-socket check do not apply there. The request file does not hold the `X-Podium-Token` header, because the server ignores a token when the certificate is present.
- The search for `node` accepts a Windows drive path from the PATH, and falls back to `%ProgramFiles%\nodejs`, `%LOCALAPPDATA%\Programs\nodejs` and `%LOCALAPPDATA%\Volta\bin`. It took only paths that start with `/`, so a Windows `node` was found and then thrown away.
- `podiumctl` needed no change: it uses `os.homedir()`, which Node resolves from `USERPROFILE` on Windows.
- The "readable by others" check stays off on Windows (as before). The docs say so and do not tell Windows users to run `chmod`.

**Why.** One folder name on every platform keeps the docs, `podiumctl` and the mod in agreement. `os.homedir()` is not available inside the mod, so the lookup is built from environment variables, the only thing the mod can read.

**Alternatives.**

- `%APPDATA%\podium` is the Windows convention, but it would split the docs, `podiumctl context` and the mod across two names.
- Asking Windows users to set `HOME` moves the problem to every machine.
- A named pipe was tried first. The engine refuses the address.
- Loopback TCP with a per-session key works without files, but any local account can reach the port and only the key protects it.
- The helper as an MCP server, or one `node` process per request, were not built: the first has unknowns (approval, truncation), the second makes a TLS handshake for every report.
- The permanent fix is an engine option for a CA and a client certificate on `$.http.fetch` (#591); the helper then goes away on every platform.

**Cost.** A Windows user who has `HOME` set to something other than their user folder (a Unix-style shell can do this) gets that folder, not `%USERPROFILE%`. `/podium` names it. A request file sits on disk for a moment, in a folder the user profile's access list keeps to the user, SYSTEM and Administrators; the replies never touch disk. A crash can leave a file behind until the next helper start removes it. The mailbox needs Node 20.17 or later (`stream.duplexPair`). Each request costs two small file operations and a watch event; the delay is not measured. That the engine's `$.fs.write` and the helper's folder watch work on Windows 11 is confirmed by hand on #834, not by a test.
