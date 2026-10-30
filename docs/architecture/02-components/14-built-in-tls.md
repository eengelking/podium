---
title: "Built-in TLS (#577)"
description: "How the server serves HTTPS itself, the structure its sub-issues agreed on and what is still blocked on the engine."
group: "Project internals"
order: 14
---

# Built-in TLS (#577)

Built (#578 to #590, then #665, #667 and #668). #591, a CA option on `$.http.fetch` that would retire the helper, is
blocked on the engine. This records the structure so the sub-issues agree. The rules are in
`docs/spec/` 5.9, 6, 7.1 and 7.7, and the reasoning is in DECISIONS 42.

**Listeners.** `server/src/index.ts` has one `app.listen`. With `PODIUM_TLS=on`, `tlsServer.ts` (`startTls`) also
starts `https.createServer` on the reporter port (`4318`, `PODIUM_TLS_PORT`) with the same Express app behind
`reporterPortOnly`, next to the HTTP listener (`4317`), after `tlsCa.ts` (`ensureTls`) has made or read the CA and serving certificate. Any failure there
(openssl missing, a half-present CA, a bad or busy port) logs `tls.failed` and leaves HTTP running. The Host check
(`hostCheck.ts`) runs on both ([DECISIONS 33](../../decisions/33-refusing-a-host-the-server-does-not-expect.md)). The reporter server requires a client certificate (`requestCert: true`,
`rejectUnauthorized: true`, `ca` set to the Podium CA or CAs), so Node drops a connection without a valid one in the
handshake (the `tlsClientError` log line is `tls.handshake_failed`). `reporterPortOnly` lets through only the paths
`isReporterRoute` names and `POST /api/reporter/renew` (`isRenewRoute`), and answers any other path with a `404`, so the
console and Admin are not reachable on it. Nothing sets `rejectUnauthorized: false`, which is what CodeQL's
`js/disabling-certificate-validation` flagged before #665. Whether the HTTP listener serves reporter routes is the `tls.allowReportersOverHttp` setting (#589). `tlsHttp.ts`
has `reporterHttpGate`, mounted in `index.ts` ahead of the routers. It acts only when the HTTPS listener is running, the
socket is not encrypted (the socket, never a forwarded header), the route is one the mod calls (`isReporterRoute`: report,
hook, and the peers, asks, deliveries, diffs and recording routes under a session), the setting is off and `req.ip` is not
loopback (`req.ip` follows `X-Forwarded-For` only from a hop named in `PODIUM_TRUST_PROXY`). It answers `403`, logs
`tls.http_refused` and adds the source to the Reporters page's refused list. The console is never gated. A missing
setting row reads as on; `index.ts` writes it once when TLS first runs, on if any reporter has ever reported
(`ReporterStore.hasAny`). `ReporterTransport` is a memory-only map from reporter key to the transport of its last report
(set by `/report` and `/hook`), and gives the Admin the count of reporters heard from in the last 2 minutes over HTTP.

**Serving certificate renewal (#582).** `tlsRenew.ts` has `ServingRenewer`, made by `startTls` for the listener it
starts. It checks at start, before the first connection, and then every day on an unref'd timer; the check renews when
fewer than `tls.serving.renewBeforeDays` remain. A certificate made less than a day ago is left alone, so a renew-before
longer than the lifetime renews once a day and not at every check. `renewServing` (`tlsCa.ts`) makes the new pair in a
`.new-*` folder, copies the old pair to `previous/` (certificate and key, keys 0600, the last 3 kept), then renames the
new one in; `setSecureContext` puts it on the running server. Only one renewal runs at a time. A failure is logged as
`tls.renew_failed`, kept as `lastFailure` and retried by the next daily check. The two settings are `settings` rows
named by their SPEC keys (`TlsSettingsStore`). `adminRouter.ts` serves `GET` and `PUT /api/admin/certificates` and
`POST /api/admin/certificates/renew`, which answer 404 while TLS is off.

**CA rotation (#588).** `tlsRotation.ts` has `TrustStore`, the one list of trusted CAs: `ca.crt`, and during an overlap
`previous-ca.crt`, `cross.crt` and `rotation.json`. The listener's `ca`, the renewer's `setSecureContext`, `trustedIssuers`
(the certificate check on each request and the renewal check) and the CA in a config file all read it, so a certificate
cannot pass TLS and then be refused for its issuer. It ignores a cross certificate unless the previous CA signed it for the
current CA's key, which is what a rotation that stopped part-way leaves. `rotateCa` builds the new CA, the cross
certificate and the serving certificate in a `.new-*` folder and moves them in, the overlap files first and `ca.key` after.
`ServingRenewer.exclusive` runs a rotation and a serving renewal one at a time. `startTls` keeps the open TLS sockets, since
narrowing the client `ca` list does not drop one that is already authorized: a hard cutover destroys every socket that held
a client certificate, and retiring destroys the ones whose certificate the old CA signed. `PersonCertStore.reportersByIssuer`
counts people for the Admin page's "N of M reporters still use the old CA".

**The CA and `/data/tls`.** The server makes and renews certificates by calling `openssl` with `execFile`.
`ensureTls` works in a `.new-*` folder inside the directory and renames the finished files in, so a failure leaves no
half-made CA; a CA that exists is read and checked (key matches certificate, serving certificate signed by it), never
rewritten. A serving certificate that exists is kept until `ServingRenewer` renews it (below). Dates and fingerprints are
read from the certificates (`describeCert`) and logged as `tls.listening`, not stored twice.
`/data/tls` holds `ca.crt`, `ca.key`, `serving.crt`, `serving.key` and `previous/`, keys at mode 0600. In container
mode `podiumctl` keeps this folder on durable storage, and its remove path leaves it unless asked. Person
certificates are rows in `podium.sqlite`, found by SHA-256 fingerprint. A serving renewal calls `setSecureContext`
on the live HTTPS server, so nothing restarts. `setSecureContext` replaces the whole context, so the renewer passes
`ca` again with every new serving certificate; without it a renewed server would verify client certificates against
the public roots and refuse every reporter.

**Person certificates (#583).** `tlsPeople.ts` makes a person's key and `clientAuth` certificate with `openssl`
(`issuePersonCert`) in a `.new-*` work folder that is deleted afterwards, so the key exists on disk only for those
seconds and Podium never stores it. It builds the config file (`buildReporterConfig`) from the key, the certificate
and the CA. `PersonCertStore` (`tlsClientAuth.ts`) is the `person_certificates` table (migration 23): fingerprint
(primary key), serial, issuer fingerprint, person, the certificate PEM, dates and revocation. A reissue stores the
new row and revokes the earlier live ones in one transaction. The rows go with the person (`ON DELETE CASCADE`).

**Who is calling.** `requireToken` in `routes.ts` turns a request into an identity before it reads a body. With TLS
the socket's client certificate is checked first, on every request, by `certAuth` (`tlsClientAuth.ts`): the
connection must be `socket.authorized` (so Node verified it against the Podium CA), the fingerprint must be a stored
one, not revoked, not past its dates and issued by a CA the server currently trusts. A certificate that was presented
and fails is a 401 with `client certificate refused` and never falls back to a token; no certificate at all goes on
to the token check as before. The same `userName` match applies. Revoking only the certificate leaves the token
(and the console sign-in) working; revoking the token also revokes the certificate. Because the row is read on every request,
a revoke reaches a keep-alive connection that is still open and no socket has to be destroyed.

**Renewing a person's certificate (#585).** `tlsReporterRenew.ts` serves `POST /api/reporter/renew`, mounted at
`/api/reporter` in `index.ts` ahead of the token check, because it is answered to a certificate only. `authorizeRenewal`
takes the certificate's bytes from the socket (`getPeerCertificate().raw`), recomputes the fingerprint from them and looks
it up. The certificate must be `socket.authorized`, which on the reporter port is always true by the time a route runs.
Anything else, an expired certificate included, is refused as `NOT_TRUSTED`; there is no grace and no expired-certificate
branch (#665), so there is nothing to forge. The body is the new public key (EC P-256 only);
`issueForPublicKey` signs it with `openssl x509 -new -force_pubkey` through `signClientCert` (`tlsPeople.ts`), the one function that makes the work folder, writes the `clientAuth` extension file, picks the serial, signs and reads the dates back for both it and `issuePersonCert`, which differ only in how the public key reaches `openssl x509`, and `PersonCertStore.add` stores it without revoking
the old row, so both work until the old one expires (`replace`, used by an Admin reissue, still revokes). The helper
(`helper.mjs`) renews at start, before a request, and on a 10 minute timer, one renewal at a time per process and one at a
time per file through a numbered lock, `<file>.lock.<n>`: an O_EXCL file naming its owner, held by the highest number and free when there is none or it is older than a minute; a waiter takes it by creating the next number, which only one of several can do, so no stale file is ever removed from under a waiter, and a number is never used twice (a holder lets go by aging its file, not removing it, and only the newest file is kept); a holder refreshes its file's time every 20 s while it runs. While it holds the numbered lock it also takes the plain `<file>.lock` that the first version of the code used (lock scheme 1), and refreshes and releases that too, so a session on the older helper is excluded; only the numbered lock's holder ever removes a stale plain lock. `<file>.lock.scheme` records the scheme (2); a helper that reads a higher number refuses to renew (`LOCK_SCHEME`) instead of ignoring a lock it does not understand. Under the lock it re-reads the file first and takes a
newer certificate another session wrote instead of renewing again, checks the answer is for its own key and signed by a CA
the file already holds, and replaces the file with `writeAtomic` (a temporary file in the same folder, fsync, rename, mode
0600). A refusal is remembered until the file changes; a failure that may pass is retried after a minute. Before it
connects, the helper compares the certificate's `notAfter` with its clock. An expired certificate is never renewed and
nothing goes upstream: every request gets `X-Podium-Helper-Error: CERT_EXPIRED` with the date in its message, which
`tlsLink.ts` words in the status line and in `/podium`, from the config's `expires` line at start too. `authenticate` also limits renewal to once an hour per person (`MIN_RENEW_INTERVAL_MS`): while the newest live certificate was issued less than an hour ago it answers 429 with `Retry-After` and `TOO_SOON` before any signing, with no exception. The helper sets its next try from `Retry-After` (`retryDelayMs`). The one setting, the lifetime, is `TlsSettingsStore.getReporter()`.

**Choosing the file (#606).** The home folder is `HOME`, else `USERPROFILE`, else `HOMEDRIVE` plus `HOMEPATH` (`resolveHome` in `reporterConfig.ts`, #834), so Windows reads `%USERPROFILE%\.podium`; `/podium` shows the folder and the variable it came from, or says none was found (DECISIONS 51). `findConfig` in `tlsLink.ts` picks the config file once per session start: `PODIUM_REPORTER_CONFIG`, then the context `PODIUM_REPORTER_CONTEXT` names or else the current one in `~/.podium/contexts.json`, then the newest `reporter-config-*.pem` by the epoch in its name. `contexts.ts` owns the file's format and the `/podium context` command; `bin/podiumctl` keeps a copy of the format for `podiumctl context`, and `scripts/podiumctl.test.ts` checks the two agree. A context that cannot be used comes back as `contextProblem` beside the newest file, so the reporter keeps working and `/podium` says why. The choice belongs to the link, which a `/clear` keeps, so a running session holds the context it started with. See SPEC 5.9 and DECISIONS 46.

**The helper.** `mod/podium-reporter/hooks/helper.mjs` is a Node script that `register.ts` starts with
`$.process.spawn` once per session. It reads the reporter config file, makes the HTTPS connection, and listens on a
Unix socket. The seam in the mod is the one `FetchLike` at `register.ts` (`const fetch: FetchLike = ...`): with a
config file it sends through the helper with `$.http.fetch(url, { ...init, socketPath })`, so `Transport` and its
callers do not change. The held answer request keeps the engine's 30 second limit, now on the leg to the helper.
The helper forwards only the calls in `REPORTER_ROUTES`, a copy of `REPORTER_ROUTE_TEMPLATES` in `tlsHttp.ts` that
`reporterHelper.test.ts` compares. It builds the upstream request from the matched route, and anything else gets `403` with
`X-Podium-Helper-Error: ROUTE_NOT_ALLOWED` (#668).

**The helper on Windows (#834).** Everything above holds except the socket. The mod cannot reach a helper on Windows by a socket: Node there has no
Unix sockets (its local sockets are named pipes, and a `.sock` path is an invalid pipe name, which libuv reports as `EACCES`), and the engine's
`$.http.fetch` takes `socketPath` as a Unix socket and refuses a pipe address (`\\.\pipe\...`) as a network location, as it does any path that starts
with two separators. So when the config path is a Windows path, `startLink` gives the helper `mailbox:<folder>` in place of a socket path, with the
folder `.podium/run/<session>/` (`mailboxDirFor`). Each request is written by the mod with `$.fs.write` as `req-<id>.json` (method, path and body; no header, because the reporter sends only `Content-Type`, which the helper sets, and a token, which the
server ignores when the certificate is present). The helper (`serveMailbox`, watching the folder with a 250 ms poll behind it) takes a file once it parses as
JSON, because a write is not atomic; deletes it; checks that the pieces are text (`wellFormed`) and rebuilds the method and path from `REPORTER_ROUTES`; and sends the
request through its own handler in memory (`inMemoryRequest`, on `stream.duplexPair`, so no port or pipe is opened and the route list, the certificate
checks and the error headers are those of the socket mode). It answers with one stdout line, `res <id> <base64 of {status, headers, body}>`. The mod reads
its stdout already, keeps a line that arrives in two pieces, matches the reply to the waiting request by id (`viaMailbox`), and gives up after
`REPLY_MS`. Replies never touch disk. Files an earlier helper left are removed at start. It needs Node 20.17 or later. The other ways considered
(loopback TCP with a key, the helper as an MCP server, one process per request) and the cost are in DECISIONS 51; the lasting fix is #591.

**Admin.** New routes under `/api/admin/certificates` and on `people/:id/certificate/...` live in `adminRouter.ts`.
`POST /people` returns the config file with the token, once; if the certificate cannot be made the person and the
token are still returned, with a `configError`, since the token is shown once too. Revoking a token, alone or with
Revoke all, is refused for the last active Administrator (`PeopleStore.assertNotLastAdministrator`); revoking only the
certificate needs no guard, because the console sign-in does not use it.
The Certificates page and the header pill, and the reworked People page, are in `frontend/src/fleet/admin/`.

<!-- nav:start -->
---

Previous: [Orchestrator messaging](13-orchestrator-messaging.md) · Up: [Components](README.md) · Next: [People view](15-people-view.md)
<!-- nav:end -->
