import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { run, scan } from "./promise-misuse.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "promise-misuse.mjs");
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const PRELUDE = "declare const p: Promise<number>;\ndeclare const q: Promise<number> | undefined;\ndeclare function work(): Promise<void>;\n";

/** A throwaway project (its own tsconfig) holding the given files; returns the tsconfig path. */
function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "promisemisuse-"));
  made.push(root);
  const config = { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true, lib: ["ES2023"], types: [] }, include: ["*.ts"] };
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify(config));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return join(root, "tsconfig.json");
}

/** The findings of one source, as "line kind". */
function kinds(source: string, tests = false, name = "a.ts") {
  const tsconfig = project({ [name]: PRELUDE + source });
  return scan(tsconfig, { tests }).map((f: { line: number; kind: string }) => `${f.line - 3} ${f.kind}`);
}

describe("scan: one case per kind", () => {
  it("reports a Promise in an if, while, for or do condition", () => {
    expect(kinds("if (p) {}")).toEqual(["1 condition"]);
    expect(kinds("while (p) { break; }")).toEqual(["1 condition"]);
    expect(kinds("for (; p; ) { break; }")).toEqual(["1 condition"]);
    expect(kinds("do { break; } while (p);")).toEqual(["1 condition"]);
  });
  it("reports a Promise as a ternary condition", () => {
    expect(kinds("export const x = p ? 1 : 2;")).toEqual(["1 condition"]);
  });
  it("reports a Promise under !", () => {
    expect(kinds("export const x = !p;")).toEqual(["1 negated"]);
  });
  it("reports a Promise as the left operand of &&, || and ??", () => {
    expect(kinds("export const a = p && 1;")).toEqual(["1 logical-operand"]);
    expect(kinds("export const a = p || 1;")).toEqual(["1 logical-operand"]);
    expect(kinds("export const a = p ?? 1;")).toEqual(["1 logical-operand"]);
  });
  it("reports a Promise as an operand of a comparison, on either side", () => {
    expect(kinds("export const a = p === 1;")).toEqual(["1 comparison"]);
    expect(kinds("export const a = 1 != p;")).toEqual(["1 comparison"]);
    expect(kinds("export const a = 1 < p;")).toEqual(["1 comparison"]);
  });
  it("reports an expression statement that is not awaited, returned, voided or caught", () => {
    expect(kinds("work();")).toEqual(["1 floating"]);
    expect(kinds("work().then(() => 1);")).toEqual(["1 floating"]);
    expect(kinds("work().finally(() => 1);")).toEqual(["1 floating"]);
  });
  it("reports a dropped Promise in a branch of a ternary or the right side of &&, || and ??", () => {
    expect(kinds("export function f(c: boolean) {\n  c && work();\n}")).toEqual(["2 floating"]);
    expect(kinds("export function f(c: boolean) {\n  c ? work() : undefined;\n}")).toEqual(["2 floating"]);
    expect(kinds("export function f(c: boolean) {\n  c || work();\n}")).toEqual(["2 floating"]);
    expect(kinds("export function f(c: boolean) {\n  c && work().catch(() => 1);\n}")).toEqual([]);
  });
  it("leaves handled statements alone", () => {
    const source = [
      "export async function f() {",
      "  await work();",
      "  void work();",
      "  work().catch(() => 1);",
      "  work().then(() => 1).catch(() => 1);",
      "  work().catch(() => 1).finally(() => 1);",
      "  work().then(() => 1, () => 2);",
      "  const kept = work();",
      "  let again = kept;",
      "  again = work();",
      "  return work();",
      "}",
    ].join("\n");
    expect(kinds(source)).toEqual([]);
  });
  it("is clean on code that awaits and on an optional Promise tested for undefined", () => {
    const source = "export async function f() {\n  if (await p) return 1;\n  const x = (await p) ?? 2;\n  return q ?? x;\n}\n";
    expect(kinds(source)).toEqual([]);
  });
  it("leaves test files out unless --tests is given", () => {
    expect(kinds("work();", false, "a.test.ts")).toEqual([]);
    expect(kinds("work();", true, "a.test.ts")).toEqual(["1 floating"]);
  });
  it("reports the file, the line and the source text", () => {
    const tsconfig = project({ "a.ts": PRELUDE + "work();\n" });
    const [finding] = scan(tsconfig, { tests: false });
    expect(relative(dirname(tsconfig), finding.file)).toBe("a.ts");
    expect([finding.line, finding.kind, finding.text]).toEqual([4, "floating", "work()"]);
  });
});

