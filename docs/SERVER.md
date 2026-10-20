# Running the server

This page is for whoever runs the Podium server: how to start it and keep it running, who can reach it, and
the settings that change how it behaves. To set Podium up for the first time, start with the
[user guide](USER_GUIDE.md#set-it-up). The mod that sends the data is in [REPORTER.md](REPORTER.md).

Contents:

- [Run it with podiumctl](#run-it-with-podiumctl)
  - [Auth token](#auth-token)
  - [Admin and per-person tokens](#admin-and-per-person-tokens)
  - [Several people on one Podium](#several-people-on-one-podium)
  - [Orchestrator messaging](#orchestrator-messaging)
  - [The release check](#the-release-check)
  - [A page on another site](#a-page-on-another-site)
  - [Behind a reverse proxy](#behind-a-reverse-proxy)
  - [More settings](#more-settings)
  - [Start on boot](#start-on-boot)
- [Server settings](#server-settings)
- [What it costs to run](#what-it-costs-to-run)

## Run it with podiumctl

`bin/podiumctl` starts, stops and watches the server without a dev setup. It has no dependencies of its own
and runs Podium in one of two modes:

- **Podman container.** The default when Podman is installed.
- **Standalone.** A plain Node process on the host.

Install it on your PATH from the repo with `npm link`, or run `bin/podiumctl <command>` (no `node` in
front) or `npm run podiumctl --`.

```sh
git clone https://github.com/eengelking/podium.git && cd podium && npm link
podiumctl start                     # builds the image on first use, then runs it on http://127.0.0.1:4317
podiumctl status                    # mode, state, health, URL, boot setting (exit 3 when stopped)
podiumctl logs -f                   # follow the log
podiumctl restart                   # after changing the config
podiumctl stop
podiumctl enable                    # start on boot / login (launchd on macOS, systemd user unit on Linux)
podiumctl disable
podiumctl start --mode standalone   # no container: needs `podiumctl build --mode standalone` once
podiumctl rm --purge --yes          # remove the container, its data volume and the image
```

`--mode`, `--port` and `--bind` are saved, so later commands reuse them. Where the data lives:

- Container mode keeps the database in the Podman volume `podium-data`.
- Standalone mode keeps it in `~/.podium/data/`.

By default, container mode publishes the port on `127.0.0.1` only. `--bind` sets the address it publishes on.

### Auth token

The first `start` generates a random token and saves it as `PODIUM_TOKEN` in `~/.podium/config.env`
(mode 0600).

- `podiumctl token` shows it at any time. `podiumctl token --rotate` makes a new one.
- This is the **admin secret**. It opens the Admin section (below). On a one-person setup you can also enter
  it in the mod's `token` option (see [REPORTER.md](REPORTER.md)) and in the `X-Podium-Token` header of the
  settings hooks ([REPORTER.md](REPORTER.md#sessions-without-the-mod)).
- To run without auth, `podiumctl config set PODIUM_TOKEN=` (empty on purpose). Admin is switched off then,
  because nothing would protect it.

### Admin and per-person tokens

When several people report to one Podium, open **Admin** (`#/admin`, or the button in the top bar's upper
right once you are signed in to the console as an Administrator) and sign in with the name `Admin` and the
admin secret. Admin creates a token for each person, shown once. A token only works with the name it was made
for, so a leaked token alone cannot claim someone else's name.

Reporting with the admin secret keeps working, and those sessions show under the owner **Admin**. Tokens are
stored hashed, so Podium cannot show one again. They travel in a header, so a server reachable over a network
needs a trusted network or a TLS proxy.

Admin locks after 10 idle minutes, and five wrong names or tokens lock it for 15 minutes. Admin's pages (people,
groups, reporters, settings, model prices, the admin log) are in the "Admin" section of
[USER_GUIDE.md](USER_GUIDE.md).

### Several people on one Podium

The server listens on `127.0.0.1` by default, so only your own machine can reach it. To let other people
report to it:

1. Restart it on an address the others can reach: `podiumctl restart --bind 0.0.0.0` (all interfaces), or
   the one interface they use. The container then publishes the port on that address too.
2. Allow the port (4317 by default) in the firewall for the people who need it and no one else.
3. The server refuses a request whose `Host` is a name it does not expect (see
   [A page on another site](#a-page-on-another-site)). With `0.0.0.0` an address typed in the bar
   (`http://192.168.1.5:4317`) works as is. To reach it by a name, list the name, then restart:

   ```sh
   podiumctl config set PODIUM_ALLOWED_HOSTS=box.lan
   podiumctl restart
   ```

4. Make each person a token in Admin. They set `serverUrl` to `http://<your host>:4317`, `token` to their
   token and `userName` to the name you gave them (see [REPORTER.md](REPORTER.md)).
5. Once a session reports with a person's token, the console groups the wall by person (see "People" in
   [USER_GUIDE.md](USER_GUIDE.md)).

**What this exposes.** Reading the console needs no token, so anyone who can reach the port sees every session:
names, machines, paths, branches, plan steps, commands from failed calls and the excerpts listed under
[What leaves the session](REPORTER.md#what-leaves-the-session).

- Tokens and reports cross the network in plain HTTP, so use a network you trust or put a TLS proxy in front.
- Anyone with a valid token can delete any session.
- The name shown on a session comes from the token that sent it. With the shared admin secret every session
  shows as Admin, and with the server's auth turned off every session is Unassigned, because then anyone
  could claim any name.
- Per-person read permissions are not part of Podium.

### Orchestrator messaging

One person's orchestrators can find and message each other through the server, between that person's own
reporters only. It is off until an Admin turns on **Orchestrator messaging** (`peer-messaging`) in Admin >
Settings > Feature flags; each change is written to the Admin log as `feature_changed`. It also needs the
server's auth on, a person's token on each reporter (never the admin secret), and the reporter's `peers` option
on each machine. The rules are in [SPEC.md](SPEC.md#orchestrator-messaging-347).

- While the flag is on, Admin > Settings has an **Orchestrator messaging** section with four limits for every link
  on the server: round trips before a person approves (10), messages per minute on a link (6), the longest message
  (20,000 characters) and how many days a conversation is kept (30). A person can make the first three stricter on
  their own links, never looser. Each change is written to the Admin log as `peer_limits_changed`.
- Admin > Reporters > a reporter has a **Messaging** section, where an Admin proposes rights for the owner to accept
  and pauses every link of that reporter at once.
- Turning the flag off keeps the rights and limits and drops every message still waiting.

[MESSAGING.md](MESSAGING.md) walks through the whole setup, with the ranges in [Limits](MESSAGING.md#limits); the
Admin's screens are under "Admin" in [USER_GUIDE.md](USER_GUIDE.md#settings).

### The release check

Once a day the server asks `api.github.com` for the latest Podium release, and the wall shows a notice when it is newer
than the version running ([SPEC.md](SPEC.md#the-release-check-499-mockuppodium-update-noticehtml-mockuppodium-update-check-adminhtml)).
It is one HTTPS request with no body and nothing about your install in it. It is on by default. For a server that must
not make outbound calls, turn **Release check** off in Admin > Settings > Feature flags and the server makes no request.
A firewall that blocks the request needs no change: the check fails quietly and shows nothing.

### A page on another site

A web page can point its own name at `127.0.0.1` after it has loaded (DNS rebinding) and then read the
console's open routes as if they were its own. So the server answers `403` to any request whose `Host` is
not one of these:

- `127.0.0.1`, `localhost` or `[::1]`
- the `--bind` address
- a name in `PODIUM_ALLOWED_HOSTS` (comma-separated; the port is not compared)

A server bound to `0.0.0.0` or `::` also takes any IP address, which a page cannot rebind. The refusal is
logged as `http.host_refused` with the host and nothing else. The reasoning is in
[DECISIONS.md](DECISIONS.md#33-refusing-a-host-the-server-does-not-expect-256).

### Behind a reverse proxy

Behind a TLS proxy every request seems to come from the proxy: the Admin log shows its address, five wrong
tries by one person lock everyone out, and the session cookies are not marked `Secure`. Tell the server which
hops to believe:

```bash
podiumctl config set PODIUM_TRUST_PROXY=10.0.0.5   # the proxy's address, a range (172.16.0.0/12) or a hop count (1)
podiumctl restart
```

- It takes a hop count, or addresses and ranges separated by commas, and the names `loopback`, `linklocal` and
  `uniquelocal`. It is off by default. `true` is refused, and a value that does not parse stops the server at start.
- Then `X-Forwarded-For` and `X-Forwarded-Proto` are read only from those hops, so a client cannot choose its
  address or scheme from anywhere else.
- **Warning:** name only a proxy that overwrites `X-Forwarded-For`. A hop that passes a client's header through
  lets that client choose its source, which defeats the lockouts. A very wide range (`0.0.0.0/0`) or a hop count
  larger than your proxy chain has the same effect; the server accepts them, so choose the value with care.
- In container mode the proxy reaches Podium through the published port, so its address inside the container may
  be the network's gateway rather than the proxy's own; check the `source` in Admin's log after turning it on.

### More settings

Other settings (`STALE_AFTER_MS`, `RETAIN_*`, the `PODIUM_LOG_*` logging settings, and so on, see
[Server settings](#server-settings)) are set with `podiumctl config set KEY=VALUE` and applied on
`restart`.

- "Logs" in the [user guide](USER_GUIDE.md#logs) covers what the server logs, sending it to VictoriaLogs, and
  pointing an agent at it.
- Set `PODIUMCTL_HOME` to keep `podiumctl`'s files somewhere other than `~/.podium`.
- `podiumctl --help` lists everything.

### Start on boot

`podiumctl enable` sets this up. In container mode the boot service runs `podiumctl start`, which also
starts the Podman machine on macOS. In standalone mode it runs the server in the foreground and restarts it
if it crashes.

On Linux, `loginctl enable-linger $USER` makes the user unit start before you log in. (The Linux unit has
run on Bazzite, and standalone mode has been through a reboot with and without linger; container mode has not been
rebooted.)

## Server settings

These are environment variables (see `.env.example`). Under `podiumctl` you set them with
`podiumctl config set`, and it chooses `PORT`, `HOST` and `PODIUM_DB` itself.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4317` | Server port (the Vite proxy follows it) |
| `HOST` | `127.0.0.1` | Bind address. Podium is for one machine; leave it on localhost |
| `PODIUM_DB` | `data/podium.sqlite` | SQLite database file (`podiumctl` uses `/data/podium.sqlite` in the container and `~/.podium/data/podium.sqlite` standalone) |
| `PODIUM_HOST_HOME` | the server's own home | Home directory to show as `~` in session paths. `podiumctl` sets it to your home in the container, where the server's own home is `/home/node`. Ignored unless it is an absolute path |
| `PODIUM_TOKEN` | empty | The admin secret. When set, `POST /api/fleet/report`, `POST /api/fleet/hook` and `DELETE` require `X-Podium-Token` (this or a person's token), and it opens Admin |
| `PODIUM_ALLOWED_HOSTS` | empty | Extra `Host` names the server accepts, comma-separated (see [A page on another site](#a-page-on-another-site)) |
| `PODIUM_TRUST_PROXY` | off | The reverse-proxy hops whose `X-Forwarded-For` and `X-Forwarded-Proto` the server believes (see [Behind a reverse proxy](#behind-a-reverse-proxy)) |
| `TZ` | the server's own zone | Timezone whose midnight starts "today" for "Est. cost today". `podiumctl` gives the container your host's zone; set it with `podiumctl config set TZ=Europe/Berlin` to override |
| `STALE_AFTER_MS` | `15000` | A session not heard from this long shows as stale |
| `HOOK_STALE_AFTER_MS` | `600000` | Same as `STALE_AFTER_MS`, for sessions known only from settings hooks (they send no heartbeat) |
| `DROP_AFTER_MS` | `60000` | A stale session leaves the fleet after this much more |
| `LINGER_MS` | `8000` | An ended session stays on screen this long |
| `DETACHED_HIDE_AFTER_MS` | `60000` | A session nobody is attached to (a background job left running after `/exit`) shows dimmed this long, then is set aside behind a "background sessions hidden" line |
| `RETAIN_SAMPLES_MS` | 24 hours | Per-second chart samples kept |
| `RETAIN_EVENTS_MS` | 30 days | Activity events kept |
| `RETAIN_SESSIONS_MS` | 30 days | Ended sessions kept |
| `RETAIN_ADMIN_LOG_MS` | 90 days | Admin log entries kept; the newest 100 are always kept |
| `RETAIN_ROLLUP_MS` | 395 days | Daily reporting summaries kept (Admin > Reporting). They hold counts, tokens, cost and names, never session content |
| `PODIUM_LOG_LEVEL` | `info` | Lowest log level printed and shipped: `debug`, `info`, `warn` or `error`. `debug` adds one line per HTTP request, and in the text format the session, reporter, sweep and Admin lines |
| `PODIUM_LOG_FORMAT` | `text` | `text` prints each line's message, as before; `json` prints one JSON object per line |
| `PODIUM_LOG_SHIP_URL` | empty | Also push every log line to this endpoint, such as a VictoriaLogs server (`http://HOST:9428`; `/insert/jsonline` is added). Empty means nothing leaves the machine |
| `PODIUM_LOG_SHIP_HEADERS` | empty | Headers for that endpoint, `Name=Value;Name2=Value2` (for example `Authorization=Bearer ...;AccountID=1`). Never printed or logged |
| `PODIUM_LOG_SHIP_BUFFER` | `2000` | Log lines kept while the endpoint is down; past that the oldest are dropped |

Sessions, agents and events are stored in SQLite (Node's built-in `node:sqlite`), so a server restart loses
nothing that was reported. Sessions come back as stale and recover when their reporters send again.

## What it costs to run

The more sessions and agents report, the more Podium needs. Every agent adds data that the server stores and
sends to the browser, and the browser draws it, so the work grows with the amount of data consumed.

- **Server CPU and memory** grow with ingest, the SQLite writes and the state sent to every open client. This
  load is there whether or not a browser is open.
- **Browser CPU, memory and GPU** grow with the rows, charts, animations and updates to draw. This load is
  per open tab.

As one example, Chrome on an M5 MacBook Pro used about 24% GPU with ten simulated sessions and a hundred
agents on screen, against about 15% for a plain page (#81). That is one machine and one browser, not a
promise. To measure your own, open a tab and run `scripts/gpu-sample.sh` (macOS; `--help` lists its options).

To lower it:

- Keep fewer sessions on screen.
- Leave the tab hidden (animations pause while it is).
- Use wall mode (`w`), which hides the side panes and top bar so the browser stops drawing them.
- Close the dashboard when nobody is looking.
