---
title: "Set it up"
description: "Start the server, install the reporter mod and check that your sessions appear in the console."
group: "Getting started"
order: 2
---

# Set it up

There are two parts: the server (the console) and the reporter mod (inside each Claude Code session).

## 1. Start the server

```sh
git clone https://github.com/eengelking/podium.git && cd podium && npm link
podiumctl start
```

The first start builds the container image, generates an auth token and saves it to `~/.podium/config.env`. The
console is at http://127.0.0.1:4317/#/.

- **Plain Node process instead of a container.** Run `podiumctl build --mode standalone` once, then
  `podiumctl start --mode standalone`.
- **Start when you log in.** Run `podiumctl enable`.

## 2. Install the reporter mod

In Claude Code:

```
/plugin marketplace add eengelking/skills
/plugin install podium-reporter@eengelking-marketplace
```

Then give it the token:

1. Print the token with `podiumctl token`.
2. Enter it with `/plugin configure podium-reporter@eengelking-marketplace`.

If someone else runs the server, ask them for your own token and enter it as `token`, with your name as `userName`
(see [Admin](05-admin/README.md)). To run one server for several people, see "Several people on one Podium" in
[SERVER.md](../SERVER.md#run-it-with-podiumctl). It covers the bind address, the firewall, the names the server accepts
(`PODIUM_ALLOWED_HOSTS`, for reaching it by a name rather than an address) and what everyone who can reach the server
can see. If you put a TLS proxy in front of it, see [Behind a reverse proxy](../SERVER.md#behind-a-reverse-proxy), so that
Admin's log shows each person's address and one person's wrong tries do not lock everyone out.

To report as more than one person from one machine, see [More than one login on one machine](#more-than-one-login-on-one-machine). To report to more than one Podium server (a home one and a work one, say), see [Contexts](../REPORTER.md#contexts-more-than-one-podium-server).

## 3. Check that it works

1. In a session, run `/podium`. You should see `Connection: online`.
2. Send the session a prompt.
3. Look at the browser. A session appears within a couple of seconds of doing its first bit of work, not before.

The status line tells you where you are:

| Status line | Meaning |
|---|---|
| `podium vX.Y.Z ● 0 live` | Connected, but no session has done any work yet. See [Sessions that have not done anything yet](04-reading-the-console/08-sessions-that-have-not-done-anything-yet.md) |
| `podium vX.Y.Z ● 1 live` | Connected, and one card is on the wall |
| `podium vX.Y.Z ○ offline` | Not connected. See [Something is wrong](03-something-is-wrong.md) |

A name you give a session in Claude Code, for example with `/rename`, is its title on the card, the rail and the
orchestrator page, from your next prompt. A session in the Claude desktop app takes the title the app shows for it,
within about half a minute. `/podium name <text>` sets a name too, and wins over both. The card and the
orchestrator page also show the first eight characters of the session id. Click it to copy the whole id. On the orchestrator page it is the **Session** cell of the facts grid.

## More than one login on one machine

Most people can skip this section.

The sign-in you do with `/plugin configure` holds one name and one token for the whole
Claude config on that machine, so every terminal there shares it. Signing in again as someone else in one terminal
changes it for the sessions you start afterwards, and cannot give two terminals different logins. This is a limit of
Claude Code, not of Podium. It gives a reporter one set of settings per config, no place to keep a login for a single
session, and it tells every running session when they change. A later Claude Code release may add one, and Podium will
use it when it does (#230).

To report as two Podium identities from one machine (say Admin in one terminal and yourself in another), the
reporter's settings are not enough, for the reason above. Start each terminal with its own name and token instead:

```bash
PODIUM_USER=Ed PODIUM_TOKEN=<Ed's token> claude
```

When either variable is set, the session uses them and ignores the `userName` and `token` options. A session keeps the
identity it started with, so changing the options later does not turn a running session into someone else. To change
who a session reports as, start a new one.

<!-- nav:start -->
---

Previous: [What you need](01-what-you-need.md) · Up: [User guide](README.md) · Next: [Something is wrong](03-something-is-wrong.md)
<!-- nav:end -->
