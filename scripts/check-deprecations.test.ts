import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { deprecatedRows, deprecationProblems, run } from "./check-deprecations.mjs";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const page = (rows: string[]) =>
  `---\ntitle: "D"\n---\n\n## Deprecated now\n\n| Feature | Announced | Removed | Use instead |\n|---|---|---|---|\n${rows.join("\n")}\n\n## Removed\n\n| Old | 1.1 | 1.2 | x |\n`;

function repo(version: string, rows: string[], text?: string) {
  const root = mkdtempSync(join(tmpdir(), "deprec-"));
  made.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  if (text !== null) writeFileSync(join(root, "docs/DEPRECATIONS.md"), text ?? page(rows));
  return root;
}

const ROW = "| [Tokens over HTTP](#x) | 1.5 | 1.8 | TLS |";

describe("deprecatedRows", () => {
  it("reads the table under Deprecated now and not the one under Removed", () => {
    expect(deprecatedRows(page([ROW]))?.map((r) => [r.feature, r.announced, r.removed])).toEqual([["[Tokens over HTTP](#x)", "1.5", "1.8"]]);
  });
  it("is null with no such section", () => {
    expect(deprecatedRows("# Nothing\n")).toBeNull();
  });
});

describe("deprecationProblems", () => {
  it("passes when removal is still ahead", () => {
    expect(deprecationProblems(repo("1.5.0", [ROW]))).toEqual([]);
    expect(deprecationProblems(repo("1.7.3", [ROW]))).toEqual([]);
  });
  it("fails when the version reaches the removal release, and after it", () => {
    expect(deprecationProblems(repo("1.8.0", [ROW]))[0]).toMatch(/removal is due in 1\.8 and the version is 1\.8/);
    expect(deprecationProblems(repo("2.0.0", [ROW]))).toHaveLength(1);
  });
  it("passes with nothing listed", () => {
    expect(deprecationProblems(repo("1.8.0", []))).toEqual([]);
  });
  it("fails a removal more than three minor releases out, one that is not after the announcement, and another major", () => {
    expect(deprecationProblems(repo("1.5.0", ["| a | 1.5 | 1.9 | x |"]))[0]).toMatch(/more than 3 minor/);
    expect(deprecationProblems(repo("1.5.0", ["| a | 1.5 | 1.5 | x |"]))[0]).toMatch(/must be after/);
    expect(deprecationProblems(repo("1.5.0", ["| a | 1.5 | 2.1 | x |"]))[0]).toMatch(/another major/);
  });
  it("fails a version that is not MAJOR.MINOR", () => {
    expect(deprecationProblems(repo("1.5.0", ["| a | v1.5 | 1.8 | x |"]))[0]).toMatch(/must each be MAJOR\.MINOR/);
  });
  it("fails a missing file and a missing section", () => {
    expect(deprecationProblems(repo("1.5.0", [], null as unknown as string))[0]).toMatch(/file is missing/);
    expect(deprecationProblems(repo("1.5.0", [], "# x\n"))[0]).toMatch(/no "Deprecated now"/);
  });
});

describe("run", () => {
  it("exits 1 with the problems and 0 when clean, and prints help", () => {
    expect(run(["--root", repo("1.8.0", [ROW])], "/").code).toBe(1);
    expect(run(["--root", repo("1.5.0", [ROW])], "/").code).toBe(0);
    expect(run(["--help"], "/").out).toMatch(/^Usage:/);
  });
});

describe("this repository", () => {
  it("lists no removal that is due (a release cannot go out with one)", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    expect(deprecationProblems(root)).toEqual([]);
  });
});
