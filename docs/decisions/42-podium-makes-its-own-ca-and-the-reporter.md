---
title: "42. Podium makes its own CA, and the reporter authenticates with a certificate (#577)"
description: "With TLS on, Podium makes its own CA and gives each reporter a client certificate on a mutual-TLS port, at the cost of a CA, renewals and reissues to run."
group: "Project internals"
number: 42
date: "2026-10-22"
status: "accepted"
order: 42
---

# 42. Podium makes its own CA, and the reporter authenticates with a certificate (#577)

**Context.** Podium's traffic is plain HTTP. A reporter sends its token, its reports and the answers it holds
over HTTP, and the browser signs in with a name and a token over HTTP, so anyone on the path can read and
change them. The only advice was a TLS proxy (20, 28, 31). #323 designed the fix over 17 comments and #577
builds it. This entry records why it has this shape. It is built (#577 and its sub-issues).

**Decision.** With TLS turned on (`PODIUM_TLS=on`, `podiumctl start --tls`), the server makes its own CA and
serving certificate in `/data/tls` and opens a second port for reporters, HTTPS with mutual TLS (see the update
below). Each person gets a client certificate in
one generated config file, `reporter-config-<name>-<epoch>.pem`, holding the server address, the CA, the name
and the certificate with its private key, the way `kubeadm` and `kubectl` do. `docs/spec/` 5.9, 6, 6.8, 7.1 and
7.7 have the rules.

- A reporter with the file is identified by its certificate, not a token. A token the person has set is still sent
  inside the TLS connection and the server ignores it. The server authenticates the reporter from the certificate in the TLS
  handshake, mapped to a person by SHA-256 fingerprint, and the report's `userName` must still equal that person,
  as 20 requires. The console keeps its name and token, on plain HTTP (30, and the update below).
- The reporter makes its TLS connection through a small Node helper, started per session, because the mod's
  `$.http.fetch` accepts no CA or certificate. The mod sends its requests to the helper over a Unix socket.
- Revoking the certificate, the token, or both are separate actions. The server checks revocation on every
  request. The console stays on plain HTTP on the address the server is bound to (any address, loopback or `0.0.0.0`), so an Admin can always sign in (33 still applies to both ports). The reporter routes on that port are refused unless an Admin has allowed reporters over HTTP or the caller is on loopback (#665, #672).
- Serving certificates renew themselves, person certificates renew from the reporter, and the CA rotates only
  by hand, with a cross-signed overlap when planned.
- Reporters over HTTP are an Admin switch, on for an existing install and off for a fresh one that enables TLS.
- macOS and Linux are in scope. Windows is unsupported.

**Why.**

- Tokens in a header over plain HTTP were the accepted cost in 20, 28 and 31. Responding (28) made it worse,
  since the browser's sign-in and held answers now cross the network too.
- The maintainer's model is `kubectl`: the CA arrives inside the credential file and is used for that one
  connection. A person's machine installs nothing and trusts nothing new. A certificate also cannot be lifted
  out of a header and replayed the way a token can, because the private key signs the handshake and is never
  sent.
- A person is still bound to their name (20). The certificate is public and the key proves identity, so a
  stolen database yields no usable reporter credential.
- Revocation had to be easy and separate: "it just blocks the reporter from working, but the user can still log
  in".
- The helper is the one route that was measured to work (Claude Code 2.1.305, 20 of 20 requests at about 2 ms,
  the server saw the certificate on every handshake). `$.http.fetch` ignores `ca`, `cert` and `key`.
  `NODE_EXTRA_CA_CERTS` needs a restart, cannot be set later by a mod, and trusts the CA for the whole process.
  `curl` per request fails on macOS with a combined PEM file. The long-term fix is an engine option on
  `$.http.fetch` (#591), and then the helper goes and the file stays.
- `openssl` and Node's own TLS do the work, with no pure-JS certificate library. The CA lives on durable
  storage so a restart or rebuild never loses it. Reporter identity is read once per session (29), so the
  helper follows the same rule.

**Alternatives.**

- Signed requests over verified HTTPS with `crypto.subtle`. Superseded: the helper gives real mutual TLS.
- A `ca.pem`, a `.pdm` file and a `NODE_EXTRA_CA_CERTS` line with a restart. Superseded by the one file, and kept
  as the documented fallback if the helper is not accepted.
- The reporter setting its own trust at runtime. Does not work.
- A pinned CA hash like `kubeadm join`. Needs the engine option.
- A TLS proxy only (the earlier advice). It still works, and a server with a real name can use one (35).

**Cost.**

- The reporter needs `node`. It looks at `PODIUM_NODE`, then the `PATH` Claude Code started with, then Homebrew, `/usr/local`, nvm and Volta, and says so in the status line when it finds none.
- The helper relies on `$.process`, which the engine provides only on the command line, so the mod runs there and the
  desktop app and VS Code are not covered.
- A stolen `/data/tls` holds the CA key, which is everything the CA signed. It needs an emergency rotation and a
  reissue, and the folder must be backed up and permissioned like a secret.
- A stolen config file holds a person's private key until it is revoked.
- A laptop asleep past both the cross certificate and its own certificate's end needs a reissue.
- Podium now holds a CA, a renewal schedule and a rotation procedure, which is more to run and more to explain.

**Update (#665): reporters get their own mutual-TLS port, the console gets no HTTPS, and there is no grace.** The review
of #663 raised CodeQL `js/disabling-certificate-validation` on the one HTTPS listener, which asked for a client
certificate but did not require one (`rejectUnauthorized: false`) so that a browser could use it too. Every place that
trusts a certificate checked `socket.authorized`, so it was safe as built, but the safety lived in application code.
The maintainer decided to split the traffic by port.

- Port 4317 stays plain HTTP. It serves the console, Admin and any reporter that uses a token. Podium does not serve
  HTTPS to browsers; a person who wants it puts a proxy in front (35).
- Port 4318 (`PODIUM_TLS_PORT`) is HTTPS with `requestCert: true` and `rejectUnauthorized: true`, and serves only the
  routes a reporter calls and `POST /api/reporter/renew`. A connection without a valid certificate is dropped in the
  handshake, and any other path is a `404`. Nothing in Podium sets `rejectUnauthorized: false`.
- A certificate that has expired is not renewed. A reporter renews while the certificate is valid, 30 days before it
  ends. If it lapses, the reporter cannot reach 4318 and an Admin generates a new config for the person. The 30-day
  grace and `tls.reporter.graceDays` are gone.
- The reporter says in the status line and in `/podium` that the certificate expired on a named date and that an
  Admin must generate a new one. Admin > People warns before it lapses.
- Admin > Server > Certificates keeps the CA and the serving certificate. It no longer offers Download CA or any
  text about trusting the CA in a browser, since no browser uses this TLS.

*Why.* The grace was the one flow that needed an unverified client: a renewal with an expired certificate
(`CERT_HAS_EXPIRED`). Dropping it lets the listener verify every client, and it removes the gap where an expired
certificate skipped the hourly renewal limit and the in-flight guard and could renew repeatedly. A renewal answer, a
new CA during a rotation included, now only travels over a connection both sides verified.

*Cost.* A laptop that sleeps past its certificate's end, or a reporter that does not run at any time in its certificate's last 30 days
(it can lapse after a little over a month away, and always does after 90), needs an Admin to reissue its config. Revocation is checked on every request and not in
the handshake, since the handshake cannot know it. The planned-rotation overlap stays at 120 days, which now leaves a
margin over a default 90-day certificate and does not cover a certificate set to the 365-day maximum.

<!-- nav:start -->
---

Previous: [41. A Bash row opens to the whole command and its output (#431)](41-a-bash-row-opens-to-the-whole-command-and-its-output.md) · Up: [Decisions](README.md) · Next: [43. The docs site is Astro Starlight, and each version is built from its git tag (#688)](43-the-docs-site-is-astro-starlight-and-each-version.md)
<!-- nav:end -->
