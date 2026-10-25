---
title: "30. Admin opens from the console's sign-in, with a name and a token"
description: "Admin unlocks with a name and a token through the console's sign-in, so an Administrator signs in once, at the cost of a wider respond cookie."
group: "Project internals"
number: 30
date: "2026-10-15"
status: "accepted"
order: 30
---

# 30. Admin opens from the console's sign-in, with a name and a token

**Context.** Admin and the console had two sign-ins that did not know about each other. An Administrator
signed in to respond still typed a token again to open Admin, the Admin button showed to everyone, and Admin
took a token alone (#215).

**Decision.** Admin's unlock takes a name and a token, checked by the same function as the sign-in to
respond.

- The respond cookie is scoped to `/api` instead of `/api/fleet/respond`.
- `POST /api/admin/unlock/from-respond` opens an Admin session for a browser whose respond sign-in is an
  Administrator's.
- The button shows only when `GET respond/me` says `admin`.
- The idle lock stays. An Administrator still signed in to the console is let back in without a prompt, and
  anyone else sees the sign-in.

**Alternatives.**

- One shared cookie for both sessions, which would tie the 10-minute Admin lock to the 12-hour console
  sign-in.
- Minting the Admin cookie at respond sign-in, which would not cover the idle lock and would not work if the
  Admin session had been locked on purpose.
- Dropping the idle lock.

**Cost.**

- The respond cookie now travels to every `/api` route, though only the respond and Admin routes read it.
- The Admin button is gone while responding is switched off (the `respond` flag is off by default), since
  nobody can sign in at the top bar then. `#/admin` still works.
- An explicit "Lock Admin" used to leave a reload free to reopen Admin while the console sign-in stood. #272
  fixed that (below).

**Update (#272).** "Lock Admin" marks that browser's respond sign-in as held, in memory. `from-respond`
refuses a held sign-in until that person unlocks with their name and token, which lifts the hold (another
Administrator unlocking in the same browser does not), or signs in to respond again. The sign-in itself
stands, so the person can still answer sessions, and the idle lock still lets a signed-in Administrator back
in. Alternative not taken: ending the respond sign-in on Lock Admin, which would also stop the person
answering sessions' prompts, something the button's name does not suggest.

<!-- nav:start -->
---

Previous: [29. A session keeps the Podium identity it started with](29-a-session-keeps-the-podium-identity-it-started.md) · Up: [Decisions](README.md) · Next: [31. Security sweep (#249): what was found, what was fixed, what is accepted](31-security-sweep-what-was-found-what-was-fixed-what.md)
<!-- nav:end -->
