---
title: "21. People are shown from the token's owner, grouped in the browser, and machines carry a random id"
description: "People are grouped by the token's owner, not the name a report claims, and machines carry a random id, so a one-person setup looks unchanged."
group: "Project internals"
number: 21
date: "2026-10-12"
status: "accepted"
order: 21
---

# 21. People are shown from the token's owner, grouped in the browser, and machines carry a random id

**Decision.** The people view (#34) groups sessions by `sessions.owner`, which the server sets from the token
(decision 20), not by the `userName` a report carries.

- A named reporter also sends `machine`: the short host name and a random 12-hex id. The mod makes the id
  once and keeps it in `podium-machine-id` in the Claude config directory (#267).
- Bands, ordering and the spend chart are computed in the browser from live sessions. The server adds only
  the machine, each owner's group and today's spend per owner.
- "Me" is picked in the browser and kept in `localStorage`.
- The view stays off until a session belongs to a person, so a one-person setup that reports with the admin
  secret looks as before.

**Why.**

- A name is visible to everyone and can be typed by anyone, so trusting it would let one person appear as
  another. The token already decides identity.
- A host name alone cannot tell two machines with the same name apart, and a hardware or OS identifier says
  more about the machine than Podium needs, so the id is random and local to the mod.
- Deriving people from live sessions keeps the server free of a second, stale copy of who is around.
- The server cannot know who is looking at a page, so only the browser can say "me".

**Cost.**

- With the admin secret or with auth off, names are sent and stored but no person is shown (GOTCHAS).
- A person whose sessions have all ended has no band, though today's spend still lists them.
- The id is per config directory, so a copied `~/.claude` makes two machines share one id (the host name
  still differs in most cases).
- The mod now writes one file of its own outside its store. A machine that had two ids (an inline copy and
  the marketplace install) settles on one, so its other row ends with that row's last session.
- Group changes in Admin reach a live session's card with its next report rather than at once.

<!-- nav:start -->
---

Previous: [20. Per-person tokens bound to a name, and an Admin section gated by the old shared secret](20-per-person-tokens-bound-to-a-name-and-an-admin.md) · Up: [Decisions](README.md) · Next: [22. Wall notices are server settings, shown at the bottom, with one switch each in Admin](22-wall-notices-are-server-settings-shown-at-the-bottom.md)
<!-- nav:end -->
