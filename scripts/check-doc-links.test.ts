import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = new URL("./check-doc-links.mjs", import.meta.url).pathname;

function check(markdown: string) {
  const file = join(mkdtempSync(join(tmpdir(), "doc-links-")), "a.md");
  writeFileSync(file, markdown);
  const r = spawnSync("node", [script, file], { encoding: "utf8" });
  return { code: r.status, out: r.stdout };
}

describe("check-doc-links anchors", () => {
  it("prints its usage with --help", () => {
    expect(execFileSync("node", [script, "--help"], { encoding: "utf8" })).toContain("Usage:");
  });

  it("computes the plain anchor for a heading with a tag and inline code", () => {
    expect(check("## A <b>bold</b> `code`\n\n[x](#a-bold-code)\n").code).toBe(0);
  });

  it("leaves no tag text in an anchor when tags are nested", () => {
    // No "<script" or any other tag text may survive into the anchor, however the tags nest.
    expect(check("## Hi <<script>script>x<</script>/script>\n\n[x](#hi-scriptxscript)\n").code).toBe(0);
    expect(check("## Hi <<b>b>there\n\n[x](#hi-bthere)\n").code).toBe(0);
    expect(check("## Hi <scr<script>ipt>there\n\n[x](#hi-iptthere)\n").code).toBe(0);
  });

  it("reports an anchor that is not there", () => {
    const r = check("## Hi\n\n[x](#nope)\n");
    expect(r.code).toBe(1);
    expect(r.out).toContain("no anchor #nope");
  });
});
