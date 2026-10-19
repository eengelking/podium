import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// #487: the heading and link patterns in check-doc-links.mjs must stay linear on hostile input.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-doc-links.mjs");
const dir = mkdtempSync(join(tmpdir(), "doclinks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function check(name: string, md: string) {
  const file = join(dir, name);
  writeFileSync(file, md);
  const t = Date.now();
  const r = spawnSync("node", [SCRIPT, file], { encoding: "utf8", timeout: 20000 });
  return { out: r.stdout, ms: Date.now() - t };
}

describe("check-doc-links.mjs", () => {
  it("resolves a link to a heading, closing hashes and link text included", () => {
    const { out } = check("ok.md", "# Title ##\n\n## See [the guide](ok.md) now\n\n[a](#title) [b](#see-the-guide-now)\n");
    expect(out).toContain("all links ok");
  });

  it("reports a link to a heading that is not there", () => {
    expect(check("bad.md", "# Title\n\n[a](#nope)\n").out).toContain("no anchor #nope");
  });

  it("keeps a hash that is part of the heading text", () => {
    expect(check("hash.md", "# C # sharp\n\n[a](#c--sharp)\n").out).toContain("all links ok");
  });

  it("finishes quickly on a heading with a long run of spaces", () => {
    const { out, ms } = check("spaces.md", `# a${" ".repeat(60000)}b\n\n[a](#a)\n`);
    expect(out).toContain("no anchor #a");
    expect(ms).toBeLessThan(5000);
  });

  it("finishes quickly on a heading with many unclosed brackets", () => {
    const { ms } = check("brackets.md", `# ${"[".repeat(60000)}\n\n[a](#a)\n`);
    expect(ms).toBeLessThan(5000);
  });

  it("finishes quickly on a heading with many link-like starts and no end", () => {
    const { ms } = check("links.md", `# ${"[a](".repeat(30000)}\n\n[a](#a)\n`);
    expect(ms).toBeLessThan(5000);
  });
});
