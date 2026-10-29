---
title: "7.7 Hardening"
description: "Binding, tokens, TLS and the other protections the server must apply."
group: "Reference"
section: "7.7"
order: 7
---

# 7.7 Hardening

## Binding and the token

- Bind `127.0.0.1` by default. The container image listens on `0.0.0.0` inside the container, and `podiumctl`
  publishes it on the host's `127.0.0.1` ([4.4](../04-architecture.md#44-packaging-running-and-distribution)).
- If `PODIUM_TOKEN` is set, `POST /report`, `DELETE` and `POST /hook` require `X-Podium-Token`. Reads and the
  `drop` route stay open on localhost.
- Over plain HTTP, tokens and the admin secret travel in a header, so a server reachable over a network needs
  a trusted network or a TLS proxy. With built-in TLS on, the server opens a second port for reporters, which needs a
  client certificate, and a reporter with a certificate sends no token (*Built-in TLS*, below). The console stays on
  plain HTTP, and plain HTTP also serves reporters while the Admin allows it. Podium does not serve HTTPS to browsers;
  a person who wants it puts a proxy in front (#305).

## Built-in TLS (#577)

Designed in DECISIONS 42, on #323 and #577. Podium makes its own CA, signs a serving certificate, and gives each
person a client certificate in one generated config file ([5.9](../05-mod-api/05-09-mod-configuration-userconfig.md)), the way
`kubeadm` and `kubectl` do. A person's machine trusts nothing new and installs nothing. The certificates are for
`podium-reporter` only: the TLS port serves no console and no browser (#665).

**Enabling.** TLS is opt-in and off by default. `PODIUM_TLS=on`, or `podiumctl start --tls`, makes the first start
create a CA and a serving certificate when none exist. A fresh install without it stays on plain HTTP, with
loopback as the default bind. A CA that exists is never overwritten. A missing or unreadable key stops TLS with a
log line and leaves HTTP working.

**Ports.** HTTP keeps `4317` and serves the console, Admin and any reporter that uses a token. The reporter port is
`4318`, changed with `PODIUM_TLS_PORT`, and is HTTPS with mutual TLS. `podiumctl` publishes both and the
Containerfile exposes both. The port a reporter config names is the one people reach, `PODIUM_TLS_PUBLIC_PORT` when it
is set and the listening port otherwise; `podiumctl` sets it in container mode to the host's `PODIUM_TLS_PORT`, since
the server listens on 4318 inside (#649). A value that is not a port is ignored. The reporter port serves only the
routes a reporter calls (`POST /api/fleet/report` and `/hook`, the peers, asks, diffs, deliveries and recording routes
under a session, and `POST /api/reporter/renew`); any other path on it is a `404` and the console is not reachable there. The Host check
applies to both ports (DECISIONS 33).

**Keys and certificates.** The CA, the serving certificate and every person's certificate use EC P-256 keys, made
with `openssl` (called with `execFile`, no shell).

| Certificate | Lifetime | Names and subject |
|---|---|---|
| CA | 10 years, fixed at creation | `CA:TRUE`, `keyCertSign`, with SKID and AKID. |
| Serving | 1 year (`tls.serving.lifetimeDays`) | `serverAuth`. Names are `localhost`, `127.0.0.1`, the bind address and `PODIUM_ALLOWED_HOSTS`. |
| Person | 90 days (`tls.reporter.lifetimeDays`) | `clientAuth`. Subject `CN=pdm_<key id>, O=podium`. A name never goes into the subject. |

**Storage.** In `/data/tls` (`data/tls` in standalone mode): `ca.crt`, `ca.key`, `serving.crt`, `serving.key` and
`previous/` (the last 3 replaced serving certificates). Every key is mode 0600 and the directory 0700. `/data` is
durable, so a restart or a rebuild keeps the CA. Person certificates are in a table in `podium.sqlite` with
`fingerprint_sha256` (unique), `serial`, `issuer_fingerprint`, `person_id`, `not_before`, `not_after`,
`issued_at`, `revoked_at` and `reason`. The CA's and the serving certificate's dates and fingerprint are in a
small metadata table or in settings rows. Podium keeps only a person's certificate, never their key.

**Serving certificate renewal.** It is always automatic, with no setting to turn it off. It renews at start and `tls.serving.renewBeforeDays` before expiry, with the same
names and the same CA, and is swapped in with `setSecureContext` without a restart (an open connection keeps the
old one, a new connection gets the new one). The replaced certificate goes to `previous/`. A failure is logged,
retried daily and shown to the Admin. An Admin can renew now, which also re-issues for a changed bind address or
`PODIUM_ALLOWED_HOSTS`.

**Settings.** Changed in Admin > Server > Certificates ([7.1](07-01-endpoints.md#certificate-routes-577)). Each change is written to
the Admin log.

| Key | Default | Range |
|---|---|---|
| `tls.serving.lifetimeDays` | 365 | 30 to 825 |
| `tls.serving.renewBeforeDays` | 30 | 7 to 90 |
| `tls.reporter.lifetimeDays` | 90 | 30 to 365 |
| `tls.header.countdown` | true | on or off |
| `tls.allowReportersOverHttp` | see below | on or off |

`tls.header.countdown` hides only the healthy countdown in the header pill. The pill is blue at 30 days or fewer,
orange at 10, red at 5, and reads "Certificate expired" after that. It tracks the CA and the serving certificate,
whichever expires first, and never a person's certificate. A failed renewal and an expired certificate always show.

**Reporters over HTTP.** `tls.allowReportersOverHttp` defaults to **off** on a fresh install that enables TLS and
to **on** for an existing install, so nothing stops when TLS is turned on. While it is on, the Admin page shows a
warning that name, token and everything the reporter sends are not encrypted. Turning it off asks first, names how
many reporters it will refuse, and says the console on loopback keeps working. With it off, the HTTP port (4317)
refuses reporter routes except on loopback, so reporters must use the reporter port (4318) with a reporter config. The console on loopback stays on HTTP so an Admin can always sign in,
and the Administrators group always keeps a member, so a server whose certificate expired can be recovered.

**Mapping a certificate to a person.** The reporter port runs `https.createServer` with `requestCert: true`,
`rejectUnauthorized: true` and `ca` set to the Podium CA(s), so Node drops a client without a valid certificate in the
handshake. `ca` matters: without it Node verifies against the public roots. Nothing in Podium sets
`rejectUnauthorized: false`, so a safety check does not rest on application code (#665). A certificate that passed the
handshake is looked up by SHA-256 fingerprint, never by subject or serial, and its revocation and issuer are checked
on every request. Extended key usage is enforced both ways.

**Revocation.** An Admin can revoke a person's certificate, their token, or both (Revoke all). Revoking only the
certificate stops the reporter and leaves the token and the console sign-in. Revoking the token also revokes the
certificate, so a person who is cut off cannot go on with the other credential; Revoke all is the same action
by name, and a reissue (or a token rotation followed by one) gives the person a way back. Revoke token and Revoke
all are refused (`400`) for the last active member of Administrators, as Delete is, and the message says to add
or move another person first; the admin secret still signs in to Admin either way. Revoking only the certificate
is not guarded, since the console sign-in does not use it. The server checks the fingerprint's revocation and
issuer on **every request**, or destroys the open sockets when a certificate is revoked or a CA retired, because a
keep-alive connection stays authorized after the client `ca` list is narrowed.

**CA rotation.** Planned rotation has an overlap. The server makes a new CA, signs a cross certificate for it with
the old one (`CA:TRUE`, `keyCertSign`, SKID and AKID, no `pathlen:0`, a lifetime of 120 days that ends the overlap: a
reporter's 90-day certificate and a margin), and presents `[new leaf, cross certificate]` in that order, leaving the
cross certificate out once it has expired. A CA is made with `pathlen:1`, because OpenSSL refuses the chain `[leaf, cross]`
under a root with `pathlen:0`; a CA made before that (`pathlen:0`) cannot take a planned rotation and is refused with
a message that points to **Rotate CA and end the overlap now**. `GET /api/admin/certificates` says so in `canOverlap`
(false for such a CA), and the page then shows why before the Admin presses anything: the confirmation explains that the
CA cannot be rotated with an overlap, **Rotate CA** is disabled with that reason as its description, and only **Rotate CA
and end the overlap now** is open. The cutover makes a `pathlen:1` CA, so the next rotation can be planned (#638). A new CA's subject is `CN=Podium CA <date>`, so two
CAs in one overlap can be told apart. Only one overlap is open at a time. The old CA's key is not kept: the planned
rotation replaces `ca.key` and nothing is signed with the old key afterwards. The listener, the serving renewer, the
check on each request and the CA(s) in a new config all read one list of trusted CAs, so they cannot disagree. It trusts both CAs for client certificates until the cross certificate expires (its 120 days end the overlap by themselves) or the Admin retires the old CA, whichever comes first, and the new CA
reaches reporters in the renewal response ([6](../06-reporter-protocol/06-08-version-compatibility.md#authenticating-by-certificate-577)). The Admin retires the old CA
when none are left; the page counts the reporters still on it (each person once, by their newest live certificate), and
retiring refuses them at once and closes the open connections that came in on a certificate the old CA signed. After a leaked CA key there is no overlap (**Rotate CA and end the overlap now**): a hard cutover, no
in-band delivery, and every reporter needs a reissued config; every open connection that held a client certificate is
closed. A reporter asleep past both the cross certificate and
its own certificate's end needs a reissue.

**Failure behavior** (written from #577, pending the maintainer's confirmation in the review of #578).

- *The reporter* says what is wrong in the status line and in `/podium`, never a bare "offline", for each of:
  no `node`; no config file; a config file that is group- or world-readable; an expired certificate (it says it
  expired on a named date and that an Admin must generate a new config, from the certificate's `notAfter` and the
  machine's clock, with no connection attempt); a revoked certificate; a name in the
  file that does not match the session's; an unreachable server (it retries as today); a server certificate that
  is expired, not for this name or not signed by the CA in the file; and a skewed clock. When a server certificate
  looks expired or not yet valid, the status line is `check the clock` if the server's time is unknown (the handshake
  failed before any reply) or differs from the machine's by more than 5 minutes, and it shows this machine's date (and
  the server's, from the `Date` header of its last reply, when known). It does not claim the clock is certainly wrong. A
  server time within 5 minutes of the machine's leaves the message that the server certificate expired (#650). It never
  sends a credential over `http://` when the URL was `https://`, and never falls back to HTTP unasked. Wording follows
  `docs/standards/voice.html`.
- *The helper* returns a structured error and aborts the response on a mid-body upstream error ([5.9](../05-mod-api/05-09-mod-configuration-userconfig.md)).
- *The server* logs `tls.*` events (handshake failures, use of a revoked or expired certificate, renewals) and
  writes every rotate, retire, revoke and setting change to the Admin log. The header pill covers the CA and the
  serving certificate. Each person's expiry is shown on Admin > People.

**Threat model** (written from #577, pending the maintainer's confirmation in the review of #578). `.github/SECURITY.md` carries the same list for readers.

- *TLS stops:* passive snooping of tokens, reports and answers; an active man in the middle; a host answering as
  the server (the reporter verifies the CA from its file); replay of captured traffic; a stolen database yielding
  usable reporter credentials (person certificates are public and tokens are hashes); and an expired or revoked
  certificate being used (checked on every request).
- *TLS does not stop:* a compromised machine or a stolen config file (the private key is in it: revoke the
  certificate and keep the file mode 0600); a stolen console token (revoke it); **a stolen `/data/tls`**, which
  holds the CA key and so everything it signs (an emergency rotation, a hard cutover and a reissue, and the folder
  must be backed up and permissioned like a secret); any process running as the same user (it can read the config
  and use the helper's socket); and plain HTTP while reporters are allowed over HTTP.

**Browsers.** Browsers do not use this TLS (#665). The console and Admin are plain HTTP on the console port, with the
name-and-token sign-in, and a person who wants HTTPS for them puts a proxy in front. No browser needs the CA, so the
Certificates page has no Download CA and no browser-trust text.

**Platforms and limits.** macOS and Linux are in scope, Windows is unsupported ([5.9](../05-mod-api/05-09-mod-configuration-userconfig.md)).
A public certificate authority and ACME are out of scope: a server with a real name can sit behind a TLS proxy
(#305).

## Who a report is from (issue #36)

- `PODIUM_TOKEN` is the *admin secret*. A credential is either a person's token or the admin secret.
- A person's token is `pdm_<12 hex key id>_<48 hex secret>` (192 bits of randomness). The server makes it in
  Admin, shows it once and stores only a SHA-256 of it. Random tokens of that length need no slow or keyed
  hash.
- The server finds a person by the key id, compares hashes in constant time, and accepts a report when the
  token is live (not revoked, not rotated away) and `Report.userName` equals that person's name, compared
  case-insensitively.
- The token, not the name, decides identity. The name is visible in the console, so the match is a consistency
  check and the token's randomness protects the account.
- A hook has no body name, so a person's token alone identifies it.
- The admin secret is accepted as before and puts the session under the owner `Admin`, unless the owner turned
  that off in Admin.
- With no `PODIUM_TOKEN` and no person token, a report is accepted with no owner ("Unassigned"). A person token
  that is presented is still checked.
- A session id that already belongs to another owner is refused with `409`.
- Any valid credential may `DELETE` a session.

## Activity history (#432)

Stored activity is reported text and can hold anything an agent read or ran, so it is the second read that is not open.

- Keeping it needs authentication on. Without a token the server runs the *Not stored* policy and refuses to save
  another.
- Reading it needs a respond session (the same sign-in as the file diff, *Responding* in
  [8.1](../08-ui/08-01-what-the-ui-must-do.md)). The session's owner (the signed-in person whose name equals the session's
  `owner`, compared case-insensitively) and an Admin can read it. An Admin can read it because the Admin runs the
  server and can already delete it; unlike the file diff, this is not limited to the owner. A session owned by
  `Admin` is read with the admin secret. A session with no owner can be read only by an Admin. Everyone else gets
  `403`, and the live route's `history.canRead` is false for them.
- Only the Admin changes the policy, previews it, lists what is stored and deletes it, through the Admin API
  ([7.1](07-01-endpoints.md)), which needs the unlocked Admin session. Each change and each delete is written to the
  admin log (`activity_history_changed`, `activity_deleted`), and each purge run that removes something is
  (`activity_purged`), with counts and sizes and never entry text.
- The text is never logged, and a backup of the database folder holds it until a purge or a delete removes it. A
  delete removes it from the database and compacts the file; it does not change copies made earlier.

## Session recording (#353)

A recording is the most Podium keeps of a conversation: whole prompts, file contents, command output and tool results
([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md#session-recording-opt-in-353)). It is the third read that is not open, and the only one whose content is written
as it happens.

- **It needs all three yes answers** to capture or store anything: the Admin's `session-recording` flag, a choice by
  the session's owner or an Admin, and the reporter's `sessionRecording` option. With the flag off the server lists
  no loop to record, refuses the mod's route (`403`) and the browser routes (`404`), stops every recording, and keeps
  what is stored until it expires.
- **It needs authentication on.** Without a token the flag cannot be turned on and the server reads it as off, for the
  reason the Activity history gives: nobody could be told apart as the one who may read.
- **A start needs headroom under the disk budget.** Headroom is one full request, 480,000 bytes. A start (`PUT`) is
  refused with `409` when the stored total plus 480,000 bytes is above the budget, because ingest stops a recording at the
  entry that would pass the budget and a recording that starts with less room would stop at its first batch. The error
  reads "the disk budget has no room for a new recording". Deleting a recording makes room.
- **Who may read, choose, stop, delete or open it:** the session's owner and an Admin, by the Activity history's
  rule (a respond session; the signed-in person whose name equals the session's `owner`, compared
  case-insensitively; a session owned by `Admin` is read with the admin secret; a session with no owner by an Admin
  only). Everyone else gets `403`. The owner and an Admin are equals here: either can start, stop and delete, and an
  Admin can do it without the owner's knowing, which is why the notice cannot be hidden and the owner's terminal is
  told, by the mod, every time.
- **Everyone** who can open the console sees that a session is recorded: the state, who started it, which loops are and
  are not recorded and when it goes (`SessionView.recording`, [7.4](07-04-view-types.md)), and never any content. This is
  not a wall notice and has no way to be closed ([8.1](../08-ui/08-01-what-the-ui-must-do.md#session-recording-353-mockuppodium-recordinghtml)).
- **Only the Admin** changes the retention and the two sizes, lists every recording with its owner, who started it,
  state and size, and stops or deletes any of them, through the Admin API ([7.1](07-01-endpoints.md)).
- **The admin log.** Each of these is written with who did it and the session, never any text:
  `recording_started` (loops, by whom), `recording_stopped`, `recording_deleted` (entries, bytes),
  `recording_limit` (the session or the budget stopped one), `recording_read` (a replay was opened: a read without
  `before`, so paging back does not repeat it), `recording_settings_changed` (the three values before and after) and
  `recording_purged` (a purge run that removed something, with counts and sizes). The flag is `feature_changed`, as for
  every flag.
- The text is never logged, in a line, an error or the admin log. A backup of the database folder holds it until a
  purge or a delete removes it; a delete removes it and compacts the file, and does not change copies made earlier.
- A recording is redacted on the machine before it is sent and the server adds no second pass. Redaction is best
  effort ([6.4](../06-reporter-protocol/06-04-failure-and-excerpt-rules.md#session-recording-opt-in-353)), so the User Guide says that a recording can hold a secret.

## File diff (#319)

A file's diff is source code. Reads are open by design, so this is the one read that is not.

- It needs authentication on, the Admin's `file-diff` flag, and the reporter's `fileDiff` option on the machine.
- It needs a respond session, as responding does (the sign-in to respond, under *Responding* in [8.1](../08-ui/08-01-what-the-ui-must-do.md)). Only the
  session's owner can open a diff: the signed-in person whose name equals the session's `owner`, compared
  case-insensitively. An Admin who is not the owner cannot, and neither can a person in Administrators. A
  session owned by `Admin` (reported with the admin secret) can be opened only by a browser signed in with the
  admin secret. A session with no owner has no one who can. Everyone else gets `403`. Opening is kept to the
  owner because a diff is source code and fewer people who can read it means fewer places it can leak.
- Each diff opened is not written to the admin log with its text. The log records only that the diff of a
  path was opened, by whom (`file_diff_opened`: actor, session, path), never the text. A diff loaded ahead
  (#631, `GET …/files/diff?path=…&ahead=1`, refused with `403` unless the reporter sent `fileDiffPreload`)
  is logged when it is loaded as `file_diff_loaded` with the same fields. Opening one that was already loaded
  makes no diff request, so the browser tells the server with `POST …/files/diff/opened`, owner only, which
  writes `file_diff_opened`.
- Signed out, or for a session that is not yours, the Files row shows the counts and no link, with a line
  that says why ([8.1](../08-ui/08-01-what-the-ui-must-do.md)).

## The Admin API (`/api/admin`)

**Sign-in**
- Off (403) when `PODIUM_TOKEN` is empty.
- `POST unlock` takes a name and a token, the same pair as the sign-in to respond (#215): the token of a person
  in the built-in **Administrators** group with that person's name (case-insensitive), or the admin secret with
  the name `Admin`. A missing name or token is a `400`.
- It starts an in-memory session whose id is in an `HttpOnly; SameSite=Strict` cookie scoped to `/api/admin`.
  The session ends after 10 idle minutes, on lock, and on restart, so rotating the admin secret (which needs a
  restart) ends every session.
- Five wrong names or tokens from one source address lock that source for 15 minutes. A name or token that is
  unknown, mismatched, revoked, rotated away or from a person outside Administrators is refused with the same
  `401 wrong name or token`, never saying which part was wrong, and counts toward the same lockout.

**No second sign-in (#215)**
- `POST unlock/from-respond` (no body) opens a session for a browser whose sign-in to respond (below) is an
  Administrator's, or Admin's with the secret. It is a `401` for anyone else.
- So an Administrator who is signed in to the console opens Admin without typing anything again, including
  after the idle lock. It records the same `unlock` entry and actor.

**An explicit lock holds it shut (#272)**
- `POST lock` also marks that browser's sign-in to respond as held, and `unlock/from-respond` is a `401` for a
  held sign-in. So reloading `#/admin` after Lock Admin shows the name-and-token sign-in while the console
  sign-in itself stands.
- Unlocking with the name and token of the person who is signed in to respond in that browser lifts the hold
  (the idle lock then lets them back in as before). A different Administrator unlocking there does not.
- A new sign-in to respond starts without a hold, and another browser's sign-in is unaffected. The hold lives
  in memory with the sign-in and ends with it.
- The Admin button in the top bar shows only to a browser signed in to respond as an Administrator
  (`GET respond/me` says `admin`), and not on the Admin page itself (`TopBar.tsx`). Signed out or signed in as anyone else, there is no Admin button in the top bar. Anyone else reaches Admin at `#/admin`, which shows the name-and-token
  sign-in.
- Hiding the button is not the check: every Admin route except `GET session` and the two unlocks needs an
  open session.

**Administrators (#172)**
- Migration 14 creates the group `Administrators` on every server (a group already of that name is adopted).
- It is built in: `DELETE groups/:id` on it is a `400` that says why, and group listings carry `builtIn`.
- The admin secret is the Admin user and is always a member, shown as a fixed member and never stored as a
  person row, so the group may hold no people and nobody can be locked out of it.
- A session an administrator opened records who opened it and ends on the next request after they leave the
  group or their token is revoked.
- The admin log records an `actor` for each entry: the person's name, or `Admin secret`. Entries from before it
  was recorded have none.
- A person's token still reports as that person, and the owner `Admin` is unchanged.

**Protections**
- Every change needs the header `X-Podium-Admin: 1` and, when an `Origin` is sent, the server's own host. No
  CORS is enabled.
- Every response carries `Cache-Control: no-store`.
- The secret and tokens are never logged, never put in an error, the activity list or the admin log, and never
  stored by the page in `localStorage` or `sessionStorage`.

**The admin log**
- It records unlocks, failed unlocks, lockouts, people, rotations, revocations, group changes, the reporting
  switch, the feature flags (a flag turned on or off, kind `feature_changed`), the wall settings (a notice
  turned on or off, background sessions shown or hidden), the model prices (a price set, a price reset), a
  reporter taken off the list (`reporter_removed`) and the Activity history (#432: a policy saved,
  `activity_history_changed`; entries deleted by the Admin, `activity_deleted`; a purge run that removed
  something, `activity_purged`, one entry per run, with counts and sizes and never text) and session recording
  (#353: `recording_started`, `recording_stopped`, `recording_deleted`, `recording_limit`, `recording_read`,
  `recording_settings_changed` and `recording_purged`, never text; [7.7](#session-recording-353)), each with the source
  address.

**Names**
- A name is 1 to 48 characters and a group name 1 to 24, with no control characters, both unique
  case-insensitively.
- The name `Admin` is reserved: it is the owner of a report made with the admin secret.
- A person sees no one's token, including their own. Only an Admin rotates it, and there can be several.

## Which reporters the server knows (#142)

**What is recorded**
- After each accepted report (`POST /report` and `POST /hook`, never a refused one, and never the simulator's,
  whose `reporter.hostSurface` is `simulator`, so a simulator run leaves no row behind, #168) the server notes
  its sender in `reporters`.
- One row per account on a machine. The row's key is:
  - `machine.id` for the first account to report, and `<machine id>#<owner>` for each other account on that
    machine (two accounts on one machine send the same id, #221);
  - or the source address when the report carries no machine (a reporter with no user name sends none,
    [6.2](../06-reporter-protocol/06-02-the-report.md)), with the prefix `addr:` for a mod and `hooks:` for the settings hooks. Several
    machines behind one address share a row until they send an id.
- A session belongs to one reporter. A report with no machine id that carries a session already recorded under
  another `addr:` (or `hooks:`) row is filed under that row, oldest first. A row created for the new address
  before the session turned up is merged into it.
- So a reporter whose address changes, as a container's does when it restarts, stays one row, with its
  first-seen time and sessions kept. A reporter that has never reported a known session from a new address
  still gets its own row. Migration 12 merges rows that already share a session.
- A reporter with no machine name is named by its newest session's project, else its source address (`named`
  is false, and the page says no name is set and that the `userName` option sets one).
- The row keeps the machine name, source address, owner, the credential as `pdm_<key id>` or `admin secret`
  (the key id only finds a person and is not a secret; the token never reaches this table), the reporter and
  Claude Code versions, and the first and last time it was heard.
- `reporter_sessions` records the sessions it reported, so the total outlives the 30-day session retention.

**State**

The server works the state out from the last report, the time the server started and now:

| State | Meaning |
|---|---|
| `reporting` | Heard from in the last 2 minutes. |
| `idle` | Under 1 hour. |
| `silent` | Longer. |
| `restart` | Last heard before this server started; shown as "Not since restart". |

`silent` means only that nothing arrived. The server cannot tell a reporter that is turned off from one that
cannot reach it, and the page says so.

**Refusals and the admin secret**
- The server also keeps the last 200 refused reports in memory only (source address, time, one of its fixed
  reasons) and shows those from a reporter's address in its detail. They are lost on restart.
- A reporter that reports with the admin secret (its `credential` is `admin secret`) instead of a person's
  token is always flagged (`adminSecret`), whatever the setup. `GET reporters` returns the count of them
  (`adminSecret`, unfiltered), takes `admin=1` to list only them and `sort=token` to put them first, and each
  row carries its `credential`. With authentication off there is no credential, so nothing is flagged.
- A reporter's compatibility is `checkReporter` ([6.8](../06-reporter-protocol/06-08-version-compatibility.md)) on its version, and
  `unknown` for the settings hooks.

**Detail and removal**
- `GET reporters/:key` also returns how many of its sessions are running, the refusals, and its sessions that
  still exist, newest first and paged like the other lists (`page`, `pageSize`). `recent` is that page, with
  `recentTotal`, `recentPage` and `recentPageSize`.
- `DELETE reporters/:key` takes a reporter off the list (kind `reporter_removed`). It returns if it reports
  again, and its sessions are untouched.
- `POST reporters/remove` does the same for many at once and writes one `reporter_removed` entry with the
  count.

**Ignoring (#167)**
- `POST reporters/ignores` adds a rule that matches a reporter's key, its source address or its reporter
  version, and takes the reporters it matches off the list.
  - `*` means "anything", never a regular expression. Case is ignored. An identical rule is kept once.
  - A pattern of only `*` is a 400, since it would turn every reporter away.
- `GET` lists the rules and `DELETE reporters/ignores/:id` removes one (kinds `reporter_ignore_added` and
  `reporter_ignore_removed`).
- A key rule on a machine id covers every account on that machine. A rule on `<machine id>#<owner>` covers
  that account only (#221).
- A report (`POST /report`, and `POST /hook` by address) from a reporter a rule matches is **refused** with 403
  `this reporter is ignored by the Admin`, before anything is stored. Its sessions stop appearing on the fleet
  until the rule is removed. The refusal is logged (`report.ignored`) and shown in the reporter's refusals.
- The simulator is never matched.

**Access and format**
- All of these need an unlocked session, because a source address and a machine name are personal data.
- The report format is unchanged: there is no install id, and the mod's options are not sent, so the page
  cannot show them.

## Responding (#206)

This is the only way anything reaches a session from Podium, so every rule here holds whatever else is set.

**Off by default, five switches**
- It needs authentication on (`PODIUM_TOKEN` set). With it empty there is no credential to check, so every
  respond route answers `403` and every report reply says `respond: false`.
- It needs the Admin's **Respond from Podium** flag (`respond` in `FEATURES`, Admin > Settings > Feature
  flags, "Lets people answer and message the sessions they own. Each answer is written to the admin log with
  who sent it.", off by default, a change written to the admin log as `feature_changed`).
- It needs the Admin's `activity-feed` flag.
- On the session's machine it needs the reporter's `respond` option (not `off`) and `activityFeed` option
  ([5.9](../05-mod-api/05-09-mod-configuration-userconfig.md)).
- With any of them off there is no Respond button and no message box, every browser respond route but
  `GET me` refuses, the report reply's `respond` is false and its `deliveries` empty, and the mod accepts
  nothing. Podium is observe-only, as before.
- The mod checks its own two switches and its level itself and never relies on the server for them.

**Who**
- Only the session's owner (the person whose name, compared case-insensitively, is the session's `owner`) or
  an Admin (the admin secret, or a person in Administrators) can respond.
- A session owned by `Admin` can be answered only by an Admin.
- Everyone else gets `403 { error: "not your session", owner }`, and the console shows Respond dimmed with
  whose session it is.

**The browser's credential**
- Reads stay open, but every respond route except `GET /respond/me` needs a respond session.
- `POST /respond/sign-in` takes a name and a token, the same pair as the reporter's `userName` and `token`
  options. It checks them the way a report's credential is checked against its `userName` (`identify` in
  `routes.ts`): a person's token is accepted only with that person's name, compared case-insensitively, and
  the admin secret only with the name `Admin`.
- A person in Administrators signs in with their own name and token and can respond to every session.
- It starts a session whose random 32-byte id is in a cookie, `podium_respond`,
  `HttpOnly; SameSite=Strict; Path=/api` (and `Secure` over HTTPS). The path is wide so that
  `POST /api/admin/unlock/from-respond` receives it (#215). The session is held in the server's memory only.
- It ends on sign-out, on restart, after 12 hours without use, and on the next request after the person's
  token is revoked or rotated. An Admin's rights follow their membership of Administrators on every request.
- Five wrong tokens from one source address lock it out for 15 minutes, counted together with failed Admin
  unlocks.
- A sign-in and a failed sign-in are written to the admin log (`respond_sign_in`, `respond_sign_in_failed`).
- The token is never stored by the page and never logged.

**Cross-site protection, as in the Admin API**
- Every respond route that changes something needs the header `X-Podium-Respond: 1` and, when an `Origin` is
  sent, the server's own host.
- No CORS is enabled. Every response carries `Cache-Control: no-store`. JSON bodies over 64 KB are refused.

**The mod's routes**
- Asks, held requests, closes and results ([7.1](07-01-endpoints.md)) need `X-Podium-Token`, checked as for
  `POST /report`.
- The credential must be the session's owner: a person's token for that person's session, the admin secret for
  a session owned by `Admin`.
- A wrong credential is `401`, another owner's session `403`. They need no `Origin` check, since a page on
  another site has no token to send.

**The mod never trusts the server**
- It acts only within its own `accepts` ([5.3](../05-mod-api/05-03-events-the-reporter-hooks.md#responding-from-podium)), only on an ask it has open and a hook
  of its own is waiting on, and runs no command but `/clear` and `/compact`.
- A tool's answer never carries `updatedPermissions` ("always allow" and every other change to permission
  rules stay in the terminal).
- A plan approval's only `setMode` is `auto`, `acceptEdits` or `default` with `destination: "session"`, and its
  `updatedInput` is the event's own `tool_input`, unchanged.

**The admin log**
- Each answer, message and command the server takes is written to the admin log as `respond_sent`, with:
  - who sent it (`actor`) and the source address;
  - the session (its name and the first 8 characters of its id);
  - the kind of answer: answered a question, sent a message in place of an answer, approved a plan (with the
    mode), sent a plan back, allowed a tool once, denied a tool, sent a message, ran `/clear`, ran `/compact`.
- Its detail ends with the delivery's short id in brackets (`dlv_` and 8 hex digits).
- What then became of that answer is a second row with the same actor and short id:
  - `respond_result` when the mod reports a result: the session took it, queued it, did not take it, refused
    it, or it had closed before the session got it. A repeat of the result a delivery already has, as from a
    mod retrying, writes no second row.
  - `respond_dropped` when the server let go of it with no result: its sender discarded it, its ask closed
    first, the session ended first (for a message, command or handed-over answer still waiting for a result),
    the session ended while a message was still queued (Podium cannot tell whether Claude Code read it), the
    session was deleted first, or responding was turned off first.
- Deleting a session or turning responding off writes one row for each such delivery, not one for the lot, so
  a row always pairs with its `respond_sent` by id (DECISIONS 34).
- A delivery that already has a result is not written again, and one that is dropped twice (a session that
  ended, then was deleted) is written once.
- The server log has the same as `respond.sent`, `respond.result` and `respond.dropped`, and each refusal as
  `respond.refused` with its reason.
- The text of an answer, a message, a question, a plan or a tool's input is never logged, shipped or stored on
  disk ([7.2](07-02-database.md)).

**What the content is shown as, and to whom**
- An ask's content and the answers are served only to the session's owner or an Admin
  (`GET /respond/sessions/:id/asks/:askId`), never in the state or the stream, which carry only a summary
  ([7.4](07-04-view-types.md)).
- Question text, option labels and descriptions, previews and tool input are drawn as text nodes. The plan's
  markdown goes through the existing renderer from #97 (`frontend/src/fleet/components/Markdown.tsx`).
- Allow once is refused (`422`) for a tool whose input was cut off (`tool.cut`), since the person could not see
  all of what they would allow. Deny still works. The modal doesn't offer Allow then: it selects Deny and says
  "This command is too long to show in full here, so it can only be allowed in the terminal. You can still deny
  it from here."

**Validation**
- The server validates every ask and every delivery against the limits in [6.2](../06-reporter-protocol/06-02-the-report.md).
- It clamps nothing it would then act on (a delivery over a limit is a `400`, not cut).
- It strips control characters except line breaks from text.
- It checks an answer against its ask: one option for a single-choice question, indexes in range, a kind that
  fits the ask's kind.

**Security note**
- `.github/SECURITY.md` says what responding exposes: that it lets the server's people send answers and
  messages into sessions whose owners opted in, what the console shows to whom, and that the browser's token
  and the session cookie travel over plain HTTP unless a TLS proxy or built-in TLS is used.

## Orchestrator messaging (#347)

Designed on #347 (DECISIONS 37). The server and the protocol (#412), the mod (#414), My reporters (#415), the
Admin's pages (#416), Traffic (#417) and an owner's stricter limits (#436) are built. One orchestrator's text becomes a turn in another's session,
so every rule here holds whatever else is set. The routes are in [7.1](07-01-endpoints.md) and what is kept in
[7.2](07-02-database.md#what-orchestrator-messaging-keeps-and-where-347).

**Words used here**
- A reporter is one machine plus one person's token. Rights belong to reporters.
- A link is a pair of reporters, either way round, the same reporter twice included (two orchestrators on one
  machine). Pause link, Remove link, the messages per minute and how long messages are kept go by link.
- A conversation is the messages between two orchestrators on a link. Round trips are counted per conversation. The reporter's side is described in
[5.3](../05-mod-api/05-03-events-the-reporter-hooks.md#orchestrator-messaging-from-the-reporter-347). Mockups: `mockup/podium-my-reporters.html`,
`mockup/podium-traffic.html`, `mockup/podium-peer-messages.html`.

**Off by default**
- It needs authentication on, the Admin's **Orchestrator messaging** flag (`peer-messaging` in Admin > Settings >
  Feature flags, off by default, a change written to the Admin log as `feature_changed`), the `peers` option on both
  machines, and a right between the two reporters.
- The report reply says `peers: true` only with authentication on, the flag on, the report made with a person's token,
  and its `session.peers` true. Otherwise `peerDeliveries` and `peerRequests` are empty and every messaging route
  refuses (`403`).
- With the flag off, the report reply says `peers: false`, no tool is offered, My reporters hides its messaging
  sections and Traffic leaves the top bar. Every message still waiting is dropped and Podium's notices are cleared.
  The rights stay.
- A browser can sign in for My reporters while the flag is on, even with responding off.
- An older reporter sends no `peers`. Its sessions are never listed, never resolved as a `to`, and never sent a
  message.

**One person only**
- A right, and a message, can only join two reporters with the same owner. The server refuses anything else,
  whatever the settings say. Messaging between people is not built: Anthropic's terms leave it unclear
  (DECISIONS 37).
- A reporter on the admin secret cannot take part, since its sessions belong to no one: no right can name it, its
  sessions are never listed, and a mod route called with the admin secret is refused.
- Every write that joins two reporters checks this itself, and stores nothing when it fails.

**Rights**
- Rights belong to a pair of reporters and go one way: A can see B, A can send to B, and the same from B to A.
  Sending includes seeing. A right to send is with approval or without approval.
- A reply is a message too and needs its own right to send.
- The owner sets rights on My reporters, signed in as for responding. **Trust my own reporters** gives every pair
  of the owner's reporters the right to send without approval, including reporters added later.
- An Admin can propose a right on Admin > Reporters > a reporter. It applies only once the owner accepts it, and
  no default accepts it for them. A proposal only raises a right: the server refuses one at or below the stored level,
  and accepting one never lowers a right that rose in the meantime. An Admin's **Pause all links** and any removal take
  effect at once.
- An orchestrator can ask for a right with `podium_request_access`. The owner's default for that is Ask me, Allow
  or Decline. Allow never lowers a right already given; a right to send is created as the owner's "A new right to send
  starts as". An asked request's answer reaches the orchestrator that asked as a notice.
- Trust my own reporters makes every pair send without approval. A pause still holds under it, and so does a removal,
  which then leaves the link paused.
- Lowering a right does not recall a message already taken: it is delivered under the right it was sent with. Remove
  link drops it.
- A request is answered in My reporters or with `/podium allow|decline|deliver <id>` in a session. Answering in one
  closes it in the other; a second answer is a `410` that says how it closed.

**Who a message is from**
- The sender is the session and token of the request that carries it, never a name in the message. The server
  resolves `to` (`name@machine`, case-insensitive) only among the same owner's live orchestrators whose `peers` is on
  and that the sender's reporter can see. A name it cannot find there, another person's, and one it has no right to see
  all get the same `404`, so a refusal says nothing about who else exists. Two that match are a `409`, which names the ids that tell them apart. An inbound message carries the sender's
  short id (`from.id`), and the mod frames the reply address as `name@machine#id`, so a reply reaches the sender even when
  others share its name (#500).
- A message is only for an orchestrator, and only an orchestrator sends one.

**Limits**, set by the Admin in Admin > Settings, in an Orchestrator messaging section shown while the flag is on
(#416), which an owner can make stricter on their own links. A value is saved when its box loses focus or on Enter; one
out of range is refused in place, and the error says nothing was saved and which value still applies.
- round trips in a conversation before the owner approves the next message, 10 by default (1 to 100);
- messages per minute on a link, either way, 6 by default (1 to 60);
- the longest message, 20,000 characters by default (1 to 20,000), counted after control characters other than line
  breaks and tabs are replaced.
- Over the length or the rate, a message is refused with the reason (`422`, `429`), never cut.
- A round trip is two changes of direction in a conversation, counted from the last message the owner approved. At the
  cap the next message waits for approval, as it does on a link with approval, and approving it starts the count again.
- An owner's stricter limits (My reporters > Defaults) apply to the owner's links. A limit above the Admin's is
  refused, and if the Admin later lowers theirs, the lower one applies.

**Delivery**
- A message is held until the receiving orchestrator's turn ends, and a message that needs approval is held
  until its owner approves it. The server hands a message over only in the reply to a report that says the session is
  idle (`status: "waiting"`, `waitReason` not `permission`).
- A held message is dropped if the receiver ends (it reports `done` or leaves the live set), a session is deleted, the
  link is removed, the receiving reporter refuses it, or the flag goes off. The sender is told by a notice while it is
  live, except when the flag goes off.
- A declined message is not delivered, and its sender is told.
- Pause link holds every message on that link and keeps its rights. Resume link lets them go.
- A message takes a result as responding's do (`took`, `queued`, `refused`), through its own route, with the same
  dedupe: a repeat of the result it has is a `200` and is logged once.

**What is kept, and who can read it**
- The text of each message is stored, with its sender, receiver, times and delivery state, until 30 days after
  the last message on its link (Admin > Settings, 1 to 365 days), and is deleted with its sessions. This is unlike responding,
  which keeps nothing: a conversation between agents is only worth having if a person can read it afterwards.
- Only the owner and an Admin can read the text. Everyone else sees that two orchestrators talk, and the counts
  (`GET /api/fleet/peers/traffic`). The text never goes in the state, the stream or a log.
- Message text is drawn as text nodes. The only element inside it is Podium's own `[redacted]` marker.

**The admin log**
- Each message sent, delivered, approved, declined or dropped, and each right set, proposed, accepted, declined,
  paused, resumed or removed, is a row with the sender, the receiver, the owner and the kind. Never the text. The kinds
  are `peer_sent`, `peer_delivered`, `peer_approved`, `peer_declined`, `peer_dropped`, `peer_right_set`,
  `peer_right_proposed`, `peer_right_accepted`, `peer_right_declined`, `peer_right_paused`, `peer_right_resumed`,
  `peer_right_removed`, `peer_access_requested`, `peer_defaults_changed` and `peer_limits_changed`. A message's row ends
  with its short id (`dlv_` and 8 hex digits), a request's with `prq_` and 8.
- The server log has the same as `peers.sent`, `peers.delivered` and so on, and each refusal as `peers.refused` with
  its reason.

**Security note**
- `.github/SECURITY.md` says what messaging exposes: anyone holding a person's token can send text into that person's
  linked orchestrators, and the text is kept on the server.

## The `Host` header (#256, DNS rebinding)

A page on another site can point its own name at this server's address, and the browser then lets that page
read the open routes.

- The server runs a check ahead of every route (before the response headers, the log and the routers). It
  answers `403 { "error": "host not allowed" }` to a request whose `Host` is none of:
  - `localhost` (with or without a trailing dot), an address in `127.0.0.0/8`, or `[::1]`;
  - the address the server is bound to (`HOST`);
  - a name or address in `PODIUM_ALLOWED_HOSTS` (comma-separated; set with `podiumctl config set`);
  - when `HOST` is `0.0.0.0`, `::` or empty, any IP address (an address cannot be rebound, a name can).
- The port is never compared, a missing or malformed `Host` is refused, and names are compared
  case-insensitively.
- In container mode the server listens on `0.0.0.0` inside the container, so any address is taken there and a
  name needs `PODIUM_ALLOWED_HOSTS`.
- A refusal is logged as `http.host_refused` (warn) with the `Host` value only, never a header, query, path or
  body, and at most once a minute per value.
- See DECISIONS 33.

## Behind a reverse proxy (#305)

- `PODIUM_TRUST_PROXY` (set with `podiumctl config set`, then `podiumctl restart`) names the proxy hops whose
  `X-Forwarded-For` and `X-Forwarded-Proto` the server believes. It is passed to Express `trust proxy`.
- It is off by default, and then nothing changes: `req.ip` is the connection's peer and `req.secure` is false
  behind a proxy that terminates TLS.
- The value is one of: a hop count (`1`); addresses or CIDR ranges, comma-separated (`10.0.0.5,172.16.0.0/12`),
  which may include `loopback`, `linklocal` and `uniquelocal`. Empty, `0`, `false` and `off` mean off.
- `true` is refused, since it trusts every hop. A malformed value stops the server at start with a message
  naming `PODIUM_TRUST_PROXY`, rather than trusting nothing or too much.
- With it set, `req.ip` and `req.secure` follow the headers only through trusted hops; a request from an address
  that is not trusted is read as before, so a client cannot spoof them.
- It changes what the source address is everywhere it is used: the `source` of the admin log rows, the Admin and
  sign-in lockout, the admin-secret guess throttle (#255), and the `Secure` flag of the Admin and respond cookies
  (and the plain-HTTP warning on a sign-in, above).
- Trusting a hop that does not overwrite `X-Forwarded-For` lets any client choose its source and defeats the
  lockouts; the documentation says so.
- See DECISIONS 35.

## Guessing the admin secret through `X-Podium-Token` (#255)

- The routes that check it (`POST /report`, `POST /hook`, `DELETE /sessions/:id` and the mod's respond routes)
  throttle wrong secrets per source address, with a counter of their own, apart from the Admin and sign-in
  lockout (which is unchanged).
- Five *different* wrong values from one address throttle it for 15 minutes. The same wrong value sent again
  counts once, so a reporter with a stale credential, which always sends the same one, throttles nobody.
- A person's token (`pdm_…`, 192 bits) is never counted or throttled, whether right, revoked or unknown, so
  reporters with a person's token are not counted or throttled by this counter, whatever else the address sends.
  The per-address limit on failed requests (below) is separate and does apply to them.
- While an address is throttled, any other value is answered `429 { ok: false, error: "too many wrong tries", retryAfterSec }`
  with a `Retry-After` header, even the right admin secret, since answering it would confirm a guess.
- The refusal is logged as `auth.failed` (`reason: "too many wrong secrets"`, `status: 429`) and shown in the
  Reporters page's refusals. The value is never logged.
- The counters are in memory only.
- At start the server warns (`server.weak_token`, never the secret) when `PODIUM_TOKEN` is under 24
  characters.

## Failed requests per address (#667)

- Ahead of every `/api` route, one address may make 300 requests a minute that end in a response of 400 or more.
  `PODIUM_FAILURE_LIMIT` changes the number (a whole number of at least 1; anything else stops the server at start).
- Successful requests are never counted. Every response of 400 or more counts, a `404` or `409` included.
- Past the limit the next request gets `429 { ok: false, error: "too many failed requests", retryAfterSec }` with a
  `Retry-After` header, until the minute is over. That includes a valid request from the same address, a reporter
  with a person's token or a certificate included.
- The first refusal for an address in a window is logged as `auth.throttled` (`warn`). The counters are in memory only.
- The address is the one Express sees, so behind a proxy it follows `PODIUM_TRUST_PROXY` (7.7, reverse proxy).
- It is separate from the wrong-secret throttle and the Admin and sign-in lockout, which are unchanged.

## Plain HTTP warnings (#306)

Nothing blocks. The server logs a `warn` event `server.respond_plain_http` (fields `trigger`, `bind`, or
`request_host`; never a token, header or cookie value):

1. Once at start, and again whenever the Admin turns Respond from Podium on, when `HOST` is not loopback
   (`127.*`, `localhost`, `::1`) and the flag is on.
2. On a sign-in to respond whose connection Express sees as `http` and whose `Host` is not loopback, at most
   once a minute. `req.protocol` follows `X-Forwarded-Proto` only from a hop named in `PODIUM_TRUST_PROXY`
   (see "Behind a reverse proxy").

Other places the warning shows:

- Admin > Settings adds a caution to the Respond from Podium row when the console itself is loaded over
  `http:` from a non-loopback host.
- The reporter mod starts its status line with `⚠ ` and toasts once per session when its `serverUrl` is
  `http:` to a host that is not loopback. It keeps reporting.

## Request limits and validation

- Body limit 512 KB. Validate every field's type and length, and clamp strings:
  - name ≤ 80, text ≤ 240, excerpt ≤ 400;
  - `promptText` and `answerText` ≤ 20,100 (line breaks kept, other control characters removed);
  - arrays ≤ 200 agents, ≤ 100 events and ≤ 100 plan steps per report.
- `toolCounts` takes at most 100 distinct tool names per agent, and per `session.loop`. The mod stops adding new
  names past 100 (they still count in `toolCalls`), and the server keeps the 100 most used (ties by name)
  instead of rejecting the report, so the counts then add up to less than `toolCalls`.
- `session.files` keeps the first 200 files (paths clipped to 300 characters and stripped of control
  characters, counts non-negative integers, `total` never below the listed count) rather than rejecting a
  longer list.
- `userName` is clipped to 80. `machine.name` is clipped to 64, trimmed and must not be empty. `machine.id`
  must be 1 to 32 letters, digits, `-` or `_`.
- `activity` (on the session and on each agent) takes at most 20 entries. A longer list is rejected. Each
  entry's text is clipped to 300 characters and stripped of control characters. Past 60,000 characters of
  activity in one report, the server drops the feed of the loops that do not fit (the orchestrator's first,
  then the agents' in order) rather than the report.
- An activity entry's `id` is clipped to 200 characters, and its `command` and `output` to 20,100 (the 20,000-character
  cap plus the cut-off marker), keeping line breaks. `exitCode` is a non-negative integer; `commandCut`, `outputCut`,
  `done` and `failed` are booleans. A wrong type is rejected with the field's path. The new fields are dropped, not
  rejected, on an entry that is not a `tool` entry, and `output` and `outputCut` are dropped unless the session's
  `activityOutput` is true. `done`, `exitCode` and `failed` are kept with the feed whatever `activityOutput` says, and
  count toward neither budget (#598). An older server drops them without `activityOutput`, so it ignores the new fields:
  its rows stay as they were. Past 200,000 characters of commands and output in one
  report, the server drops the output of the oldest entries that do not fit, then their command (the orchestrator's
  loop first, then the agents' in order, each from its newest entry back), and keeps their summaries.
- Reject, never crash, on junk.
- Never execute, `eval`, or interpolate reported strings into SQL (parameterized statements only) or into HTML
  (the UI uses React text nodes only).
- CORS: none needed (same origin). Do not enable `*`.

## The release check's request (#499)

The release check ([6.8](../06-reporter-protocol/06-08-version-compatibility.md#the-release-check-499-mockuppodium-update-noticehtml-mockuppodium-update-check-adminhtml)) is the only request the
server makes to a site of its own choosing, and the only one that does not answer a reporter or a browser.

- It is one HTTPS `GET` to `api.github.com` a day, with `User-Agent: podium-release-check` and no body, no token and no
  identifying field. The reply is read as JSON and only `tag_name`, `prerelease` and `draft` are used.
- It runs only while the Release check flag is on. Off, the server makes no outbound request.
- A server that cannot reach GitHub works as before: nothing waits on the check and nothing shows its failure.
- The container needs no new capability or port for it. A firewall that blocks outbound HTTPS makes every check fail
  quietly, which looks the same as no newer release.

## Server logging (issue #140)

- Each log line is an event with a stable dotted name (`report.rejected`, `session.started`,
  `admin.feature_changed`), a level and flat fields.
- Never log report bodies. Log one line per error with the path.
- `PODIUM_LOG_LEVEL` is `debug`, `info` (default), `warn` or `error`.
- `PODIUM_LOG_FORMAT` is `text` or `json`:
  - `text` (default) prints the message alone, as before. The events added in #140, such as `session.*`,
    `reporter.*`, `admin.*` and `sweep.removed`, print in text only at `debug`, so the default output is
    unchanged. A refused credential (`auth.failed`) and the `tls.*` events print at their own level, so an
    Admin can see why a reporter is refused. Repeats of one event, route, source and reason within 60 seconds
    are folded into the first line, and the next line says how many were held back. `json` and the shipper
    are not folded.
  - `json` prints one object per line with `timestamp`, `level`, `message`, `event`, `service`, `host`,
    `version` and the event's fields.
- Access logging is one `http.request` line per request at `debug`, with no query string, header or body. A
  request the client drops before the response is one `http.aborted` line at `debug` with the same fields but
  no status.
- `sweep.removed` names at most the first 10 session ids and counts the rest in `session_ids_omitted`.
- `update.check_failed` (warn) is one short line when the daily release check ([6.8](../06-reporter-protocol/06-08-version-compatibility.md#the-release-check-499-mockuppodium-update-noticehtml-mockuppodium-update-check-adminhtml)) gets no usable answer.
- **Shipping.** When `PODIUM_LOG_SHIP_URL` is set the server also pushes the JSON lines, gzipped NDJSON, to
  VictoriaLogs' `/insert/jsonline` with `_time_field=timestamp&_msg_field=message&_stream_fields=service,host`
  and the headers in `PODIUM_LOG_SHIP_HEADERS` (`Name=Value;Name2=Value2`).
  - Shipping is off by default and never delays a request.
  - It keeps at most `PODIUM_LOG_SHIP_BUFFER` lines (2000) while the endpoint is down, drops the oldest past
    that and says so once in the server's own output.
- No token, admin secret, ship header value, prompt, answer or activity text is ever logged or shipped. The mod
  does not ship logs.

## Response headers and the container (#249)

Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer` and a `Content-Security-Policy`:

- `default-src 'self'`;
- scripts only from the server and the page's one inline script (the theme setter in `frontend/index.html`,
  allowed by its SHA-256, computed from the built page at start);
- styles from the server, inline styles and Google Fonts;
- fonts from the server and `fonts.gstatic.com`;
- `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'` and
  `frame-ancestors 'none'`.

A new third-party origin or a second inline script needs the policy changed in
`server/src/securityHeaders.ts`. `podiumctl` starts the container with `--cap-drop ALL` and
`--security-opt no-new-privileges`, on top of the non-root user ([4.4](../04-architecture.md#44-packaging-running-and-distribution)).

---

<!-- nav:start -->
---

Previous: [7.6 SSE stream](07-06-sse-stream.md) · Up: [7. The server](README.md)
<!-- nav:end -->
