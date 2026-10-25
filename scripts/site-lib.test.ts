// Tests for the docs site's page preparation and version choice (site/scripts/lib.mjs, #688).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeVersions, descriptionOf, frontmatter, llmsTxt, plain, prepareDocs, preparePage, releaseUrl, rewriteLinks, rewriteTarget, titleOf } from "../site/scripts/lib.mjs";
import { PAGES } from "../site/docs-nav.mjs";

const slugs = new Map<string, string>([
  ["SERVER.md", "server"],
  ["USER_GUIDE.md", "user-guide"],
  ["atlas/ATLAS.md", "atlas"],
]);
const ctx = { base: "/", ref: "main", fromDir: "", slugs };

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
    expect(rewriteTarget("standards/", ctx)).toBe("/standards/index.html");
    expect(rewriteTarget("standards/tokens.html#x", ctx)).toBe("/standards/tokens.html#x");
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
  it("marks an older version's page for the banner, and has no edit link", () => {
    const page = { file: "SERVER.md", slug: "server", label: "Server" };
    const out = preparePage(page, "no heading here\n", { base: "/1.2/", ref: "v1.2.2", slugs, editBase: "", older: true });
    expect(out.title).toBe("Server");
    expect(out.content).toContain('banner: {"content":"Older version"}');
    expect(out.content).not.toContain("editUrl");
  });
});

describe("prepareDocs", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "podium-site-test-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("writes the pages a version has, copies its static folders and reports both", () => {
    const root = tmp();
    const docs = path.join(root, "docs");
    fs.mkdirSync(path.join(docs, "standards"), { recursive: true });
    fs.mkdirSync(path.join(docs, "atlas"), { recursive: true });
    fs.mkdirSync(path.join(docs, "images"), { recursive: true });
    fs.writeFileSync(path.join(docs, "SERVER.md"), "# Server\n\nRun it. See [guide](USER_GUIDE.md).\n");
    fs.writeFileSync(path.join(docs, "USER_GUIDE.md"), "# Guide\n\nStart here.\n");
    fs.writeFileSync(path.join(docs, "standards/index.html"), "<html></html>");
    fs.writeFileSync(path.join(docs, "atlas/podium-atlas.html"), "<html>atlas</html>");
    fs.writeFileSync(path.join(docs, "atlas/notes.txt"), "skipped");
    fs.writeFileSync(path.join(docs, "images/a.png"), "png");
    const contentDir = path.join(root, "content");
    const publicDir = path.join(root, "public");
    fs.mkdirSync(path.join(publicDir, "standards"), { recursive: true });
    fs.writeFileSync(path.join(publicDir, "standards/stale.html"), "old");
    fs.mkdirSync(contentDir, { recursive: true });
    fs.writeFileSync(path.join(contentDir, "stale.md"), "old");

    const out = prepareDocs({ docsDir: docs, contentDir, publicDir, base: "/", ref: "main", editBase: "e/", lastUpdatedOf: (f: string) => (f === "SERVER.md" ? "2026-10-22" : undefined) });

    expect((out.pages as { slug: string }[]).map((p) => p.slug)).toEqual(["user-guide", "server"]);
    expect(out.statics).toEqual(["standards", "atlas-map", "images"]);
    expect(fs.existsSync(path.join(contentDir, "stale.md"))).toBe(false);
    expect(fs.existsSync(path.join(publicDir, "standards/stale.html"))).toBe(false);
    expect(fs.readFileSync(path.join(contentDir, "server.md"), "utf8")).toContain("[guide](/user-guide/)");
    expect(fs.readFileSync(path.join(publicDir, "atlas-map/index.html"), "utf8")).toBe("<html>atlas</html>");
    expect(fs.existsSync(path.join(publicDir, "atlas-map/notes.txt"))).toBe(false);
    expect(fs.existsSync(path.join(publicDir, "images/a.png"))).toBe(true);
  });

  it("skips a folder an older release does not have", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/SERVER.md"), "# Server\n\nRun it.\n");
    const out = prepareDocs({ docsDir: path.join(root, "docs"), contentDir: path.join(root, "c"), publicDir: path.join(root, "p"), base: "/1.2/", ref: "v1.2.2", editBase: "", older: true });
    expect(out.pages).toHaveLength(1);
    expect(out.statics).toEqual([]);
  });

  it("lists every page the nav names exactly once", () => {
    const pages = PAGES as unknown as { slug: string; file: string }[];
    const slugsSeen = pages.map((p) => p.slug);
    expect(new Set(slugsSeen).size).toBe(slugsSeen.length);
    expect(new Set(pages.map((p) => p.file)).size).toBe(pages.length);
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
