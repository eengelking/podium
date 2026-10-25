// What the site shows from docs/ and where. This is the one place a doc page is placed in the menu (#688), until every page
// carries its own `title`, `description` and `group` in frontmatter (#696). A page that is not listed here is not published.
// `file` is the path under docs/; `slug` is the page's address on the site.
export const GROUPS = [
  {
    label: "Getting started",
    items: [
      { file: "USER_GUIDE.md", slug: "user-guide", label: "User guide" },
      { file: "DEMO.md", slug: "demo", label: "Demo" },
    ],
  },
  {
    label: "Running it",
    items: [
      { file: "SERVER.md", slug: "server", label: "Running the server" },
      { file: "REPORTER.md", slug: "reporter", label: "Reporter" },
      { file: "MESSAGING.md", slug: "messaging", label: "Messaging" },
      { file: "REPLAY.md", slug: "replay", label: "Session replay" },
    ],
  },
  {
    label: "Reference",
    items: [
      { file: "SPEC.md", slug: "spec", label: "Specification" },
      // Served as it is, from docs/standards/. It is generated from the app, so the site never rewrites it.
      { link: "standards/", label: "Design standards" },
      { link: "atlas-map/", label: "Architecture atlas" },
      { file: "atlas/ATLAS.md", slug: "atlas", label: "Atlas tables" },
    ],
  },
  {
    label: "Project internals",
    items: [
      { file: "ARCHITECTURE.md", slug: "architecture", label: "Architecture" },
      { file: "DECISIONS.md", slug: "decisions", label: "Decisions" },
      { file: "GOTCHAS.md", slug: "gotchas", label: "Gotchas" },
      { file: "COMMUNITY.md", slug: "community", label: "Community" },
      { file: "THIRD_PARTY_NOTICES.md", slug: "third-party-notices", label: "Third-party notices" },
    ],
  },
];

/** Every page the site builds from a Markdown file, in menu order. */
export const PAGES = GROUPS.flatMap((g) => g.items.filter((i) => i.file).map((i) => ({ ...i, group: g.label })));

/** Static folders copied into the site as they are. `from` is under docs/, `to` under the site root. */
export const STATIC_DIRS = [
  { from: "standards", to: "standards" },
  // The interactive atlas page is served at /atlas-map/ because /atlas/ is the page built from ATLAS.md.
  { from: "atlas", to: "atlas-map", only: ".html", rename: { "podium-atlas.html": "index.html" } },
  { from: "images", to: "images" },
];

export const REPO = "eengelking/podium";
export const SITE_ORIGIN = "https://podium.engelking.dev";

// The first release line the version menu lists (#688). The site is built from the working tree for the newest line and from each
// older line's newest tag back to this one; earlier releases are not back-filled.
export const FIRST_VERSION_LINE = "1.3";
