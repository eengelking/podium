---
name: podium-docs-site
description: Work on the Podium docs site (site/, published at podium.engelking.dev from docs/). Load this to preview the site, add or move a doc page, change the menu, fix a link the build rejects, change how the site looks, check a release's docs version, or when docs-site.yml fails. It explains how the site is built from docs/ and from git tags, where the menu lives, what the build rewrites, and how to check it.
---

# The Podium docs site

`site/` is a separate Astro Starlight project that publishes `docs/`. It does not copy the docs into the repo: `docs/` stays the only
source, and `site/scripts/build.mjs` reads it each time. Decision 43 in `docs/DECISIONS.md` has the reasons.

## How it is built

- One Starlight build per version, put together into one folder (`site/out/`). The newest release line is built from the working
  tree and served at `/`. Each older line from `FIRST_VERSION_LINE` (`site/docs-nav.mjs`) on is built from its newest `vX.Y.Z` tag and
  served at `/<line>/`. The newest is built first, because a build empties its output folder.
- Before each build, `prepareDocs` (`site/scripts/lib.mjs`) writes `site/src/content/docs/<slug>.md` from each doc: a `title` from the
  first heading, a `description` from the first paragraph, `lastUpdated` from git, an edit link, and the heading removed. It rewrites
  links: a link to another doc becomes a site address, a link to `docs/standards/` or the images folder becomes the copied static
  folder, and any other file in the repository becomes a GitHub link at that version's tag. Code blocks and code spans are left alone.
  It also copies `docs/standards/` (as it is, to `/docs/standards/`), `docs/images/` and the atlas page (to `/atlas-map/`) into
  `site/public/`, plus the three app stylesheets the standards pages load (to `/frontend/src/fleet/`, from the same version), and
  writes `design-standards.md` and `architecture-atlas.md`, pages that show those two static pages in a frame.
- `site/src/content/docs/`, `site/public/docs/`, `site/public/frontend/`, `site/public/atlas-map/`, `site/public/images/` and
  `site/public/llms.txt` are generated and ignored by git. Never edit them; change `docs/` or `site/scripts/lib.mjs`.
- An older release may lack a page or a folder. The menu is built from what that version has, and the build never fails on a page a
  tag does not have.
- The build fails on a broken internal link (`starlight-links-validator`). The standards pages and the atlas page are served as they
  are and are not checked.

## Preview and check

```sh
cd site && npm ci --ignore-scripts          # once
node site/scripts/build.mjs --latest-only   # about 3 seconds: the newest version only
python3 -m http.server -d site/out 4400     # then open http://127.0.0.1:4400/
node site/scripts/build.mjs                 # every version, as the deploy does (needs the tags: git fetch --tags)
DOCS_FIRST_LINE=1.2 node site/scripts/build.mjs   # try the version menu before a second release line exists
```

Look at the result at 400 px and 1440 px, light and dark, with `scripts/page-shot.mjs` against that server (set
`document.documentElement.dataset.theme` in `--eval` to pick the theme), and stop the server afterwards. The tests for the page
preparation are `scripts/site-lib.test.ts` (`npm test -w server -- site-lib`).

## Common changes

| To | Do |
|---|---|
| Add a doc page | Add it to `GROUPS` in `site/docs-nav.mjs` (file, slug, label), in the group it belongs to. A page that is not listed is not published. |
| Move or rename a page | Change `docs-nav.mjs`, then run the build; the link check lists every link that no longer resolves. A slug is a public address, so keep it unless you must change it. |
| Change the look | `site/src/styles/theme.css` maps the app's tokens (`frontend/src/fleet/tokens.css`) onto Starlight's variables. Add no color of your own. The site's look follows `mockup/podium-docs-site.html`; a change to it needs a new mockup. |
| Change the header, footer, banner or version menu | The components in `site/src/components/`. They read the version list from `siteMeta.ts`. |
| Change the homepage | `site/src/pages/index.astro`. Its commands are the ones in the README and `docs/USER_GUIDE.md`; change them together. |
| Change the social image | Edit `site/og/og.html` and regenerate `site/public/og.png` as its comment says. |
| Change which releases are listed | `FIRST_VERSION_LINE` in `site/docs-nav.mjs`. |

## Releases

The release-prep PR changes no file for the site: the newest version is read from the root `package.json`, and the older lines come from
the tags, so a new minor release adds a line by itself when `main` moves. Before a release, check that `node site/scripts/build.mjs`
passes on `development` (the release PR's `docs-site.yml` run does the same). After the merge to `main`, the deploy job publishes the
site; check the run is green and the new version is in the menu before the tag is proposed.

## A workaround to remove

The Actions menu samples on the standards Components page are `position: fixed` and float over the page (#700). The site adds
`.s-sample .menubox { position: static; }` inside the standards frame (`fix` in `EMBEDS`, `site/docs-nav.mjs`) because the pages are served
unchanged. Remove `fix` when #700 is fixed in the standards generator.

## What not to do

- Do not edit anything under `docs/standards/` through the site: it is generated from the app (`podium-standards-update`).
- Do not copy docs into `site/`, or keep a second copy of a page.
- Do not add a new color. Use a token.
- Do not run the site's `npm install` from the repo root; `site/` has its own `package.json` and lockfile and is not an npm workspace.
