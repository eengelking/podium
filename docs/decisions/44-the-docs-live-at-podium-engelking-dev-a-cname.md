---
title: "44. The docs live at podium.engelking.dev, a CNAME to GitHub Pages (#689)"
description: "The docs site lives at podium.engelking.dev, a DNS-only CNAME to GitHub Pages, so renewal stays with GitHub and the maintainer's other domains stay untouched."
group: "Project internals"
number: 44
date: "2026-10-25"
status: "accepted"
order: 44
---

# 44. The docs live at podium.engelking.dev, a CNAME to GitHub Pages (#689)

*Context.* The docs site (decision 43) needs an address people can remember. The maintainer owns `engelking.dev`, with its DNS
on Cloudflare, and chose a subdomain of it over registering a new domain.

*Decision.*

- `podium.engelking.dev` is a `CNAME` to `eengelking.github.io`, and GitHub Pages serves the site there. The record is DNS only
  (not proxied), so Pages can issue and renew the certificate itself. If it is ever proxied, Cloudflare's SSL mode must be Full
  (strict) or renewal fails.
- Pages builds from the `Docs site` workflow, not from a branch. The custom domain is set in the repository's Pages settings, and
  `site/public/CNAME` keeps it in every build so a deploy does not clear it. HTTPS is enforced once the first deploy has run (#709).
- The apex `engelking.dev` is the maintainer's own and this project does not touch it. Podium needs only the one subdomain.
- The old `eengelking.github.io/podium` address redirects to the domain; GitHub does that once a custom domain is set.
- The repository's homepage and the README name the site as the official homepage and documentation site.

*Why.* A subdomain costs nothing extra and keeps the maintainer's other uses of the domain free. A DNS-only CNAME is what Pages
documents, and it leaves certificate renewal with GitHub. Every `.dev` domain is on the browser HSTS preload list, so the site is
HTTPS-only from the first request, which Pages supports.

<!-- nav:start -->
---

Previous: [43. The docs site is Astro Starlight, and each version is built from its git tag (#688)](43-the-docs-site-is-astro-starlight-and-each-version.md) · Up: [Decisions](README.md) · Next: [45. Large docs split along their sections into folders, with a README as the index (#697)](45-large-docs-split-along-their-sections.md)
<!-- nav:end -->
