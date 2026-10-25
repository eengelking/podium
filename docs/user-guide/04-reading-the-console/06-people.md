---
title: "People"
description: "See how the console groups sessions by person when several people report to one server."
group: "Getting started"
order: 6
---

# People

When several people report to one Podium with their own tokens (see [Admin](../05-admin/README.md)), the console groups their sessions.
Nothing changes until a session reports with a person's token. Sessions sent with the admin secret, or to a server with
no token, keep the plain wall.

The row with the filters then gains a **People** group:

- **Group by**: People (a band per person), Group (a band per group from Admin) or All (the plain wall, with the owner on
  each card). When you are signed in as a person there is also **Me**: the plain wall with just your own orchestrators.
- **Order by**: Needs attention (your own band first, then whoever has the most sessions waiting or stale), Spend, or
  Name. It orders the bands, and is hidden for All and Me. **Sort by**, beside the filters, orders the cards inside each
  band.

## Who you are

Podium knows who you are from your sign-in (the **Sign in** button in the top bar, the same one you use to respond).
Signing in needs the Admin to have turned on responding.

- Signed in as a person, your band is marked "you" (your group's band "your group") and comes first under Needs
  attention, and **Me** is offered.
- Signed out, or signed in as Admin, there is no "you" and no Me.

## A person's band

A band header shows their initials and name, their group, the machines their sessions run on, how many are live, how
many are waiting or stale, and their share of today's estimated spend.

- Click the header to fold the band to that line. Podium remembers which bands you folded.
- Each card in the band says which machine it runs on. One person on two machines is one band. When two of their
  machines have the same name, the card adds the start of the machine's id.
- Sessions reported with the admin secret are in an **Admin** band.
- Sessions with no owner (only possible on a server with no token) are under **Unassigned**, after everyone else.
- In Group, people without a group, Admin and Unassigned are under **No group**, and a group with no live sessions has
  no band.

The left list groups the same way. Click a person or group there to show only theirs on the wall. Click it again, or
click **All orchestrators**, to see everyone again. Spend by person or group is in Admin, under **Spend**.

<!-- nav:start -->
---

Previous: [The board](05-the-board.md) · Up: [Reading the console](README.md) · Next: [Paging the list](07-paging-the-list.md)
<!-- nav:end -->
