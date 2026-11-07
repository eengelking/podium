# Security Policy

## What "security" means for this repo

Podium is a small local service, not a hosted product. A server stores what Claude Code sessions report
about themselves in SQLite and serves a browser UI. A mod (`podium-reporter`) runs inside each Claude Code
session and sends reports to that server. `podiumctl` and a container image run the server. So the
problems that matter here are:

| Area | In scope |
|---|---|
| **Input to the server** | A report, a settings-hook payload or any other request that crashes the server, gets past validation, reads or writes a file, or runs a command. The server checks every report by hand (`server/src/fleet/protocol.ts`), so a gap in that check is in scope. |
| **Reported text reaching the browser or a shell** | Anything a session sends (a Bash command, an agent's answer, a path) that ends up rendered as markup or script in the UI, or in a command line. |
| **Secrets leaving a session** | The mod cuts text to fixed limits and replaces things that look like secrets with `[redacted]` (see [What leaves the session](../docs/REPORTER.md#what-leaves-the-session)). A real credential format that the redaction misses, or data the README says never leaves the session but does. |
| **Tokens and Admin** | `PODIUM_TOKEN` (the admin secret) opens Admin, and each person's token is bound to their name. A way around either; a token or the admin secret that shows up in a log, an error, the browser's storage or a command line; a token stored in a readable form; a way to open Admin or call its API without the secret or from another site; a way past the lockout; a config file with loose permissions. |
| **`podiumctl` and the container** | Command injection through a config value, the server listening on more than the user asked for, the container running as root, or a boot service file that does more than it should. |
| **The mod acting on a session** | Podium can answer a session that waits on its person, carry a message between one person's own orchestrators, and carry a Chat message from a person to an agent, and nothing else (see "Responding from Podium", "Orchestrator messaging" and "Chat" below). A way for the mod or the server to do more than that is a security bug: to send a prompt or an answer to a session whose owner didn't turn the `respond` option on, past the Admin's switch, at a level the session didn't allow, or from anyone but the session's owner or an Admin; to run any command but `/clear` and `/compact`; to change a session's permission rules ("always allow"); or to stop or start a session. |

### By design

These are not vulnerabilities on their own. [Running the server](../docs/SERVER.md#run-it-with-podiumctl) ("Several people on one Podium") and
`docs/gotchas/` say all of this.

| Behavior | Why it is not a bug |
|---|---|
| **Fleet reads are open on localhost.** `GET /api/fleet/state`, `/stream`, `/sessions/...`, `/events` and `/history` need no token; only reports, hooks and deletes do. | They show how the wall looks. A waiting session's question, plan or tool input (under `/api/fleet/respond`) is the exception: it is shown only to its owner or an Admin who has signed in. An agent's whole prompt and answer (`.../agents/:agentId/text`) and its live activity (`.../agents/:agentId/activity`) are the person's own content and are decided to be gated the same way, with the Admin notice (DECISIONS 62). **Until that is built they are still open.** |
| **Tokens travel in a header over plain HTTP, unless built-in TLS is on.** | Plain HTTP is the default for a fresh install. A server reachable over a network needs a trusted network, a TLS proxy or built-in TLS (see "Built-in TLS" below). |
| **A person who holds a valid token can delete any session.** | Any valid credential may `DELETE` a session. |
| **Anyone with access to your user account or to `~/.podium` can read the token and the data.** `podman inspect podium` (or `docker inspect podium`) also shows the token, because it is part of the container's environment. | The token has to live somewhere the server can read it. |
| **`--bind` or `HOST` set to something other than `127.0.0.1` lets other machines read the dashboard,** including every person's name and machine name. | That is what binding to another address asks for. |
| **A reporter sends a name and its machine's host name only when its user set `userName`.** Who a session belongs to comes from the token, so a name sent with the shared admin secret, or with auth turned off, is not shown as a person at all. | The setting is the user's consent. |

A session shown under a person whose token did not send it, or a name or machine name sent while `userName`
is empty, is in scope. So is a report that shows a way to do any of the above *without* the setting that
allows it.

## Responding from Podium

Since #206 Podium can answer a session that waits on its person: an AskUserQuestion form, a plan to approve, a
tool's permission prompt, a new message, `/clear` and `/compact`. It is off until the Admin and the session's
owner both turn it on. What it exposes:

| Topic | How it works |
|---|---|
| **Identity** | Each person gets a server-generated token, `pdm_<12 hex key id>_<48 hex secret>`: 192 bits of randomness, shown once, stored only as a SHA-256 hash and compared in constant time. The token decides who you are; the name is only a consistency check. One shared secret, `PODIUM_TOKEN`, works only under the name `Admin` and is meant as a break-glass path. |
| **The browser's sign-in** | The browser signs in with a name and a token, the same pair as the reporter's `userName` and `token`. That starts a random server-side session in an `HttpOnly; SameSite=Strict` cookie scoped to `/api`, held in the server's memory. It ends after 12 hours without use, on sign-out, on restart, and when the person's token is rotated or revoked. |
| **Who can respond** | Only the session's owner (the person whose token reports it) or an Admin (the admin secret, or a person in Administrators). A session owned by `Admin` can be answered only by an Admin. Anyone who holds a person's token, or the admin secret, can put text into that person's sessions, as far as each session's `respond` level allows. |
| **What it needs** | All of these on: authentication (`PODIUM_TOKEN`), the Admin's Respond from Podium flag, the Admin's activity feed flag, and on the session's machine the reporter's `respond` option and `activityFeed` option. `respond` is `off` by default. |
| **Browser requests** | Every change needs the header `X-Podium-Respond: 1` and, when the browser sends an `Origin`, that Origin must name this server. No CORS is offered. The server refuses a `Host` it does not expect. |
| **Guessing** | Five wrong tries from one address lock signing in for 15 minutes, counted together with Admin unlocks. Wrong admin-secret guesses on the report routes have a throttle of their own. |
| **The mod never trusts the server** | It checks its own `respond` level, answers only an ask it has open, and runs no command but `/clear` and `/compact`. It never sends "always allow" or any other change to permission rules, and a command too long to show in full can only be allowed in the terminal. |
| **What is seen and kept** | A question, a plan or a tool's input is shown only to the session's owner or an Admin, and kept in the server's memory only. The text of an answer, of a message typed in the console's message box, of a question, a plan or a tool's input is never stored or logged. A message written in Chat is the exception: it is stored as Chat's (see "Chat" below). |
| **Audit** | Each accepted answer, message or command is written to the admin log with who sent it, the source address, the session (its name and the first 8 characters of its id) and the kind of answer, for example "Allowed a tool once". Sign-ins, failed sign-ins, lockouts and flag changes are logged too. The log is shown only in Admin, and nothing edits or deletes its entries. The same events go to the structured server log, which can be shipped to VictoriaLogs. |

A way to answer a session without the switches above, without being its owner or an Admin, from another site, or
by sending more than the session's level allows, is in scope.

### Known limits

| Limit | What to do about it |
|---|---|
| **The admin secret is a shared credential.** Anything done with it is attributed to "Admin secret", not to a person. | Give each person a token, and turn off reporting with the admin secret in Admin when you no longer need it. |
| **The token and the session cookie travel over plain HTTP, unless built-in TLS or a TLS proxy is used.** The server warns in its log (`server.respond_plain_http`) when responding is on and it is bound beyond loopback, and when a sign-in reaches it over plain HTTP at a name that is not loopback; Admin > Settings and the mod's status line (`⚠`) say so too. None of them blocks anything. | On any network but your own machine, put a TLS proxy in front and set `PODIUM_TRUST_PROXY` to the proxy's address or hop count, so the Admin log and the lockouts see each person's address and the cookies are marked `Secure`. The bind-address warning cannot tell a proxied server from a bare one: with a TLS proxy in front you can ignore it. |
| **`PODIUM_TRUST_PROXY` believes `X-Forwarded-For` from the hops you name.** A hop that does not overwrite that header lets any client choose its source address, which defeats the Admin, sign-in and admin-secret lockouts and makes the Admin log's `source` untrue. `true` (trust every hop) is refused. | Name only a proxy that sets `X-Forwarded-For` itself, and only the hops between it and Podium. Leave the setting off with no proxy. |
| **The admin log has no export.** It keeps entries for 90 days (`RETAIN_ADMIN_LOG_MS`) and the newest 100 whatever their age. | Ship the server log to VictoriaLogs if you need a copy or a longer record. |

If you think you have found something like this, please report it rather than opening a public issue.

## Built-in TLS

Podium can open a second port for reporters (#577, #665, DECISIONS 42). It is off until the Admin turns it on with
`PODIUM_TLS=on` or `podiumctl start --tls`. The server then makes a CA and a serving certificate, and gives each
person a reporter config file with their client certificate and key, shown once. The reporter proves who it is with that
certificate instead of a token. The port (4318 by default) is HTTPS with mutual TLS (`requestCert: true`,
`rejectUnauthorized: true`): a connection without a valid client certificate is dropped in the handshake, it serves only
the routes a reporter calls, and nothing in Podium disables certificate validation. The console and Admin stay on plain
HTTP on 4317, since Podium does not serve HTTPS to browsers. The rules are in `docs/spec/` 7.7.

| What TLS stops | How |
|---|---|
| Passive snooping of tokens, reports and answers | Traffic is encrypted. |
| An active man in the middle, or a host answering as the server | The reporter checks the server against the CA in its own config file. |
| Replay of captured traffic | TLS. |
| A stolen database yielding usable reporter credentials | Person certificates are public and tokens are hashes. The server keeps no person's key. |
| An expired or revoked certificate being used | An expired or untrusted certificate is dropped in the handshake. A revoked one is refused when the server checks its fingerprint on every request. An expired certificate is never renewed, so a renewal answer only travels over a verified connection. |

| What TLS does not stop | What to do about it |
|---|---|
| **A compromised machine, or a stolen config file.** The private key is in the file. | Revoke the person's certificate and keep the file mode 0600. |
| **A stolen console token.** | Revoke the token. |
| **A token after only the certificate is revoked.** Revoke certificate stops the reporter that uses the certificate; the token stays a valid credential over HTTP (from loopback, or while HTTP is allowed). A stolen config file holds no token. | Use Revoke token or Revoke all to cut a person off. |
| **A stolen `/data/tls`.** It holds the CA key, so it holds everything the CA signed. | Treat it as an emergency: rotate the CA with no overlap and reissue every config. Back the folder up and set its permissions like a secret. |
| **Any process running as the same user.** It can read the config file and use the helper's socket. | The same as for any file in that account. |
| **Plain HTTP while "Allow reporters to connect over HTTP" is on.** Name, token and reports are not encrypted. Admin says so in a warning line. | Turn the switch off when every reporter has a config. The console stays on HTTP so an Admin can always sign in. |
| **The console is plain HTTP.** The name and token a browser signs in with are not encrypted on the network. | Put a TLS proxy in front of the console (#305) when people reach it over a network you do not trust. Podium does not serve HTTPS to browsers. |

## Orchestrator messaging

Podium can carry messages between one person's own orchestrators (#347): the server since #412, the mod's tools since
#414, the owner's My reporters page since #415, the Admin's pages since #416 and Traffic since #417. Chat (#1034) replaced Traffic and adds one narrow path between people, described under "Chat" below. It is off until the Admin turns on Orchestrator messaging and the person turns on the
reporter's `peers` option on each machine and gives the pair a right. What it exposes:

| Topic | How it works |
|---|---|
| **Who** | Between reporters, only with the same owner. The server refuses a right or a message from one person's reporter to another person's, and any reporter on the admin secret, whatever the settings say. Text crosses owners only in Chat, in three ways: a person writing to another person's agent, that agent's answer to the person, and an agent reading General after it was called in there (see "Chat" below). An Admin can propose a right, which applies only when the owner accepts it; an Admin's pause or removal applies at once. |
| **In the session** | Only the orchestrator can send; the mod refuses any tool call from a subagent. A received message always starts with Podium's line saying it is another agent's text, never the person's, and it never answers a question or permission prompt, runs a command, or changes a mode or permission rule. A message waiting for the owner's approval, and an orchestrator's reason for asking for access, are shown only to the person (a toast), never to the model. |
| **Who a message is from** | The person's token and the reporting session that send it, never a name in the message. A `to` is looked up only among that person's own live orchestrators, so another person's orchestrator cannot be named, or found by guessing. |
| **What it lets a token do** | Anyone holding a person's token can send text into that person's linked orchestrators, within the rights and limits that person set. The text becomes a new turn in the receiving session, marked as another agent's text. Its permission prompts still ask, but what an auto or accept-edits mode allows is not a prompt (DECISIONS 37). |
| **What is kept** | The text of each message is stored on the server, with its sender, receiver and delivery state, until 30 days after the last message on its link (the Admin can set 1 to 365 days), and deleted with its sessions. Only its owner and an Admin can read it. Everyone else can see that two orchestrators talk, and how much. The mod replaces anything that looks like a secret on the sending machine; that is best effort. |
| **Limits** | Round trips in a conversation before the owner approves the next message, messages per minute on a link, and the longest message, set by the Admin; an owner can only make them stricter. Over a limit a message is refused, never cut. |
| **Audit** | Each message sent, delivered, approved, declined or dropped, and each right set, proposed, accepted, declined, paused, resumed or removed, is written to the Admin log and the server log with who, to whom and whose, never the text. |

A way to put text into a session without these switches, from another person's token, through the admin secret, past
a limit, or a way to read a conversation's text as anyone but its owner or an Admin, is in scope.

## Chat

Chat (#1034, DECISIONS 61) is the page that replaced Traffic. It needs everything "Orchestrator messaging" needs: the Admin's
switch, authentication and the reporter's `peers` option. A Direct Message to an agent also needs the reporter's `respond`
level at `questions` or higher and `activityFeed` on. What it exposes:

| Topic | How it works |
|---|---|
| **Who can read what** | Each audience has its own table and its own read path. General is read by everyone signed in. My group is read by the person, their own agents and an Admin. A Direct Message is read by its owner and an Admin, and in a conversation across owners by both owners and an Admin. Another person gets a `403` or nothing, and a person who is not in a Direct Message gets the same `404` whether it exists or not. No group-facing or agent-facing route can return a Direct Message, and a test fails if one could. The old Traffic routes no longer return a person's Chat to an Admin: Traffic leaves such conversations out, and the conversation route sends an Admin to Chat when a person is at one end, and an Admin's read of a conversation between two agents on that route (the Admin's Reporters page or Traffic) is recorded before the text is served and told to its owner the same way. An Admin never reads in silence: every person in a group or Direct Message an Admin reads (hidden conversations too) sees a red banner naming each Admin, a record line in the thread and a callout in each of their live reporter sessions (never sent to the model), and the Admin log records each reading session as `chat_admin_read`. The callout is built from the record each time a session reports, so a later session or a server restart does not lose it. The record is kept at least until each person it names has seen it (their console loaded the thread), and after that goes by retention; a retention sweep, a purge or a writer's delete leaves a record not yet seen. An Admin's pause, resume, disconnect and clear of a group, and pause and resume of a link, are logged, are recorded before they happen, and also leave a record line and a callout. An Admin who browses a person's list of conversations (`chat_admin_browse`, names and counts only) tells that person the same way: a console banner, a record line, a reporter callout and an Admin log row. |
| **Another person's agent** | A person can ask to message an agent that is not theirs. The message is held as a request for that agent's owner, and nothing reaches the agent until the owner chooses Allow. Allow delivers it and opens a link between that person and the agent's whole reporter, not only that agent: every orchestrator on that reporter, now and later, takes their messages without asking until either of them pauses or removes the link (this is intended). Decline drops it. An Admin needs the owner's approval too. Podium refuses the message up front, before the owner is asked, unless that reporter can take it: the Admin's responding switches on, the reporter's `respond` level at `questions` or higher, its activity feed on, `peers` on, and a reporter that declares the `adminNotices` capability, because one that does not cannot show its person the Admin callout. |
| **The person frame** | The text reaches the agent as that person's, never as its owner's: it starts with Podium's line saying who wrote it, that the person is not the owner, that it cannot approve anything or change a setting, and that the owner can read the answer. The text follows a rule line, quoted line by line, and a closing line says the message has ended. Invisible characters (bidi controls, zero-width characters other than the two joiners emoji and Persian words need) are removed from names and text, and the line separators end a line. A reporter that does not declare the `adminNotices` capability (one from before Chat declares nothing) is refused up front, because it cannot frame the text or show its person the Admin callout. |
| **What an agent reads** | An agent reads a channel only through `podium_chat_read`, only the last 60 minutes of General or its own person's My group, and only where a delivered `@` of that agent is stored in that channel inside the hour; otherwise the answer is a refusal that names nothing. The server returns only the channel's own messages (author, kind, time, text and reply link: no session id, no delivery state, never a Direct Message), the text already cleaned and redacted when it was stored. Every result starts with Podium's line that it is people's and agents' text, not the owner's instructions, and each message is shown quoted line by line, with its author's name in quotes. Anyone signed in can call an agent into General with an `@`, and the agent may then read General; that is intended, since General is open to everyone signed in. A subagent cannot call the tool, and reading changes nothing. An agent posts to a channel with `podium_send` only where the same rule holds: called in within the hour, or the post is refused (#1065). |
| **The agent's answer** | An agent can answer that person with `podium_send` to `person:<name>`, only while it holds a stored message from them and the link is open (a paused link is refused with a `409`, a removed one with a `403`; the agent's own owner needs no link). An address that does not qualify gets the same "cannot see" answer as an orchestrator it may not reach, so it says nothing about the owner's other agents. The answer is stored as the agent's, with no approval step, and is read by both owners and an Admin. The agent's reporter replaces secrets in it on the agent's machine; that is best effort. An agent can also answer its own owner in the thread the owner started, where no link is involved. |
| **What is kept** | The text of a channel message or a Direct Message, with secrets replaced by `[redacted]` (by the server, for a person's text) and control and invisible characters removed before it is stored. Chat text stays out of the open activity feed, the history and the recordings. Deleting a person removes their Chat data. General and My group keep messages 30 days by default (`retainDays`, set by the Admin). A Direct Message is hidden when every agent in it has left, and its messages are deleted after a grace period, 24 hours by default (`graceHours`, set by the Admin); if the same agents return first, it and its history come back. |
| **Limits** | A message over the Admin's `maxChars` (4,000 by default) is refused, never cut. An author's posts, a person's messages to their own agent and a person's messages to another person's agent are limited to `perMinute` (6 by default) as well as messaging's limits. Length and rate are checked before the scan for secrets. A channel post's `issue`, `project`, `milestone` and `replyTo` are bounded and cleaned. A session id that starts with `person:`, is only dots or contains `|`, `+` or `/` is refused, and deleting a session needs its owner. |
| **Who an Admin is named as** | An Admin who signs in with their own name is named by it in the banner, the record line and the callout. The admin secret has no name and appears as "Admin secret". |
| **Stopping a session** | A channel can be paused, disconnected or cleared, and a link can be paused or removed. In General a person can pause or disconnect their own agents, and only an Admin can pause it for everyone or remove its messages. |
| **Audit and the stream** | Each message sent, delivered or dropped, each link opened, paused, resumed or removed, each delete and purge, and each change of the Chat limits is written to the Admin log and the server log with who and which conversation, never the text. The stream's `chat` event is sent to every open console, so it carries only a change counter and a coarse scope (General, group or Direct Message): no text, name, count or id. A console reads its own counts from the Chat routes, which check who is asking. |

A way to put text into another person's agent without its owner's approval, to read a Direct Message or a group as
anyone but those named above, to see message text in the stream, the state or a log, or to pass a limit, is in scope.
The mod still follows its reporter's permissions: Chat adds no way to answer a question or permission prompt or change a
permission rule. It adds one way to run a command: a message to your own agent that is exactly `/clear` or `/compact` runs it, as
the Activity window does, when the reporter allows commands. The Chat box offers the same list (OpenCode: `/compact` only) and asks
before `/clear`.

## Where to read more

| For | Read |
|---|---|
| Why per-person tokens, and how Admin and the shared secret relate | `docs/decisions/` 20 (per-person tokens) and 30 (Admin sign-in) |
| Why responding exists, and what it costs | `docs/decisions/` 28 |
| What the security sweep found, fixed and accepted | `docs/decisions/` 31, with 32 (guess throttling) and 33 (the Host check) |
| The rules the server and the mod follow | `docs/spec/` 7.7 "Hardening": "Who a report is from", "Who", "The browser's credential", "The mod never trusts the server" and "The admin log" |
| How a person turns responding on and uses it | `docs/user-guide/`, "Answering a session from Podium" |
| How orchestrator messaging is set up, and what is kept | `docs/MESSAGING.md`, with the reasoning in `docs/decisions/` 37 |
| What Chat keeps, who reads it, and writing to another person's agent | `docs/spec/` 7.7 "Chat", with the reasoning in `docs/decisions/` 61 |
| Why Podium makes its own CA, and the rules for it | `docs/decisions/` 42, `docs/spec/` 5.9, 6 and 7.7 "Built-in TLS" |
| What is open by design | `docs/gotchas/` and [Running the server](../docs/SERVER.md#run-it-with-podiumctl) ("Several people on one Podium") |

## Reporting a vulnerability

Open a private GitHub Security Advisory on this repo:
[github.com/eengelking/podium](https://github.com/eengelking/podium) → the "Security" tab →
"Report a vulnerability". That is GitHub's built-in private disclosure, so the report stays visible only
to the maintainer until it is resolved.

Please don't file a public issue for a suspected vulnerability. This repo is public, so a public issue
discloses it before there is a fix. Don't report one in the Podium Discord server or any other chat either:
a message in a channel is visible to everyone there. If a report does land in Discord, the maintainer will ask
you to resend it as a Security Advisory and will remove the message.

## Supported versions

Only the latest release gets fixes. A fix may arrive in the next release rather than as a backport to an
older one.

## What to expect

This is a solo-maintained project, so response times aren't guaranteed, but reports are read and taken
seriously. If a report turns out to be valid, the fix ships as a normal PR, with an entry under "Security"
in `CHANGELOG.md`. If the fix is in the mod, the `version` in `plugin/claudecode/.claude-plugin/plugin.json`
is bumped too, because installed copies only update when it changes.