describe("scan: the promise-ok comment", () => {
  it("allows a finding from the same line or the previous line when it gives a reason", () => {
    expect(kinds("work(); // promise-ok: a fire-and-forget continuation")).toEqual([]);
    expect(kinds("// promise-ok: a fire-and-forget continuation\nwork();")).toEqual([]);
  });
  it("does not allow a finding two lines away, and reports the stale comment", () => {
    expect(kinds("// promise-ok: too far\n\nwork();")).toEqual(["1 unused-allow", "3 floating"]);
  });
  it("reports a comment without a reason, and still reports the finding", () => {
    expect(kinds("work(); // promise-ok")).toEqual(["1 missing-reason", "1 floating"]);
    expect(kinds("work(); // promise-ok:")).toEqual(["1 missing-reason", "1 floating"]);
    expect(kinds("work(); // promise-ok:   ")).toEqual(["1 missing-reason", "1 floating"]);
  });
  it("reports a comment that allows nothing", () => {
    expect(kinds("export const a = 1; // promise-ok: nothing here")).toEqual(["1 unused-allow"]);
  });
  it("does not read the text of a string as a comment", () => {
    expect(kinds('export const s = "// promise-ok";\nexport const t = `\n// promise-ok\n`;')).toEqual([]);
  });
  it("accepts a block comment", () => {
    expect(kinds("work(); /* promise-ok: reason */")).toEqual([]);
    expect(kinds("work(); /* promise-ok: reason\n   on a second line */")).toEqual([]);
    expect(kinds("work(); // promise-ok because")).toEqual(["1 missing-reason", "1 floating"]);
    expect(kinds("work(); // promise-okay: a longer word is not the marker")).toEqual(["1 floating"]);
    expect(kinds("work(); // promise-ok-ish")).toEqual(["1 missing-reason", "1 floating"]);
  });
});

describe("run", () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, write: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) } };
  };
  it("prints usage and exits 0 for --help and -h", () => {
    for (const flag of ["--help", "-h"]) {
      const c = capture();
      expect(run([flag], c.write)).toBe(0);
      expect(c.out.join("\n")).toContain("Usage: node scripts/promise-misuse.mjs <tsconfig> [--tests]");
    }
  });
  it("prints usage and exits 2 with no tsconfig", () => {
    const c = capture();
    expect(run([], c.write)).toBe(2);
    expect(c.err.join("\n")).toContain("Usage:");
  });
  it("exits 2 for an unknown flag and for a tsconfig that is not there", () => {
    const c = capture();
    expect(run(["--nope", "x"], c.write)).toBe(2);
    expect(run([join(tmpdir(), "no-such-dir", "tsconfig.json")], c.write)).toBe(2);
  });
  it("exits 2, and does not say there are no findings, for a tsconfig that matches no source file", () => {
    const tsconfig = project({});
    expect(() => scan(tsconfig)).toThrow(/no source files/);
    const c = capture();
    expect(run([tsconfig], c.write)).toBe(2);
    expect(c.err.join("\n")).toContain("no source files");
    expect(c.out.join("\n")).not.toContain("no findings");
  });
  it("exits 1 and prints file:line: kind: text for a finding", () => {
    const tsconfig = project({ "a.ts": PRELUDE + "work();\n" });
    const c = capture();
    expect(run([tsconfig], c.write)).toBe(1);
    expect(c.out.join("\n")).toMatch(/a\.ts:4: floating: work\(\)/);
    expect(c.out.join("\n")).toContain("1 finding");
  });
  it("exits 0 when clean", () => {
    const tsconfig = project({ "a.ts": PRELUDE + "export const ok = work().catch(() => 1);\n" });
    const c = capture();
    expect(run([tsconfig], c.write)).toBe(0);
    expect(c.out.join("\n")).toContain("no findings");
  });
  it("passes --tests through", () => {
    const tsconfig = project({ "a.test.ts": PRELUDE + "work();\n" });
    expect(run([tsconfig], capture().write)).toBe(0);
    expect(run([tsconfig, "--tests"], capture().write)).toBe(1);
  });
});

describe("the command line", () => {
  it("exits 0 for --help, 2 for no argument, 1 for a finding and 0 when clean", () => {
    const go = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    expect(go("--help").status).toBe(0);
    expect(go("--help").stdout).toContain("Usage:");
    const none = go();
    expect([none.status, none.stderr]).toEqual([2, expect.stringContaining("Usage:")]);
    const bad = go(project({ "a.ts": PRELUDE + "work();\n" }));
    expect([bad.status, bad.stdout]).toEqual([1, expect.stringMatching(/a\.ts:4: floating: work\(\)/)]);
    expect(go(project({ "a.ts": "export const ok = 1;\n" })).status).toBe(0);
  });
});
