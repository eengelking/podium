import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// #487: the heading and link patterns in check-doc-links.mjs must stay linear on hostile input.
// #489: a tag nested inside another must not leave tag text in an anchor.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-doc-links.mjs");
const dir = mkdtempSync(join(tmpdir(), "doclinks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function check(name: string, md: string) {
  const file = join(dir, name);
  writeFileSync(file, md);
  const t = Date.now();
  const r = spawnSync("node", [SCRIPT, file], { encoding: "utf8", timeout: 20000 });
  return { out: r.stdout, code: r.status, ms: Date.now() - t };
}

describe("check-doc-links.mjs", () => {
  it("resolves a link to a heading, closing hashes and link text included", () => {
    const { out } = check("ok.md", "# Title ##\n\n## See [the guide](ok.md) now\n\n[a](#title) [b](#see-the-guide-now)\n");
    expect(out).toContain("all links ok");
  });

  it("reports a link to a heading that is not there", () => {
    const r = check("bad.md", "# Title\n\n[a](#nope)\n");
    expect(r.out).toContain("no anchor #nope");
    expect(r.code).toBe(1);
  });

  it("keeps a hash that is part of the heading text", () => {
    expect(check("hash.md", "# C # sharp\n\n[a](#c--sharp)\n").out).toContain("all links ok");
  });

  it("computes the plain anchor for a heading with a tag and inline code", () => {
    expect(check("tag.md", "## A <b>bold</b> `code`\n\n[x](#a-bold-code)\n").code).toBe(0);
  });

  it("leaves no tag text in an anchor when tags are nested", () => {
    // No "<script" or any other tag text may survive into the anchor, however the tags nest.
    expect(check("nest1.md", "## Hi <<script>script>x<</script>/script>\n\n[x](#hi-scriptxscript)\n").code).toBe(0);
    expect(check("nest2.md", "## Hi <<b>b>there\n\n[x](#hi-bthere)\n").code).toBe(0);
    expect(check("nest3.md", "## Hi <scr<script>ipt>there\n\n[x](#hi-iptthere)\n").code).toBe(0);
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
