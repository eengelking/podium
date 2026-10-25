---
title: "Reporters, identity and Admin"
description: "How reporter tokens, people and the Admin area work, and which server files own them."
group: "Project internals"
order: 1
---

# Reporters, identity and Admin

Files: `server/src/fleet/tokens.ts`, `people.ts`, `server/src/admin/adminRouter.ts`. The reasoning is in
DECISIONS 20 and 30.

**Who is reporting**

- `routes.ts` turns the `X-Podium-Token` header into an identity before it reads a body. The identity is one of:
  a person's token (`pdm_<key id>_<secret>`, found by key id and checked against a stored SHA-256 in constant
  time), the admin secret (`PODIUM_TOKEN`), or open when auth is off.
- The identity gives the session its `owner`, which `ingest.ts` writes into `sessions.owner`. For a person's
  token the report's `userName` must also match, so the token decides who and the name is only a consistency
  check.
- `people.ts` owns the migration-6 tables (people, groups, person_machines, admin_log, settings) and every paged
  query.

**The Admin API**

- It is a separate router mounted at `/api/admin`.
- An unlock exchanges a name and token for a random session id held in a process-memory map (with who opened it,
  checked again on every request) and an `HttpOnly; SameSite=Strict` cookie. The token is an Administrator's own
  (#172), or `Admin` with the admin secret, checked by `fleet/nameToken.ts` as the sign-in to respond is.
- Sessions have an idle expiry, a per-address lockout, and a required `X-Podium-Admin` header on changes.
- A restart ends every Admin session, which is also how rotating the admin secret ends them.
- The Admin page (`frontend/src/fleet/admin/`, route `#/admin`) holds a new token, and a person's reporter config
  file, in component state only until the owner says it is saved (`OnceBox.tsx`). Neither is written to browser storage,
  and the file cannot be fetched again: the server keeps the certificate and never the key.
- Admin > People (`PeopleTab.tsx`, #587) reads `GET /api/admin/people`, which adds `tls` and each row's
  `certificate` (`notAfter`, `revoked`) while TLS is on. `peopleCert.ts` turns that into the Reporter certificate badge
  and its note; `RowMenu.tsx` is the per-row Actions menu (a details disclosure placed from its button).

**Opening Admin from the console sign-in** (#215, #272)

- A browser already signed in to respond as an Administrator opens Admin with no second sign-in. The respond
  routes widen their cookie to `Path=/api` and fill in a `RespondBridge` (`fleet/respondBridge.ts`) that the
  Admin router asks on `POST unlock/from-respond`.
- `POST lock` calls the bridge's `hold` to mark that sign-in, so `administratorOf` answers null until
  `POST unlock` calls `release` for that same person or the person signs in to respond again.
- The top bar's Admin button reads `me.admin` from `useRespond`. The server, not the button, is the check.

<!-- nav:start -->
---

Up: [Components](README.md) · Next: [Admin page patterns](02-admin-page-patterns.md)
<!-- nav:end -->
