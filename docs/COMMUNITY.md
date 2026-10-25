---
title: "Community"
description: "How to join the Podium Discord server, and how the maintainer sets the server up and keeps it safe."
group: Project internals
---

# Community

Podium has a Discord server for questions, show-and-tell and release news. This page says how to join it and how
the maintainer sets the server up and keeps it safe.

Contents:

- [Joining the Discord](#joining-the-discord)
- [Setting up the server](#setting-up-the-server)
  - [The invite link](#the-invite-link)
  - [Renewing the link](#renewing-the-link)
  - [Secure configuration](#secure-configuration)
  - [If the invite is abused](#if-the-invite-is-abused)
  - [Checking that it works](#checking-that-it-works)

## Joining the Discord

Join with the [invite link](https://discord.gg/JQhPDdEBk). It opens `welcome-and-rules`, where the server's rules are.

- **A short wait.** New members accept the rules and are then approved by hand, so you may not be able to post for a
  little while after you join.
- **The Code of conduct applies.** It covers the Discord server as much as the repo:
  [Code of conduct](../.github/CODE_OF_CONDUCT.md).
- **Bugs and feature requests** belong in [GitHub Issues](https://github.com/eengelking/podium/issues), where they
  are tracked. Discord is for talking about Podium, not for filing work.
- **A security problem never goes in Discord.** Report it privately as a GitHub Security Advisory, as
  [SECURITY.md](../.github/SECURITY.md#reporting-a-vulnerability) describes. A message in a public channel
  discloses it before there is a fix.

## Setting up the server

This part is for the maintainer. It names settings and says why each one matters. It holds no token, webhook URL,
server id or channel id, and none should ever be added here: this repo is public.

Discord renames things now and then. If a label on screen differs from the one below, follow the screen and correct
this page in the same PR.

### The invite link

The README and this page link one invite. An invite that expires leaves both pointing at nothing, so the aim is one
that never expires. Discord does not offer **Never** to a small server like this one yet, so for now the link does
expire and has to be renewed (see below).

1. Open Server Settings > Invites, or the **Invite People** dialog on a channel, and edit the invite link's settings.
2. **Expire After:** Never when Discord offers it, otherwise the longest option it does.
3. **Max Number of Uses:** No limit. A cap makes the link fail for the next person without any warning.
4. **Grant Temporary Membership:** off. A temporary member is removed when they go offline unless they are given a
   role, so someone who joins from the README would vanish.
5. **Channel:** `welcome-and-rules`, not a busy one. A new member sees the rules first.
6. Put the link in the [README](../README.md#community) and in the first line of "Joining the Discord" above.

What can still go wrong:

- An invite can be deleted. Server Settings > Invites lists every invite, and a deleted code cannot be created again.
- Discord can revoke an invite it judges abusive, and a server has a limit on how many members it can hold.
- A vanity URL such as `discord.gg/podium` needs the server to be boosted to a high boost level. This server is not
  there, so the link is a `discord.gg/<code>` one. Look under Server Settings > Overview to see whether it has become
  eligible, and if it has, claim the name and update the README.

### Renewing the link

The link now in the README expires on **2026-11-18**. Anyone can read an invite's expiry from Discord's public invite
lookup. Replace `<code>` with the part of the link after `discord.gg/`:

```sh
curl -s 'https://discord.com/api/v10/invites/<code>?with_expiration=true'
```

Read `expires_at` in the reply. `null` means it never expires, and a dead invite answers with an error message instead.

About a week before the date:

1. Create a new invite with the settings above.
2. Open it in a private window and check that it lands in `welcome-and-rules`.
3. Put it in the README and in "Joining the Discord" above, and update the expiry date in this section, in one PR.
4. `main` is what people read on GitHub, and it only moves with a release, so ship the change as a patch release.
5. Delete the old invite once the release is out.

When Discord offers **Never**, make that invite, replace the link once more, and replace this section with a line
saying the link does not expire.

### Secure configuration

Settings are under Server Settings unless it says otherwise.

| Setting | Where | Set it to | Why |
|---|---|---|---|
| Two-factor authentication on your own account | Your user settings > My Account | On | The server-wide 2FA requirement below needs it on first, and the owner account is the one that can lose the server. |
| Require 2FA for moderation | Safety Setup | On (only the owner can switch it) | A moderator or admin must have 2FA to take administrative actions, such as deleting messages. A stolen moderator login is then not enough to wreck the server. |
| Verification level | Safety Setup | Medium: a verified email and an account older than 5 minutes | It slows throwaway accounts and raids. Community requires at least Low. |
| Explicit image filter | Safety Setup | All members | Scans images from everyone, not only members without a role. Age-restricted channels are exempt. |
| Community, the rules screen and approval | Community, and the rules screen under Onboarding or Safety Setup | Community on, rules screen on, new members approved by hand | A member reads and accepts the rules before they can talk, and a person lets them in. `welcome-and-rules` holds the rules and links the Code of conduct. |
| `@everyone` permissions | Roles > @everyone, and the permissions of `welcome-and-rules` | Off for: mention @everyone, @here and all roles; create invites; manage webhooks; embed links; attach files (in the welcome channel at least) | Everyone is in this role, so anything it allows, a stranger can do. |
| A moderator role | Roles | Manage Messages, Timeout Members, Kick Members, Ban Members, View Audit Log, and nothing else | Least privilege. A moderator needs to remove a message or a member, not to change the server. |
| Administrator | Roles | No bot, and as few people as possible | Administrator ignores every other permission, so it is the one to give out last. |
| AutoMod | AutoMod | Spam, mention spam (a limit near 5 mentions) and a keyword rule for known bad links, each set to block the message and send an alert | It catches what a person would miss at 3 a.m. It needs Community, which is on. |
| A moderators-only log channel | Channels | A private channel that AutoMod alerts go to, readable by moderators only | A record of what AutoMod blocked, and of who did what, that members cannot read or edit. |
| Bots | Integrations | Add one only if it comes from a source you trust, give each the fewest permissions it needs, and review the list on a schedule (each month) | A bot acts with its permissions on every channel it can see, so a bad or hijacked one is a way in. |
| Tokens and webhook URLs | Developer Portal and Integrations | Never paste one in chat, in an issue or in this repo | Anyone who has one can act as the bot or post to the channel. If one leaks, reset the token or delete the webhook and make a new one. |
| Direct messages from members | Your Privacy Settings for the server, and the rules text | Off for yourself, and tell members in `welcome-and-rules` how to turn them off | Scam messages to new members arrive as direct messages from people who share a server with them. |

Who handles reports, and what happens to someone who breaks the Code of conduct:

- Members report to the maintainer by direct message, or through the routes in the
  [Code of conduct](../.github/CODE_OF_CONDUCT.md#enforcement).
- The maintainer follows the Code of conduct's enforcement guidelines: from a private correction up to a
  permanent ban. Use a timeout to stop a heated moment, and write down what happened and what was done.
- A security report that arrives in Discord is moved to a GitHub Security Advisory, and the message is removed.

### If the invite is abused

1. **Pause invites.** Server Settings > Invites has a switch that stops new joins while you sort it out (Discord calls
   it Invites Paused or Pause Invites).
2. **Delete the invite** from Server Settings > Invites.
3. **Create a new permanent invite** with the settings above.
4. **Update the README and this page** in one PR, so the link is never wrong in one of them.
5. **Rotate anything that leaked:** reset bot tokens, delete and recreate webhooks, check the audit log and remove any
   bot or member you do not know.
6. **Look at who joined** while the invite was abused, and kick or ban the ones that should not be there.

### Checking that it works

Open the invite in a private window and join with a test account.

- You see the rules screen, then wait for approval, then land in `welcome-and-rules`.
- The test account cannot mention everyone, create an invite, post an embed or attach a file there.
- The link still works after a day and does not hit a use limit.

If a step does not match what Discord shows, correct this page.
