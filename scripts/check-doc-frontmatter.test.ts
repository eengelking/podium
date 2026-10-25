import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { frontmatterProblems, parseFrontmatter } from "./docFrontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "check-doc-frontmatter.mjs");
const dir = mkdtempSync(join(tmpdir(), "docfm-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const page = (fields: string) => `---\n${fields}\n---\n\n# T\n\nBody.\n`;
const GOOD = 'title: "A page"\ndescription: One sentence.\ngroup: Reference';

function check(name: string, md: string) {
  const file = join(dir, name);
  writeFileSync(file, md);
  const r = spawnSync("node", [SCRIPT, file], { encoding: "utf8", timeout: 20000 });
  return { out: r.stdout, code: r.status };
}

describe("parseFrontmatter", () => {
  it("reads plain and quoted values and returns the body without the block", () => {
    const { fields, body } = parseFrontmatter(page('title: "Say \\"hi\\": now"\ndescription: Plain: value\ngroup: Reference'));
    expect(fields).toEqual({ title: 'Say "hi": now', description: "Plain: value", group: "Reference" });
    expect(body).toBe("# T\n\nBody.\n");
  });
  it("treats a doc without a closed block as having none", () => {
    expect(parseFrontmatter("# T\n").fields).toEqual({});
    expect(parseFrontmatter("---\ntitle: x\n# T\n").body).toBe("---\ntitle: x\n# T\n");
  });
  it("keeps a malformed quoted value as text and skips lines with no key", () => {
    expect(parseFrontmatter('---\ntitle: "open\n: nokey\n---\n').fields).toEqual({ title: '"open' });
    expect(parseFrontmatter('---\ntitle: "bad\\q"\n---\n').fields.title).toBe("bad\\q");
  });
});

describe("frontmatterProblems", () => {
  it("passes a page with all three fields", () => {
    expect(frontmatterProblems(page(GOOD))).toEqual([]);
  });
  it("reports each missing field", () => {
    expect(frontmatterProblems("# T\n")).toEqual(["missing title", "missing description", "missing group"]);
  });
  it("rejects a description over 160 characters and an unknown group", () => {
    const long = "x".repeat(161);
    const p = frontmatterProblems(page(`title: T\ndescription: ${long}\ngroup: Misc`));
    expect(p[0]).toContain("161 characters");
    expect(p[1]).toContain('group "Misc"');
  });
});

describe("check-doc-frontmatter.mjs", () => {
  it("passes a good page and fails a page that lacks the fields", () => {
    expect(check("ok.md", page(GOOD)).code).toBe(0);
    const r = check("bad.md", page('title: T\ngroup: Reference'));
    expect(r.out).toContain("missing description");
    expect(r.code).toBe(1);
  });
  it("passes for every page in docs/", () => {
    const r = spawnSync("node", [SCRIPT], { cwd: ROOT, encoding: "utf8" });
    expect(r.stdout).toContain("all ");
    expect(r.status).toBe(0);
  });
});
