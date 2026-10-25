---
title: "Getting in"
description: "Find out who sees the Admin button and how to open Admin."
group: "Getting started"
order: 1
---

# Getting in

The **Admin** button in the top bar's upper right shows only when you are signed in to the console as someone in the
**Administrators** group (see [Groups](04-groups.md)), or as **Admin** with the admin secret. It opens Admin with no second
sign-in.

Anyone else goes to `#/admin`, which asks for a name and a token. Use your own name and token if you are in
Administrators, or the name **Admin** and the admin secret, which `podiumctl token` prints.

- Admin locks again after 10 minutes without activity. An Administrator who is still signed in to the console is let
  straight back in.
- Five wrong names or tokens lock it for 15 minutes.
- A server started without a token has no Admin, because there would be nothing to protect it.

<!-- nav:start -->
---

Up: [Admin](README.md) · Next: [Getting around](02-getting-around.md)
<!-- nav:end -->
