---
title: "43. The docs site is Astro Starlight, and each version is built from its git tag (#688)"
description: "The docs site is Astro Starlight with each version built from its git tag, at the cost of a version dropdown and link rewrite we maintain."
group: "Project internals"
number: 43
date: "2026-10-25"
status: "accepted"
order: 43
---

# 43. The docs site is Astro Starlight, and each version is built from its git tag (#688)

*Context.* The docs are Markdown files in `docs/`. The maintainer wants them on GitHub Pages at
`podium.engelking.dev` (#689) with a menu, search, SEO and a version dropdown that opens on the latest release. The
site is a separate project in `site/`, not part of the server or the UI, and `docs/` stays the only source.

*Decision.*

- The generator is Astro Starlight. Search is Pagefind, built into Starlight, client-side, with no outside service.
- A version is a release line (`1.3`), and the site shows the newest patch tag of each line. The latest line is served
  at `/`, and older ones at `/<line>/`.
- Each version is built from that tag's `docs/` (`git archive <tag> docs`) in its own Starlight build, and the builds are
  put together into one site. Nothing is copied into the repo for an old version.
- A small build step prepares the pages before Starlight reads them: it gives a page a `title` from its first heading
  until every page has frontmatter (#696), and rewrites links between pages to site routes.
- The dropdown is a Starlight component override. Each build is given the whole version list, so the menu needs no
  request, and "same page in another version" sends a person to the page when that version has it and to that version's
  front page when it does not.
- The newest version is built from the working tree, not a tag, because the site is built when `main` moves and the tag
  comes after. Older versions are noindex and out of the sitemap, so a search finds the current page and not five copies.
- The menu lists what each version has: an older release may lack a page the newest has.
- The community plugin `starlight-versions` is not used.

*Why.* A spike, run before the choice was made, built the real docs two ways with Starlight 0.42.7 and Astro 7.4.2.

- `starlight-versions` 0.10.1 snapshots the current pages into the repo and parses every page as MDX, including `.md`
  files. It stopped at the first unescaped `<feedback>` in `docs/architecture/` and then at a `<time>` elsewhere. The
  docs are plain Markdown that quotes tags in prose, and every new page would have to be written to MDX's rules. It also
  keeps a second copy of each old version in the repo.
- Building from a tag needed no plugin. v1.2.2 and v1.3.0 each built in about two seconds (11 and 13 pages), with Pagefind
  indexes of their own, so an old version searches only its own pages. Put together, the latest sits at `/` and the older
  one at `/1.2/`, with its links and assets under that path. The latest has to be built first, since a build empties its
  output folder.
- The link validator (`starlight-links-validator` 0.27.0) ran on the 1.3.0 build and reported 5 invalid links in 2 files,
  which the build step or the docs have to fix. Links written as `FILE.md` do not become site routes by themselves.

*Alternatives.* Docusaurus versions natively, but it copies each version into the repo like the plugin does and brings a
heavier toolchain. MkDocs Material with `mike` and Hugo were not tried. Neither shares the maintainer's website stack,
and the spike showed Starlight can do what was needed.

*Also decided.* The site's accent is the console's blue, `--sonnet`, for what is selected and what can be clicked, with the
status colors `--good`, `--warn` and `--crit` for tip, caution and danger callouts. It borrows a model color for a non-model
job. The maintainer approved that when the mockup was accepted on #688, and since the site is not part of the app the
standards pages do not change. Search is Pagefind over the docs pages only;
`docs/standards/` and the atlas page are served as they are and are not indexed. Each is shown in a frame inside a page of the
site (`/design-standards/`, `/architecture-atlas/`), so the header and menu stay around it, and each is also reachable on its own page.
The standards load the app's stylesheets as `../../frontend/src/fleet/*.css`, so the site serves them at `/docs/standards/` and
copies those stylesheets, from the same version, to `/frontend/src/fleet/`; the pages themselves are not changed. The atlas is at
`/atlas-map/`, because `/atlas/` is the page built from `ATLAS.md`. The site serves its two fonts itself (Fontsource, latin subset, SIL OFL), so a visitor's browser does not contact Google for them. The
standards and atlas pages are served unchanged, so their frames still load fonts from Google Fonts.

*Cost.* The version dropdown, the combined build and the link rewrite are ours to write and keep. A tag's `docs/` is built
with today's theme, so an old version looks like the current site and not like it did. A tag whose docs do not build
needs a fix in the build step, not a change to the tag. Versions start at the first release that ships with the site
(v1.3.1 is the first); earlier ones are not back-filled.

<!-- nav:start -->
---

Previous: [42. Podium makes its own CA, and the reporter authenticates with a certificate (#577)](42-podium-makes-its-own-ca-and-the-reporter.md) · Up: [Decisions](README.md) · Next: [44. The docs live at podium.engelking.dev, a CNAME to GitHub Pages (#689)](44-the-docs-live-at-podium-engelking-dev-a-cname.md)
<!-- nav:end -->
