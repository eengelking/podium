---
title: "Remove it"
description: "Remove Podium, its data and the mod from your machine."
group: "Getting started"
order: 11
---

# Remove it

To take Podium off your machine, run these commands, then remove the mod.

```sh
podiumctl disable                 # if you enabled start on boot
podiumctl rm --purge --yes        # removes the container, its data volume and the image
```

Then remove the mod with `claude plugin uninstall podium-reporter@eengelking-marketplace`, and delete `~/.podium` if you
want the saved config and token gone too.

<!-- nav:start -->
---

Previous: [What leaves a session](10-what-leaves-a-session.md) · Up: [User guide](README.md)
<!-- nav:end -->
