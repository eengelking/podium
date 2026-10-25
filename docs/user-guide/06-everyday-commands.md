---
title: "Everyday commands"
description: "Look up the podiumctl commands you use day to day and what each one does."
group: "Getting started"
order: 6
---

# Everyday commands

These are the `podiumctl` commands you will use most, for anyone who runs the server.

| Command | What it does |
|---|---|
| `podiumctl status` | Mode, state, health, URL, whether it starts on boot (exit 3 if stopped) |
| `podiumctl logs -f` | Follow the server log |
| `podiumctl restart` | Apply a config change |
| `podiumctl stop` | Stop it; your data is kept |
| `podiumctl token` | Print the admin secret (`--rotate` makes a new one and ends every open Admin session after a restart; people's own tokens keep working) |
| `podiumctl config` | Show the saved settings (`config set KEY=VALUE ...` changes one or more, `config unset KEY ...` removes them; quote a value that has spaces) |
| `podiumctl enable` / `disable` | Start on boot or not |

`podiumctl --help` lists the rest.

<!-- nav:start -->
---

Previous: [Admin](05-admin/README.md) · Up: [User guide](README.md) · Next: [Logs](07-logs.md)
<!-- nav:end -->
