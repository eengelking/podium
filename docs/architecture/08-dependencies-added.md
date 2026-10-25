---
title: "Dependencies added"
description: "The dependencies added to the project since the build and why each is there."
group: "Project internals"
order: 8
---

# Dependencies added

`express-rate-limit` at run time, for the failure limiter (#667). `@types/node` in `server/` went from 20 to 24 so `node:sqlite` is declared.

`astro`, `@astrojs/starlight` and `starlight-links-validator` in `site/`, for the docs site (#688). They are build tools for the site only and are not part of the server, the UI or the mod.

<!-- nav:start -->
---

Previous: [Mod API findings](07-mod-api-findings.md) · Up: [Architecture](README.md) · Next: [Phase log](09-phase-log.md)
<!-- nav:end -->
