---
title: "Updating the mod"
description: "Update the mod when a card says its reporter is out of date, and know what each message means."
group: "Getting started"
order: 9
---

# Updating the mod

The mod and the server are released separately, so you update them separately. A card marked `reporter 0.1.0 · update`
means the mod in that session is older than the server supports. For what each message means, see
[Gotchas](../gotchas/status-line-update-mod-or-upgrade-server.md).

To update it:

1. Refresh the marketplace listing and update the mod in one line, in a shell:

   ```bash
   claude plugin marketplace update eengelking-marketplace && claude plugin update podium-reporter@eengelking-marketplace
   ```

   The update prints `Checking for updates...` and then the new version, or says it is already at the latest version.
   Inside a session you can use `/plugin`, open the Installed tab, pick `podium-reporter` and choose Update now.
2. Apply it. A running session keeps the version it loaded, so run `/reload-plugins` in it, or start a new session.
   Sessions you do not reload keep reporting the old version and stay marked.
3. Run `/podium`. The `Versions:` line shows the mod's version, and the `· update mod` or `· update available` ending on
   the status line goes away after the next report.

If the command says it is already at the latest version but the card is still marked, the marketplace has not published
a newer mod yet. Refreshing the listing alone does not update the installed plugin, which is why the one-liner runs both.

**Auto-update.** Marketplaces other than Anthropic's do not update plugins by themselves. To have Claude Code do it:

1. Open `/plugin` and choose the Marketplaces tab.
2. Pick `eengelking-marketplace` and turn on auto-update.

It updates the plugin on disk some minutes after you send a first message, and the new version loads in your next session.

**The other direction.** A card marked `· upgrade server` means the mod is newer than the server. Upgrade the server with
`podiumctl build` and then `podiumctl restart`. For a plain Node install, pull, run `npm run build`, then restart.

**Which build is this?** The footer at the bottom of the left list and of Admin shows `Podium v1.1.0` for a release.
A build of any other commit, such as one from the `development` branch, adds a row above the version that reads
`Dev: a1b2c3d4`, the commit it was built from, with `-dirty` after it when the tree had local edits. The row comes
from `podiumctl build`, which records the commit, so a server built another way (`npm run build`, or an image built
with plain `podman build` or `docker build`) shows the version alone. The reporter mod does the same when you run it from a checkout of
this repository: its status line reads `podium v1.1.0 | dev: a1b2c3d4 ● 2 live`, and the Reporter cell on a session's
page reads `1.1.0 · Dev: a1b2c3d4`. A mod installed from the marketplace is always a release.

<!-- nav:start -->
---

Previous: [Sessions you started without the mod](08-sessions-you-started-without-the-mod.md) · Up: [User guide](README.md) · Next: [What leaves a session](10-what-leaves-a-session.md)
<!-- nav:end -->
