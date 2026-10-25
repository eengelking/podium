// What the site shows from docs/ and where. This is the one place a doc page is placed in the menu (#688). Each page also names its
// own `title`, `description` and `group` in frontmatter (#696), and a test (scripts/site-lib.test.ts) checks the group against this list. A page that is
// not listed here is not published.
// `file` is the path under docs/; `slug` is the page's address on the site; `label` is its name in the menu and in links that name it.
// An item with `dir` is a topic split into a folder (#697): docs/<dir>/README.md is its first page and every other page in the folder
// follows in the `order` of its frontmatter, a subfolder being a group of its own. `legacy` is the single file an older version has
// instead, which the site still shows as one page.
// `title` and `description` are optional and replace the page's frontmatter. An older version's docs have no frontmatter, so for them
// the build falls back to the doc's first heading and first paragraph.
export const GROUPS = [
  {
    label: "Getting started",
    items: [
      { file: "INTRODUCTION.md", slug: "introduction", label: "Introduction" },
      { dir: "user-guide", legacy: "USER_GUIDE.md", slug: "user-guide", label: "User guide" },
      { file: "DEMO.md", slug: "demo", label: "Demo", description: "A script and a paste-in prompt for showing Podium to other people, built to be screen-recorded." },
    ],
  },
  {
    label: "Running it",
    items: [
      { file: "SERVER.md", slug: "server", label: "Server" },
      { file: "REPORTER.md", slug: "reporter", label: "Reporter" },
      { file: "MESSAGING.md", slug: "messaging", label: "Messaging" },
      { file: "REPLAY.md", slug: "replay", label: "Session replay", description: "Record a session whole and play it back: the three yes answers, what is and is not captured, the notice, retention, limits and who can read it." },
    ],
  },
  {
    label: "Reference",
    items: [
      { dir: "spec", legacy: "SPEC.md", slug: "spec", label: "Specification", title: "Specification", description: "The build spec: what Podium must do, its intended behavior and requirements." },
      // These two are served as they are (docs/standards/ is generated from the app, so the site never rewrites it) and shown inside
      // a page of the site, so the menu and the header stay around them. See EMBEDS.
      { slug: "design-standards", label: "Design standards" },
      { slug: "architecture-atlas", label: "Architecture atlas" },
      { file: "atlas/ATLAS.md", slug: "atlas", label: "Atlas tables" },
    ],
  },
  {
    label: "Project internals",
    items: [
      { dir: "architecture", legacy: "ARCHITECTURE.md", slug: "architecture", label: "Architecture" },
      { dir: "decisions", legacy: "DECISIONS.md", slug: "decisions", label: "Decisions" },
      { dir: "gotchas", legacy: "GOTCHAS.md", slug: "gotchas", label: "Gotchas" },
      { file: "COMMUNITY.md", slug: "community", label: "Community" },
      { file: "THIRD_PARTY_NOTICES.md", slug: "third-party-notices", label: "Third-party notices" },
    ],
  },
];


/**
 * Pages that show a static page of the site in a frame. `dir` is the static folder that must exist in a version for its page to be
 * written, `src` is the page shown, under the site's base.
 */
export const EMBEDS = [
  {
    slug: "design-standards",
    dir: "docs/standards",
    src: "docs/standards/index.html",
    title: "Design standards",
    description: "How Podium's UI looks and is built: tokens, themes, every component with its states, patterns, voice and accessibility.",
    frame: "Podium design standards",
    // The Actions menu samples are position: fixed in the app and the standards do not draw them in place, so they float over the
    // page (#700). The rule is added inside the frame only, because the pages are served unchanged. Remove it when #700 is fixed.
    fix: ".s-sample .menubox { position: static; }",
    group: "Reference",
  },
  {
    slug: "architecture-atlas",
    dir: "atlas-map",
    src: "atlas-map/index.html",
    title: "Architecture atlas",
    description: "An interactive map of how Podium fits together: the parts, how a report travels, the deployment modes and where data lives.",
    frame: "The Podium architecture atlas",
    group: "Reference",
  },
];

/** Static folders copied into the site as they are. `from` is under docs/, `to` under the site root. */
export const STATIC_DIRS = [
  // Under docs/ because the standards pages load the app's stylesheets as ../../frontend/src/fleet/*.css, which resolves from here to
  // the copies STYLES puts at <base>frontend/src/fleet/.
  { from: "standards", to: "docs/standards" },
  // The interactive atlas page is served at /atlas-map/ because /atlas/ is the page built from ATLAS.md.
  { from: "atlas", to: "atlas-map", only: ".html", rename: { "podium-atlas.html": "index.html" } },
  { from: "images", to: "images" },
];

/** The app stylesheets the standards pages load, copied unchanged from the same version of the repository. */
export const STYLES = ["frontend/src/fleet/tokens.css", "frontend/src/fleet/fleet.css", "frontend/src/fleet/admin/admin.css"];

export const REPO = "eengelking/podium";
export const SITE_ORIGIN = "https://podium.engelking.dev";

// The first release line the version menu lists (#688). The site is built from the working tree for the newest line and from each
// older line's newest tag back to this one; earlier releases are not back-filled.
export const FIRST_VERSION_LINE = "1.3";
