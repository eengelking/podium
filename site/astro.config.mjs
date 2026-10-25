// The Podium docs site (#688). scripts/build.mjs runs this once per version and sets the DOCS_* variables each time:
//   DOCS_BASE      where this build is served ("/" for the newest version, "/1.2/" for an older one)
//   DOCS_OUT       the folder it writes to
//   DOCS_CURRENT   this build's version line, and DOCS_VERSIONS the list the version menu shows (JSON)
//   DOCS_REF       the git tag older versions are built from (empty for the newest)
import path from "node:path";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLinksValidator from "starlight-links-validator";
import { GROUPS, SITE_ORIGIN, REPO } from "./docs-nav.mjs";

const base = process.env.DOCS_BASE || "/";
const outDir = process.env.DOCS_OUT ? path.resolve(process.env.DOCS_OUT) : undefined;
const older = process.env.DOCS_REF ? true : false;

// An older release may lack a page or a static folder, so the menu lists only what this version has.
const pages = process.env.DOCS_PAGES ? new Set(JSON.parse(process.env.DOCS_PAGES)) : null;
const has = (i) => !pages || pages.has(i.slug);
const sidebar = GROUPS.map((g) => ({
  label: g.label,
  items: g.items.filter(has).map((i) => ({ label: i.label, slug: i.slug })),
})).filter((g) => g.items.length > 0);

const description =
  "Podium is a live fleet console for Claude Code. See every session's model, cost, context window, failures and git branch on one screen. It watches and never types into a terminal.";

export default defineConfig({
  site: SITE_ORIGIN,
  base,
  outDir,
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Podium",
      description,
      favicon: "/favicon.svg",
      credits: false,
      lastUpdated: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      customCss: ["./src/styles/theme.css"],
      components: {
        Header: "./src/components/Header.astro",
        Footer: "./src/components/Footer.astro",
        Banner: "./src/components/Banner.astro",
        PageTitle: "./src/components/PageTitle.astro",
      },
      sidebar,
      plugins: [
        starlightLinksValidator({
          // The standards pages and the atlas page are served as they are, so they are not Starlight pages; the Markdown links
          // to them are rewritten to static files and are not checked here.
          exclude: ["**/docs/standards/**", "**/atlas-map/**", "**/images/**"],
          errorOnLocalLinks: false,
          errorOnInvalidHashes: false,
        }),
      ],
      head: [
        { tag: "meta", attrs: { property: "og:site_name", content: "Podium" } },
        { tag: "meta", attrs: { property: "og:image", content: `${SITE_ORIGIN}/og.png` } },
        { tag: "meta", attrs: { property: "og:image:alt", content: "Podium: every Claude Code session on one screen" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${SITE_ORIGIN}/og.png` } },
        ...(older ? [{ tag: "meta", attrs: { name: "robots", content: "noindex" } }] : []),
        { tag: "link", attrs: { rel: "me", href: `https://github.com/${REPO}` } },
      ],
    }),
  ],
});
