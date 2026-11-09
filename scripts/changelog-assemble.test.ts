// Changelog fragments (DECISIONS 67): a PR adds changelog.d/<issue-or-slug>.<type>.md and release-prep folds them into [Unreleased].
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { assemble, parseName, readFragments } from "./changelog-assemble.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "changelog-assemble.mjs");
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(files: Record<string, string>, changelog: string): string {
  const root = mkdtempSync(join(tmpdir(), "changelog-"));
  made.push(root);
  mkdirSync(join(root, "changelog.d"));
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "changelog.d", name), text);
  return root;
}
const run = (root: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" });

const BASE = `# Changelog\n\n## [Unreleased]\n\n### Added\n\n- old one\n\n### Fixed\n\n- old fix\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- shipped\n`;
const frag = (id: string, type: string, text: string) => ({ id, type, file: `${id}.${type}.md`, text });

describe("parseName", () => {
  it("accepts an issue number or a slug with a known type", () => {
    expect(parseName("1066.added.md")).toEqual({ id: "1066", type: "added" });
    expect(parseName("login-redirect.fixed.md")).toEqual({ id: "login-redirect", type: "fixed" });
    expect(parseName("12.standards.md")).toEqual({ id: "12", type: "standards" });
  });
  it("refuses a bad type, no type or the wrong extension", () => {
    for (const bad of ["12.feature.md", "12.md", "12.added.txt", "Added.added.md", "12.added.md.bak"]) expect(parseName(bad)).toBeNull();
  });
});

describe("assemble", () => {
  it("appends to an existing subsection and leaves the released sections alone", () => {
    const out = assemble(BASE, [frag("1", "added", "new one"), frag("2", "fixed", "new fix")]);
    expect(out).toContain("### Added\n\n- old one\n- new one\n\n### Fixed\n\n- old fix\n- new fix\n\n## [1.0.0]");
    expect(out.endsWith("- shipped\n")).toBe(true);
  });
  it("creates a missing subsection in Keep a Changelog order", () => {
    const out = assemble(BASE, [frag("1", "changed", "tweak"), frag("2", "removed", "gone")]);
    expect(out.indexOf("### Added")).toBeLessThan(out.indexOf("### Changed"));
    expect(out.indexOf("### Changed")).toBeLessThan(out.indexOf("### Removed"));
    expect(out.indexOf("### Removed")).toBeLessThan(out.indexOf("### Fixed"));
    expect(out).toContain("### Changed\n\n- tweak\n\n### Removed\n\n- gone\n\n### Fixed");
  });
  it("adds a subsection at the end of an empty [Unreleased]", () => {
    const out = assemble("# C\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n", [frag("1", "added", "first")]);
    expect(out).toBe("# C\n\n## [Unreleased]\n\n### Added\n\n- first\n\n## [1.0.0] - 2026-01-01\n");
  });
  it("works when [Unreleased] is the last section", () => {
    expect(assemble("## [Unreleased]\n", [frag("1", "fixed", "x")])).toBe("## [Unreleased]\n\n### Fixed\n\n- x\n");
  });
  it("writes a standards fragment as a Standards: line under Changed, and indents a second line", () => {
    const out = assemble(BASE, [frag("3", "standards", "a token, approved by the maintainer"), frag("4", "added", "line one\nline two")]);
    expect(out).toContain("### Changed\n\n- Standards: a token, approved by the maintainer");
    expect(out).toContain("- line one\n  line two");
  });
  it("puts a new subsection before a heading that is not on the list", () => {
    const out = assemble("## [Unreleased]\n\n### Fixed\n\n- f\n\n### Not in this release\n\n- n\n", [frag("1", "added", "a")]);
    expect(out.indexOf("### Added")).toBeLessThan(out.indexOf("### Fixed"));
    expect(out.indexOf("### Fixed")).toBeLessThan(out.indexOf("### Not in this release"));
  });
  it("finds a subsection heading in a file with CRLF line endings instead of adding a second one", () => {
    const out = assemble(BASE.replace(/\n/g, "\r\n"), [frag("1", "added", "new one")]);
    expect(out.match(/### Added/g)).toHaveLength(2); // the [Unreleased] one and the released one
    expect(out).toContain("- old one\r\n- new one");
  });
  it("throws with no [Unreleased] section", () => {
    expect(() => assemble("# C\n", [frag("1", "added", "a")])).toThrow(/no \[Unreleased\]/);
  });
});

describe("readFragments", () => {
  it("orders by file name with numbers as numbers, and skips the README", () => {
    const root = repo({ "10.added.md": "ten", "9.added.md": "nine", "README.md": "# about" }, BASE);
    expect(readFragments(join(root, "changelog.d")).fragments.map((f) => f.id)).toEqual(["9", "10"]);
  });
  it("reports a bad name, an empty file and a leading bullet", () => {
    const root = repo({ "1.nope.md": "x", "2.added.md": "  \n", "3.fixed.md": "- already a bullet" }, BASE);
    expect(readFragments(join(root, "changelog.d")).problems).toHaveLength(3);
  });
  it("takes the text of a fragment saved with CRLF line endings without the carriage returns", () => {
    const root = repo({ "1.added.md": "line one\r\nline two\r\n" }, BASE);
    expect(readFragments(join(root, "changelog.d")).fragments[0].text).toBe("line one\nline two");
  });
  it("finds nothing when the folder is missing", () => {
    expect(readFragments(join(tmpdir(), "no-such-changelog-d"))).toEqual({ fragments: [], problems: [] });
  });
});

describe("the command", () => {
  it("assembles, rewrites CHANGELOG.md and deletes the fragments", () => {
    const root = repo({ "1.added.md": "new one" }, BASE);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain("- old one\n- new one");
    expect(existsSync(join(root, "changelog.d", "1.added.md"))).toBe(false);
  });
  it("--check changes nothing", () => {
    const root = repo({ "1.added.md": "new one" }, BASE);
    const r = run(root, "--check");
    expect(r.status).toBe(0);
    expect(existsSync(join(root, "changelog.d", "1.added.md"))).toBe(true);
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(BASE);
  });
  it("fails and names a bad fragment, in both modes", () => {
    const root = repo({ "1.nope.md": "x" }, BASE);
    for (const args of [[], ["--check"]]) {
      const r = run(root, ...args);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("1.nope.md");
    }
  });
  it("--root with no folder says so and exits 1", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--root"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--root needs a folder");
  });
  it("says so when there is nothing to assemble, and prints --help", () => {
    expect(run(repo({}, BASE)).stdout).toContain("No fragments");
    expect(run(repo({}, BASE), "--help").stdout).toContain("Usage:");
  });
});

describe("the fragments in this repository", () => {
  it("all have a valid name, a known type and some text", () => {
    const { problems } = readFragments(join(HERE, "..", "changelog.d"));
    expect(problems).toEqual([]);
  });
});
