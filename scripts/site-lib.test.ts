// Tests for the docs site's page preparation and version choice (site/scripts/lib.mjs, #688).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectPages, computeVersions, descriptionOf, embedPage, frontmatter, llmsTxt, plain, prepareDocs, preparePage, releaseUrl, rewriteLinks, rewriteTarget, titleOf, withoutBlock, withoutContents } from "../site/scripts/lib.mjs";
import { parseFrontmatter } from "./docFrontmatter.mjs";

const slugs = new Map<string, string>([
  ["SERVER.md", "server"],
  ["USER_GUIDE.md", "user-guide"],
  ["atlas/ATLAS.md", "atlas"],
]);
const labels = new Map<string, string>([
  ["SERVER.md", "Server"],
  ["USER_GUIDE.md", "User guide"],
  ["atlas/ATLAS.md", "Atlas tables"],
]);
const ctx = { base: "/", ref: "main", fromDir: "", slugs, labels };

describe("plain", () => {
  it("keeps the text of links and drops code, emphasis and strike marks", () => {
    expect(plain("The **[user guide](USER_GUIDE.md)** and `podiumctl` ~~old~~")).toBe("The user guide and podiumctl old");
  });
  it("keeps an underscore inside a word", () => {
    expect(plain("Set PODIUM_TOKEN or _this_")).toBe("Set PODIUM_TOKEN or this");
  });
  it("leaves a bracket that never closes as text", () => {
    expect(plain("a [b](c and d")).toBe("a [b](c and d");
  });
});

describe("titleOf and descriptionOf", () => {
  const md = "# Running *the* server\n\nContents:\n\n- [a](#a)\n\nThis page is for whoever runs it. It has two sentences.\n\n## Next\n";
  it("takes the first heading outside a code block", () => {
    expect(titleOf("```\n# not this\n```\n# This\n")).toBe("This");
    expect(titleOf(md)).toBe("Running the server");
    expect(titleOf("no heading")).toBe("");
  });
  it("takes the first paragraph of prose after the title, skipping a list", () => {
    expect(descriptionOf("# T\n\n- item\n\n> quote\n\nThe first real line.\nIt continues.\n\nSecond paragraph.")).toBe("The first real line. It continues.");
  });
  it("stops at a heading and gives an empty description when there is no prose", () => {
    expect(descriptionOf("# T\n\n## Next\n\ntext")).toBe("");
  });
  it("cuts a long paragraph at a sentence, or at a word with an ellipsis", () => {
    const sentence = `${"word ".repeat(20)}ends here. ${"more ".repeat(40)}`;
    expect(descriptionOf(`# T\n\n${sentence}`).endsWith("ends here.")).toBe(true);
    const run = "word ".repeat(60);
    const cut = descriptionOf(`# T\n\n${run}`);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(161);
  });
});

describe("withoutContents", () => {
  it("drops a Contents: line and the list under it, nested items and blank lines included", () => {
    const md = "Intro.\n\nContents:\n\n- [a](#a)\n  - [b](#b)\n- [c](#c)\n\n## A\n\nText.\n";
    expect(withoutContents(md)).toBe("Intro.\n\n## A\n\nText.\n");
  });
  it("drops a ## Contents section up to the next ## heading, table or list", () => {
    const md = "# T\n\n## Contents\n\n| # | Decision |\n|---|---|\n| 1 | x |\n\n## One\n\nBody.\n";
    expect(withoutContents(md)).toBe("# T\n\n## One\n\nBody.\n");
  });
  it("keeps a contents list inside a code block and any text that is not one", () => {
    const md = "```\nContents:\n- a\n```\n\nContents: of the box are listed below.\n\n- real list\n";
    expect(withoutContents(md)).toBe(md);
  });
  it("stops a list at the first line that is not part of it", () => {
    expect(withoutContents("Contents:\n- a\nNot a list.\n")).toBe("Not a list.\n");
  });
});

