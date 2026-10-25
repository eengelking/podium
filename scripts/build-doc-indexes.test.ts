import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { entriesMarkdown, navMarkdown, replaceBetween, topicDirs, topicEntries } from "./docTopics.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "build-doc-indexes.mjs");
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const page = (fields: Record<string, string | number>, body = "# T\n\nBody.\n", marker = true) =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n${body}${marker ? "\n<!-- nav:start -->\n<!-- nav:end -->\n" : ""}`;

/** docs/things/README.md with two entries and a subfolder, plus a folder that must be skipped. */
function tree(style = "list") {
  const root = mkdtempSync(join(tmpdir(), "doctopics-"));
  made.push(root);
  mkdirSync(join(root, "things/sub"), { recursive: true });
  mkdirSync(join(root, "templates"));
  writeFileSync(join(root, "templates/README.md"), "# not a topic\n");
  writeFileSync(join(root, "things/README.md"), page({ title: "Things", description: "d", entries: style }, "# Things\n\n<!-- entries:start -->\n<!-- entries:end -->\n", false));
  writeFileSync(join(root, "things/b.md"), page({ title: "Second", description: "The b page.", order: 2, status: "accepted", date: "2026-01-02", area: "B area" }));
  writeFileSync(join(root, "things/a.md"), page({ title: "First", description: "The a | page.", order: 1, status: "accepted", date: "2026-01-01", area: "A area" }));
  writeFileSync(join(root, "things/sub/README.md"), page({ title: "Sub", description: "The sub folder.", order: 3 }, "# Sub\n"));
  writeFileSync(join(root, "things/sub/c.md"), page({ title: "Third", description: "The c page.", order: 1 }));
  return root;
}
const run = (root: string, ...args: string[]) => spawnSync("node", [SCRIPT, "--root", root, ...args], { encoding: "utf8" });

describe("docTopics", () => {
  it("finds folders with a README.md and skips the generated and example ones", () => {
    expect(topicDirs(tree())).toEqual(["things", "things/sub"]);
  });
  it("orders entries by order, then name, and lists a subfolder by its README", () => {
    const e = topicEntries(tree(), "things");
    expect(e.map((x: { link: string }) => x.link)).toEqual(["a.md", "b.md", "sub/README.md"]);
    expect(e[2].isFolder).toBe(true);
  });
  it("puts an entry with no order after the ones that have one", () => {
    const root = tree();
    writeFileSync(join(root, "things/0.md"), page({ title: "Z", description: "z" }));
    expect(topicEntries(root, "things").map((x: { name: string }) => x.name)).toEqual(["a.md", "b.md", "sub", "0.md"]);
  });
  it("writes a list, a table with the pipe escaped, and entries grouped by area", () => {
    const e = topicEntries(tree(), "things").slice(0, 2);
    expect(entriesMarkdown(undefined, e)).toBe("- [First](a.md): The a | page.\n- [Second](b.md): The b page.");
    expect(entriesMarkdown("table", e)).toContain("| [First](a.md) | accepted | 2026-01-01 | The a \\| page. |");
    expect(entriesMarkdown("by-area", e)).toContain("**A area**\n\n- [First](a.md)");
    expect(entriesMarkdown("by-area", [{ link: "x.md", fields: { title: "X", description: "x" } }])).toContain("**Other**");
  });
  it("replaces between markers and leaves text without them alone", () => {
    expect(replaceBetween("a<!--s-->old<!--e-->z", "<!--s-->", "<!--e-->", "new")).toBe("a<!--s-->\nnew\n<!--e-->z");
    expect(replaceBetween("no markers", "<!--s-->", "<!--e-->", "new")).toBe("no markers");
  });
  it("writes previous, up and next, leaving out a side that is missing", () => {
    expect(navMarkdown({ prev: { fields: { title: "P" }, href: "p.md" }, next: { fields: { title: "N" }, href: "n.md" }, upTitle: "U" })).toBe("---\n\nPrevious: [P](p.md) · Up: [U](README.md) · Next: [N](n.md)");
    expect(navMarkdown({ prev: null, next: null, upTitle: "U" })).toBe("---\n\nUp: [U](README.md)");
  });
});

describe("build-doc-indexes.mjs", () => {
  it("writes the entry list and the footers, then reports nothing out of date", () => {
    const root = tree("table");
    expect(run(root, "--check").status).toBe(1);
    expect(run(root).status).toBe(0);
    const readme = readFileSync(join(root, "things/README.md"), "utf8");
    expect(readme).toContain("| [First](a.md) | accepted | 2026-01-01 |");
    expect(readme).toContain("[Sub](sub/README.md)");
    expect(readFileSync(join(root, "things/b.md"), "utf8")).toContain("Previous: [First](a.md) · Up: [Things](README.md) · Next: [Sub](sub/README.md)");
    expect(readFileSync(join(root, "things/sub/README.md"), "utf8")).toContain("Previous: [Second](../b.md) · Up: [Things](../README.md)");
    expect(readFileSync(join(root, "things/sub/c.md"), "utf8")).toContain("Up: [Sub](README.md)");
    const again = run(root, "--check");
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("up to date");
  });
  it("with --only touches that folder and nothing else", () => {
    const root = tree();
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "other/README.md"), page({ title: "Other", description: "d" }, "# O\n\n<!-- entries:start -->\n<!-- entries:end -->\n", false));
    writeFileSync(join(root, "other/x.md"), page({ title: "X", description: "x", order: 1 }));
    expect(run(root, "--only", "other/").status).toBe(0);
    expect(readFileSync(join(root, "other/README.md"), "utf8")).toContain("[X](x.md)");
    expect(readFileSync(join(root, "things/README.md"), "utf8")).not.toContain("[First]");
  });
  it("finds every generated list and footer in this repository's docs up to date", () => {
    const r = spawnSync("node", [SCRIPT, "--root", join(dirname(SCRIPT), "..", "docs"), "--check"], { encoding: "utf8" });
    expect(r.stdout.split("\n").filter((l) => l.includes("out of date,")), "run node scripts/build-doc-indexes.mjs").toEqual([]);
    expect(r.status).toBe(0);
  });
  it("fails when the docs folder is missing and prints help", () => {
    expect(run("/nonexistent-docs-folder").status).toBe(1);
    expect(spawnSync("node", [SCRIPT, "--help"], { encoding: "utf8" }).stdout).toContain("Usage:");
  });
});
