---
title: "Dependencies added"
description: "The dependencies added to the project since the build and why each is there."
group: "Project internals"
order: 8
---

# Dependencies added

`express-rate-limit` at run time, for the failure limiter (#667). `@types/node` in `server/` went from 20 to 24 so `node:sqlite` is declared.

`express` and `@types/express` in `server/` went from 4 to 5 (#392). Two small helpers keep what Express 4 did: `jsonBody` leaves `req.body` as `{}` when a request has no JSON body, and `serveSpa` names `index.html` relative to its folder.

`typescript` in `frontend/` and `server/` went from 5.9 to 7.0 (#291). TypeScript 7 has no JavaScript compiler API, so `@typescript/typescript6` is a dev dependency at the root, for the two storage guard tests and `scripts/promise-misuse.mjs`. It brings a second `tsc` command, which is why the scripts run TypeScript 7 by its path.

`pg` (#822) and `mariadb` (#823) in `server/` at run time: the drivers of the PostgreSQL and MariaDB adapters, `mariadb` being the
official MariaDB connector. Each is loaded only when `PODIUM_DB` chooses its kind, and only its adapter's folder imports it
(`server/src/storage/neutral.test.ts`). Both are plain JavaScript, so `npm ci --ignore-scripts` needs no install script for them.

`astro`, `@astrojs/starlight` and `starlight-links-validator` in `site/`, for the docs site (#688). They are build tools for the site only and are not part of the server, the UI or the mod.

<!-- nav:start -->
---

Previous: [Mod API findings](07-mod-api-findings.md) · Up: [Architecture](README.md) · Next: [Phase log](09-phase-log.md)
<!-- nav:end -->
