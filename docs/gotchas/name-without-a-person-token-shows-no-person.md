---
title: "A name set with the shared secret, or with no token, shows no person"
description: "The people view follows the token, not the name; give each person a token in Admin and put it in their reporter with their name."
group: "Project internals"
area: "Running the server"
date: "2026-10-12"
status: "open"
order: 22
---

# A name set with the shared secret, or with no token, shows no person

**You see:** A reporter sends `userName`, and the people view stays off or the session shows under **Admin** or
**Unassigned**.

**Why:** The people view groups sessions by who the server decided sent them, and that comes from the token. A reporter
that sends `userName` with the admin secret shows under Admin. One that sends it to a server with no `PODIUM_TOKEN`
shows under Unassigned. Neither turns the people view on. The name and machine still travel in those reports and are
stored, so they are not private either.

**Do:** Give each person a token in Admin, and put it in their reporter with their name.

<!-- nav:start -->
---

Previous: [Anyone on localhost can read the console](anyone-on-localhost-can-read-the-console.md) · Up: [Gotchas](README.md) · Next: [A group change shows a few seconds late](group-change-shows-a-few-seconds-late.md)
<!-- nav:end -->