describe("rewriteTarget", () => {
  it("leaves addresses that are not relative paths alone", () => {
    for (const t of ["https://x.test/a", "mailto:a@b.test", "#heading", "/abs/path", "", "tel:123"]) expect(rewriteTarget(t, ctx)).toBe(t);
  });
  it("sends a doc to its page, with the heading anchor", () => {
    expect(rewriteTarget("SERVER.md#auth-token", ctx)).toBe("/server/#auth-token");
    expect(rewriteTarget("SERVER.md", { ...ctx, base: "/1.2/" })).toBe("/1.2/server/");
  });
  it("resolves a link from a doc in a folder", () => {
    expect(rewriteTarget("../USER_GUIDE.md", { ...ctx, fromDir: "atlas" })).toBe("/user-guide/");
    expect(rewriteTarget("ATLAS.md", { ...ctx, fromDir: "atlas" })).toBe("/atlas/");
  });
  it("serves the standards and images folders as they are, and the atlas page under its own address", () => {
    expect(rewriteTarget("standards/", ctx)).toBe("/docs/standards/index.html");
    expect(rewriteTarget("standards/tokens.html#x", ctx)).toBe("/docs/standards/tokens.html#x");
    expect(rewriteTarget("images/podium-chaos.png", ctx)).toBe("/images/podium-chaos.png");
    expect(rewriteTarget("atlas/podium-atlas.html", ctx)).toBe("/atlas-map/index.html");
  });
  it("sends anything else in the repository to GitHub at the version's tag", () => {
    const old = { ...ctx, ref: "v1.2.2" };
    expect(rewriteTarget("../server/src/db.ts", old)).toBe("https://github.com/eengelking/podium/blob/v1.2.2/server/src/db.ts");
    expect(rewriteTarget("../mod/", old)).toBe("https://github.com/eengelking/podium/tree/v1.2.2/mod");
    expect(rewriteTarget("ISSUES.md#a", old)).toBe("https://github.com/eengelking/podium/blob/v1.2.2/docs/ISSUES.md#a");
    expect(rewriteTarget("fixtures", old)).toBe("https://github.com/eengelking/podium/tree/v1.2.2/docs/fixtures");
  });
  it("leaves a path that climbs out of the repository", () => {
    expect(rewriteTarget("../../../etc/passwd", ctx)).toBe("../../../etc/passwd");
  });
});

describe("rewriteLinks", () => {
  it("rewrites links and images, keeps a link title, and handles parentheses in an address", () => {
    const out = rewriteLinks('See [guide](USER_GUIDE.md "The guide") and ![shot](images/a.png) and [w](https://x.test/a_(b)).', ctx);
    expect(out).toBe('See [guide](/user-guide/ "The guide") and ![shot](/images/a.png) and [w](https://x.test/a_(b)).');
  });
  it("names the page when the link text is just the file it points at", () => {
    expect(rewriteLinks("See [SERVER.md](SERVER.md#auth-token) and [`USER_GUIDE.md`](USER_GUIDE.md).", ctx)).toBe(
      "See [Server](/server/#auth-token) and [User guide](/user-guide/).",
    );
    expect(rewriteLinks("[ATLAS.md](ATLAS.md)", { ...ctx, fromDir: "atlas" })).toBe("[Atlas tables](/atlas/)");
    expect(rewriteLinks("[docs/SERVER.md](../docs/SERVER.md)", ctx)).toBe("[Server](/server/)");
  });
  it("keeps link text that is not a bare file name, or whose file is not a page", () => {
    expect(rewriteLinks("[the server guide](SERVER.md) and [ISSUES.md](ISSUES.md) and [x.md](https://x.test/x.md) and [SERVER.md](#top)", ctx)).toBe(
      "[the server guide](/server/) and [ISSUES.md](https://github.com/eengelking/podium/blob/main/docs/ISSUES.md) and [x.md](https://x.test/x.md) and [SERVER.md](#top)",
    );
  });
  it("does not touch code spans or fenced blocks", () => {
    const md = "Use `[a](SERVER.md)` here, then [b](SERVER.md).\n\n```\n[c](SERVER.md)\n```\n\n~~~\n[d](SERVER.md)\n~~~\n";
    const out = rewriteLinks(md, ctx);
    expect(out).toContain("`[a](SERVER.md)`");
    expect(out).toContain("[b](/server/)");
    expect(out).toContain("[c](SERVER.md)");
    expect(out).toContain("[d](SERVER.md)");
  });
  it("handles double-backtick code spans and an unclosed link", () => {
    expect(rewriteLinks("``a ` [x](SERVER.md)`` [y](SERVER.md)", ctx)).toBe("``a ` [x](SERVER.md)`` [y](/server/)");
    expect(rewriteLinks("broken [x](SERVER.md and more", ctx)).toBe("broken [x](SERVER.md and more");
    expect(rewriteLinks("an `unclosed span [x](SERVER.md)", ctx)).toBe("an `unclosed span [x](/server/)");
  });
});

