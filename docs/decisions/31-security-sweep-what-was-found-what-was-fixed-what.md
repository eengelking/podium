---
title: "31. Security sweep (#249): what was found, what was fixed, what is accepted"
description: "A review of the server, UI, mod, podiumctl and image: what was fixed (advisories, headers, capabilities), what was found sound, and what is accepted."
group: "Project internals"
number: 31
date: "2026-10-16"
status: "accepted"
order: 31
---

# 31. Security sweep (#249): what was found, what was fixed, what is accepted

**Context.** A review of the server, UI, mod, `podiumctl`, the Containerfile and the dependencies, at the
time Podium gained responding (#206) and Admin sign-in by name and token (#215).

**Fixed.**

- *High (advisory, not reachable).* `npm audit --omit=dev` reported `proxy-addr` (critical, IP spoofing
  through a trusted proxy subnet) and `qs` (moderate, denial of service in query parsing, reached through
  Express). Podium never sets `trust proxy`, so `proxy-addr` could not be steered, but `qs` parses every
  query string. `npm audit fix` moved them to patched versions, and production dependencies now audit clean.
- *Low.* No response carried a content security policy, `X-Frame-Options` or `nosniff`, so any future markup
  bug would have run with the page's full reach, and the console could be framed. They are now set on every
  response (7.7).
- *Low.* The container ran with Podman's default capability set. It now drops all of them and cannot gain
  privileges.

**Checked and sound.**

- Every SQL statement is parameterized. The two that build an `IN (?, ?)` list or an `ORDER BY` take only
  counts and whitelisted words.
- Tokens are 192 bits, stored as SHA-256 and compared in constant time. The lockout covers Admin and the
  sign-in to respond together.
- Every Admin route sits behind the unlocked-session check. Every change in Admin and respond needs a custom
  header and a same-host `Origin`, with `SameSite=Strict` cookies.
- A session is answerable only by its owner or an Admin, and the answer's text is never logged.
- The UI has no `dangerouslySetInnerHTML`, and a Markdown link opens only `http(s)` and `mailto`.
- `podiumctl` passes the token by environment, writes the config at mode 0600 and keeps the token out of the
  boot file. Log lines redact tokens.

**Accepted.**

- *Guessing the admin secret with `X-Podium-Token`.* Accepted when found, fixed in #255. Wrong secrets on the
  report routes are now throttled with a counter of their own. The shared lockout could not simply count
  them, since a misconfigured reporter would lock out every reporter and the person's own browser on a
  shared address (all local reporters arrive from `127.0.0.1`). The throttle counts distinct wrong values,
  never person tokens, and while it holds it refuses even the right admin secret from that address. See 32.
- *DNS rebinding.* Accepted when found, fixed in #256 (see 33): the server now refuses a `Host` it does not
  expect. The reads are still open by design (7.1).
- *Open reads and three open writes.* `GET` routes, Remove on a lost card, closing a wall notice and the
  background-sessions switch take no token (7.1). They change only how the wall looks.
- *Development dependencies.* Accepted when found, cleared in #269. `npm audit` listed `vitest`, `vite`'s
  `esbuild` and `tinypool`, none of which ships in the image. The test tooling moved to vitest 5, vite 8 and
  `@vitejs/plugin-react` 6, and `npm audit` (with dev dependencies) now reports nothing. The root
  `package.json` names vitest itself, because the two workspaces no longer share one copy for the `scripts/`
  tests to find. `frontend/src/jest-dom.d.ts` carries jest-dom's matcher types for vitest 5's two-parameter
  `Assertion` (GOTCHAS).
- *A server's own page loads Google Fonts,* which tells Google that someone opened Podium. The policy names
  that one origin.

**Cost.** The policy must be edited by hand when the page gains an origin or an inline script.

<!-- nav:start -->
---

Previous: [30. Admin opens from the console's sign-in, with a name and a token](30-admin-opens-from-the-consoles-sign-in-with-a-name.md) · Up: [Decisions](README.md) · Next: [32. Throttling wrong admin-secret guesses on the report routes (#255)](32-throttling-wrong-admin-secret-guesses-on-the-report.md)
<!-- nav:end -->
