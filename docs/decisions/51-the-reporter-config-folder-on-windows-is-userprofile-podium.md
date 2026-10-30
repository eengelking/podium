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
- The helper listens on a named pipe on Windows, `\\.\pipe\podium-<random>-<session>`, not a Unix socket. On Windows 11 (build 10.0.26300, Node 26) `listen` on a `.sock` path failed with `EACCES` in `~\.podium\run`, in the temp folder, with backslashes or mixed slashes, and with or without `umask`; only a named pipe listened. A pipe has no private folder around it, so its name carries 96 random bits that only the mod and its helper know. So the `TMPDIR` fallback, the socket-folder `chmod` and the stale-socket check do not apply there, and the helper skips them for a pipe address.
- The search for `node` accepts a Windows drive path from the PATH, and falls back to `%ProgramFiles%\nodejs`, `%LOCALAPPDATA%\Programs\nodejs` and `%LOCALAPPDATA%\Volta\bin`. It took only paths that start with `/`, so a Windows `node` was found and then thrown away.
- `podiumctl` needed no change: it uses `os.homedir()`, which Node resolves from `USERPROFILE` on Windows.
- The "readable by others" check stays off on Windows (as before). The docs say so and do not tell Windows users to run `chmod`.

**Why.** One folder name on every platform keeps the docs, `podiumctl` and the mod in agreement. `os.homedir()` is not available inside the mod, so the lookup is built from environment variables, the only thing the mod can read.

**Alternatives.**

- `%APPDATA%\podium` is the Windows convention, but it would split the docs, `podiumctl context` and the mod across two names.
- Asking Windows users to set `HOME` moves the problem to every machine.

**Cost.** A Windows user who has `HOME` set to something other than their user folder (a Unix-style shell can do this) gets that folder, not `%USERPROFILE%`. `/podium` names it. The engine documents `socketPath` as a Unix socket; that it passes a pipe address through is confirmed by hand on Windows 11 on #834, not by a test. A pipe's default access list is wider than a private folder's, so the random name is what keeps another local account out; it is not a substitute for an access list. Windows 11 behavior of the whole TLS connection is likewise confirmed by hand.