describe("frontmatter and preparePage", () => {
  it("writes strings as JSON, leaves the date bare and skips empty fields", () => {
    expect(frontmatter({ title: 'A "quoted": title', lastUpdated: "2026-10-22", editUrl: undefined, description: "" })).toBe(
      '---\ntitle: "A \\"quoted\\": title"\nlastUpdated: 2026-10-22\n---\n\n',
    );
  });
  it("builds a page: title and description from the doc, no heading in the body, links rewritten", () => {
    const page = { file: "atlas/ATLAS.md", slug: "atlas", label: "Atlas tables" };
    const out = preparePage(page, "# Atlas\n\nThe map. See [guide](../USER_GUIDE.md).\n", { base: "/", ref: "main", slugs, editBase: "https://github.com/eengelking/podium/edit/development/", lastUpdated: "2026-10-22" });
    expect(out.title).toBe("Atlas");
    expect(out.description).toBe("The map. See guide.");
    expect(out.content).toContain('editUrl: "https://github.com/eengelking/podium/edit/development/docs/atlas/ATLAS.md"');
    expect(out.content).toContain("lastUpdated: 2026-10-22");
    expect(out.content).not.toContain("# Atlas");
    expect(out.content).toContain("[guide](/user-guide/)");
    expect(out.content).not.toContain("banner");
  });
  it("uses a title and description given in the menu over the ones taken from the doc, and hides the contents list", () => {
    const page = { file: "SPEC.md", slug: "spec", label: "Specification", title: "Specification", description: "What Podium must do." };
    const out = preparePage(page, "# SPEC: Podium, a long name\n\nContents:\n\n- [a](#a)\n\nFirst paragraph.\n", { base: "/", ref: "main", slugs, labels, editBase: "" });
    expect(out.title).toBe("Specification");
    expect(out.description).toBe("What Podium must do.");
    expect(out.content).toContain('title: "Specification"');
    expect(out.content).not.toContain("Contents:");
    expect(out.content).toContain("First paragraph.");
  });
  it("takes title and description from the page's frontmatter, drops the block from the body, and lets the menu override it", () => {
    const md = '---\ntitle: "Running it"\ndescription: "From the frontmatter."\ngroup: Running it\n---\n\n# Heading\n\nFirst paragraph.\n';
    const page = { file: "SERVER.md", slug: "server", label: "Server" };
    const out = preparePage(page, md, { base: "/", ref: "main", slugs, editBase: "" });
    expect(out.title).toBe("Running it");
    expect(out.description).toBe("From the frontmatter.");
    expect(out.content).not.toContain("group:");
    expect(out.content).not.toContain("# Heading");
    expect(preparePage({ ...page, title: "Menu title" }, md, { base: "/", ref: "main", slugs, editBase: "" }).title).toBe("Menu title");
  });
  it("marks an older version's page for the banner, and has no edit link", () => {
    const page = { file: "SERVER.md", slug: "server", label: "Server" };
    const out = preparePage(page, "no heading here\n", { base: "/1.2/", ref: "v1.2.2", slugs, editBase: "", older: true });
    expect(out.title).toBe("Server");
    expect(out.content).toContain('banner: {"content":"Older version"}');
    expect(out.content).not.toContain("editUrl");
  });
});

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "podium-site-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("prepareDocs", () => {
  it("writes the pages a version has, copies its static folders and reports both", () => {
    const root = tmp();
    const docs = path.join(root, "docs");
    fs.mkdirSync(path.join(docs, "standards"), { recursive: true });
    fs.mkdirSync(path.join(docs, "atlas"), { recursive: true });
    fs.mkdirSync(path.join(docs, "images"), { recursive: true });
    fs.writeFileSync(path.join(docs, "SERVER.md"), "# Server\n\nRun it. See [guide](USER_GUIDE.md).\n");
    fs.writeFileSync(path.join(docs, "USER_GUIDE.md"), "# Guide\n\nStart here.\n");
    fs.writeFileSync(path.join(docs, "standards/index.html"), "<html></html>");
    fs.mkdirSync(path.join(root, "frontend/src/fleet/admin"), { recursive: true });
    fs.writeFileSync(path.join(root, "frontend/src/fleet/tokens.css"), "t");
    fs.writeFileSync(path.join(root, "frontend/src/fleet/fleet.css"), "f");
    fs.writeFileSync(path.join(root, "frontend/src/fleet/admin/admin.css"), "a");
    fs.writeFileSync(path.join(docs, "atlas/podium-atlas.html"), "<html>atlas</html>");
    fs.writeFileSync(path.join(docs, "atlas/notes.txt"), "skipped");
    fs.writeFileSync(path.join(docs, "images/a.png"), "png");
    const contentDir = path.join(root, "content");
    const publicDir = path.join(root, "public");
    fs.mkdirSync(path.join(publicDir, "docs/standards"), { recursive: true });
    fs.writeFileSync(path.join(publicDir, "docs/standards/stale.html"), "old");
    fs.mkdirSync(contentDir, { recursive: true });
    fs.writeFileSync(path.join(contentDir, "stale.md"), "old");

    const out = prepareDocs({ docsDir: docs, contentDir, publicDir, base: "/", ref: "main", editBase: "e/", lastUpdatedOf: (f: string) => (f === "SERVER.md" ? "2026-10-22" : undefined) });

    expect((out.pages as { slug: string }[]).map((p) => p.slug)).toEqual(["user-guide", "server", "design-standards", "architecture-atlas"]);
    expect(out.statics).toEqual(["docs/standards", "atlas-map", "images"]);
    expect(fs.existsSync(path.join(contentDir, "stale.md"))).toBe(false);
    expect(fs.existsSync(path.join(publicDir, "docs/standards/stale.html"))).toBe(false);
    expect(fs.readFileSync(path.join(contentDir, "server.md"), "utf8")).toContain("[guide](/user-guide/)");
    expect(fs.readFileSync(path.join(publicDir, "atlas-map/index.html"), "utf8")).toBe("<html>atlas</html>");
    expect(fs.existsSync(path.join(publicDir, "atlas-map/notes.txt"))).toBe(false);
    expect(fs.existsSync(path.join(publicDir, "images/a.png"))).toBe(true);
    // the standards pages reach the app's stylesheets as ../../frontend/src/fleet/*.css from docs/standards/
    expect(fs.readFileSync(path.join(publicDir, "frontend/src/fleet/fleet.css"), "utf8")).toBe("f");
    expect(fs.readFileSync(path.join(publicDir, "frontend/src/fleet/admin/admin.css"), "utf8")).toBe("a");
    expect(fs.existsSync(path.join(publicDir, "docs/standards/index.html"))).toBe(true);
    // and each static page that exists is shown in a page of the site
    const embedded = fs.readFileSync(path.join(contentDir, "design-standards.md"), "utf8");
    expect(embedded).toContain('<iframe class="embed" src="/docs/standards/index.html"');
    expect(fs.readFileSync(path.join(contentDir, "architecture-atlas.md"), "utf8")).toContain('src="/atlas-map/index.html"');
    expect((out.pages as { slug: string }[]).map((p) => p.slug)).toContain("design-standards");
  });

  it("shows a static page in a frame under the version's base, without a table of contents", () => {
    const md = embedPage({ slug: "design-standards", src: "docs/standards/index.html", title: "Design standards", description: "d", frame: "Frame" }, "/1.2/");
    expect(md).toContain("tableOfContents: false");
    expect(md).toContain("lastUpdated: false");
    expect(md).toContain('src="/1.2/docs/standards/index.html" title="Frame"');
    expect(md).toContain('<a href="/1.2/docs/standards/index.html">Open this on its own page</a>');
    expect(md).not.toContain("site-frame-fix");
    expect(md).not.toContain("banner");
    // the framed page takes the site's theme, on load and when it changes
    expect(md).toContain("setAttribute('data-theme'");
    expect(md).toContain("MutationObserver");
  });

  it("marks an older version's frame page for the banner", () => {
    const md = embedPage({ slug: "s", src: "x.html", title: "S", description: "d", frame: "F" }, "/1.2/", true);
    expect(md).toContain('banner: {"content":"Older version"}');
  });

  it("adds a rule inside the frame for a page that needs one", () => {
    const md = embedPage({ slug: "s", src: "docs/standards/index.html", title: "S", description: "d", frame: "F", fix: ".s-sample .menubox { position: static; }" }, "/");
    expect(md).toContain("site-frame-fix");
    expect(md).toContain(".s-sample .menubox { position: static; }");
    expect(md).toContain("head:");
  });

  it("skips a folder an older release does not have", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/SERVER.md"), "# Server\n\nRun it.\n");
    const out = prepareDocs({ docsDir: path.join(root, "docs"), contentDir: path.join(root, "c"), publicDir: path.join(root, "p"), base: "/1.2/", ref: "v1.2.2", editBase: "", older: true });
    expect(out.pages).toHaveLength(1);
    expect(out.statics).toEqual([]);
    expect(fs.existsSync(path.join(root, "c/design-standards.md"))).toBe(false);
  });

  it("lists every page of the real docs exactly once, and keeps each page's group equal to the group the menu puts it in", () => {
    const { pages } = collectPages(path.resolve("..", "docs"));
    expect(new Set(pages.map((p: { slug: string }) => p.slug)).size).toBe(pages.length);
    expect(new Set(pages.map((p: { file: string }) => p.file)).size).toBe(pages.length);
    for (const p of pages as { file: string; group: string }[]) {
      const { fields } = parseFrontmatter(fs.readFileSync(path.resolve("..", "docs", p.file), "utf8"));
      expect(fields.group, p.file).toBe(p.group);
    }
  });
});

/** docs/ with one topic split into a folder: a README, an entry, and a subfolder with its own README and a page. */
function topicDocs() {
  const root = tmp();
  const put = (rel: string, fields: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, "docs", rel)), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", rel), `---\n${fields}\n---\n\n${body}`);
  };
  put("spec/README.md", 'title: "Spec"\ndescription: "The spec."\ngroup: Reference', "# Spec\n\nSee [one](01-one.md) and [deep](02-sub/02-01-deep.md).\n\n<!-- entries:start -->\n- x\n<!-- entries:end -->\n");
  put("spec/01-one.md", 'title: "1. One"\ndescription: "First."\ngroup: Reference\norder: 1', "# 1. One\n\nBack to [the spec](README.md).\n\n<!-- nav:start -->\n---\n\nUp: [Spec](README.md)\n<!-- nav:end -->\n");
  put("spec/02-sub/README.md", 'title: "2. The long title of the sub folder"\nsidebar_label: "2. Sub"\ndescription: "Sub."\ngroup: Reference\norder: 2', "# 2. The long title of the sub folder\n");
  put("spec/02-sub/02-01-deep.md", 'title: "2.1 Deep"\ndescription: "Deep."\ngroup: Reference\norder: 1', "# 2.1 Deep\n\nUp to [one](../01-one.md).\n");
  return root;
}

describe("a topic split into a folder (#697)", () => {
  it("expands the folder: the README first, entries in order, a subfolder as a group of its own", () => {
    const root = topicDocs();
    const { pages, sidebar } = collectPages(path.join(root, "docs"));
    expect(pages.filter((p: { group: string }) => p.group === "Reference").map((p: { slug: string }) => p.slug)).toEqual(["spec", "spec/01-one", "spec/02-sub", "spec/02-sub/02-01-deep"]);
    const ref = sidebar.find((g: { label: string }) => g.label === "Reference");
    expect(ref?.items[0]).toEqual({
      label: "Specification",
      collapsed: true,
      items: [
        { label: "Overview", slug: "spec" },
        { label: "1. One", slug: "spec/01-one" },
        { label: "2. Sub", collapsed: true, items: [{ label: "Overview", slug: "spec/02-sub" }, { label: "2.1 Deep", slug: "spec/02-sub/02-01-deep" }] },
      ],
    });
  });
  it("writes nested pages with links resolved between them, and no generated footer", () => {
    const root = topicDocs();
    const out = prepareDocs({ docsDir: path.join(root, "docs"), contentDir: path.join(root, "c"), publicDir: path.join(root, "p"), base: "/", ref: "main", editBase: "https://github.com/x/edit/dev/" });
    expect((out.pages as { slug: string }[]).map((p) => p.slug)).toEqual(["spec", "spec/01-one", "spec/02-sub", "spec/02-sub/02-01-deep"]);
    const readme = fs.readFileSync(path.join(root, "c/spec.md"), "utf8");
    expect(readme).toContain("[one](/spec/01-one/)");
    expect(readme).toContain("[deep](/spec/02-sub/02-01-deep/)");
    const one = fs.readFileSync(path.join(root, "c/spec/01-one.md"), "utf8");
    expect(one).toContain("[the spec](/spec/)");
    expect(one).not.toContain("Previous");
    expect(one).not.toContain("nav:start");
    expect(one).toContain('editUrl: "https://github.com/x/edit/dev/docs/spec/01-one.md"');
    expect(fs.readFileSync(path.join(root, "c/spec/02-sub/02-01-deep.md"), "utf8")).toContain("[one](/spec/01-one/)");
  });
  it("shows the single file of an older version as one page and leaves out a topic it does not have", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/SPEC.md"), "# SPEC: old\n\nThe old spec.\n");
    const { pages, sidebar } = collectPages(path.join(root, "docs"));
    expect(pages.map((p: { slug: string; file: string }) => [p.slug, p.file])).toEqual([["spec", "SPEC.md"]]);
    const shown = sidebar.flatMap((g: { items: { embed?: boolean }[] }) => g.items).filter((i: { embed?: boolean }) => !i.embed);
    expect(shown).toEqual([{ label: "Specification", slug: "spec" }]);
  });
  it("keeps a code block that follows a contents list, and does not take the contents line as a description", () => {
    expect(withoutContents("# T\n\nContents:\n\n- [a](#a)\n```sh\nrun it\n```\n")).toBe("# T\n\n```sh\nrun it\n```\n");
    const page = { file: "OLD.md", slug: "old", label: "Old" };
    const out = preparePage(page, "# Old\n\nContents:\n\n- [a](#a)\n\nThe real first paragraph.\n", { base: "/", ref: "main", slugs, editBase: "" });
    expect(out.description).toBe("The real first paragraph.");
  });
  it("cuts what is between two markers, and leaves a text without them alone", () => {
    expect(withoutBlock("a\n\n<!-- s -->\nx\n<!-- e -->\n\nb\n", "<!-- s -->", "<!-- e -->")).toBe("a\nb\n");
    expect(withoutBlock("no markers", "<!-- s -->", "<!-- e -->")).toBe("no markers");
  });
});

describe("llmsTxt", () => {
  it("lists each page with its address and description", () => {
    const txt = llmsTxt([{ slug: "server", title: "Running the server", description: "Start it." }], "https://example.test");
    expect(txt).toContain("# Podium");
    expect(txt).toContain("- [Running the server](https://example.test/server/): Start it.");
  });
});

describe("computeVersions", () => {
  const tags = ["v1.0.2", "v1.1.0", "v1.2.0", "v1.2.1", "v1.2.2", "v1.3.0", "v1.3.1", "not-a-tag", "v2.0.0-rc1"];
  it("builds the newest line from the working tree and each older line from its newest tag, back to the first line", () => {
    const v = computeVersions({ tags, headVersion: "1.3.1", firstLine: "1.1" });
    expect(v.map((x: { line: string }) => x.line)).toEqual(["1.3", "1.2", "1.1"]);
    expect(v[0]).toEqual({ line: "1.3", label: "1.3", latest: true, ref: null, base: "/" });
    expect(v[1]).toEqual({ line: "1.2", label: "1.2", latest: false, ref: "v1.2.2", base: "/1.2/" });
  });
  it("has only the newest line when the first line is the newest", () => {
    expect(computeVersions({ tags, headVersion: "1.3.0", firstLine: "1.3" })).toHaveLength(1);
  });
  it("orders lines numerically and does not list a line newer than the working tree", () => {
    const v = computeVersions({ tags: ["v1.9.0", "v1.10.0", "v1.11.0"], headVersion: "1.10.4", firstLine: "1.9" });
    expect(v.map((x: { line: string }) => x.line)).toEqual(["1.10", "1.9"]);
  });
});

describe("releaseUrl", () => {
  it("points the newest version at the latest release and an older one at its tag", () => {
    expect(releaseUrl({ latest: true, ref: null })).toBe("https://github.com/eengelking/podium/releases/latest");
    expect(releaseUrl({ latest: false, ref: "v1.2.2" })).toBe("https://github.com/eengelking/podium/releases/tag/v1.2.2");
  });
});
