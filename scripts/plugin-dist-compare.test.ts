import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { diffFiles, readDir, readZipEntries, run } from "./plugin-dist-compare.mjs";
import { zipBytes } from "./podium-reporter-zip.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "plugin-dist-compare-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

const files = { ".claude-plugin/plugin.json": '{"version":"1.0.0"}', "hooks/hooks.json": "{}", "plugin/core/a.ts": "export const a = 1;\n" };

/** A folder holding `content`, and a zip of `zipContent`, in a fresh case folder. */
function make(content: Record<string, string>, zipContent: Record<string, string> = files) {
  const dir = join(scratch, `c${++n}`);
  const folder = join(dir, "folder");
  for (const [name, data] of Object.entries(content)) {
    mkdirSync(join(folder, name, ".."), { recursive: true });
    writeFileSync(join(folder, name), data);
  }
  const zip = join(dir, "x.zip");
  writeFileSync(zip, zipBytes(Object.entries(zipContent).map(([k, v]) => [k, Buffer.from(v)])));
  return { folder, zip };
}

describe("plugin-dist-compare", () => {
  it("reads the entries of a zip", () => {
    const { zip } = make(files);
    const e = readZipEntries(readFileSync(zip));
    expect([...e.keys()].sort()).toEqual(Object.keys(files).sort());
  });

  it("agrees when the folder and the zip are equal", async () => {
    const { folder, zip } = make(files);
    const r = await run(["--zip", zip, "--dir", folder]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("agree");
  });

  it("fails on an extra file in the folder", async () => {
    const { folder, zip } = make({ ...files, "extra.ts": "x" });
    const r = await run(["--zip", zip, "--dir", folder]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("only in");
    expect(r.err).toContain("extra.ts");
  });

  it("fails on a file missing from the folder", async () => {
    const { folder, zip } = make({ ".claude-plugin/plugin.json": files[".claude-plugin/plugin.json"], "hooks/hooks.json": "{}" });
    const r = await run(["--zip", zip, "--dir", folder]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("only in the zip: plugin/core/a.ts");
  });

  it("fails on different bytes", async () => {
    const { folder, zip } = make({ ...files, "plugin/core/a.ts": "export const a = 2;\n" });
    const r = await run(["--zip", zip, "--dir", folder]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("different bytes: plugin/core/a.ts");
  });

  it("diffFiles and readDir work on maps", () => {
    const { folder } = make(files);
    expect(readDir(folder).size).toBe(3);
    expect(diffFiles(new Map(), new Map(), "x")).toEqual([]);
  });

  it("rejects bad arguments and prints help", async () => {
    expect((await run(["--zip"])).code).toBe(1);
    expect((await run(["--zip", "a"])).code).toBe(1);
    expect((await run(["--help"])).code).toBe(0);
    expect((await run(["--zip", join(scratch, "missing.zip"), "--dir", scratch])).code).toBe(1);
  });

  describe("against the tracked dist/ (#983)", () => {
    /** A fake repo root whose dist/<harness>/ holds `content`, and a zip of `zipContent`. */
    function repoWith(harness: string, content: Record<string, string>, zipContent: Record<string, string> = content) {
      const root = join(scratch, `r${++n}`);
      for (const [name, data] of Object.entries(content)) {
        mkdirSync(join(root, "dist", harness, name, ".."), { recursive: true });
        writeFileSync(join(root, "dist", harness, name), data);
      }
      const zip = join(root, "x.zip");
      writeFileSync(zip, zipBytes(Object.entries(zipContent).map(([k, v]) => [k, Buffer.from(v)])));
      return { root, zip };
    }

    it("compares the zip with dist/claudecode of the checkout by default", async () => {
      const { root, zip } = repoWith("claudecode", files);
      const r = await run(["--zip", zip], root);
      expect(r.code).toBe(0);
      expect(r.out).toContain("dist/claudecode");
    });

    it("compares with dist/<harness> for --harness", async () => {
      const { root, zip } = repoWith("opencode", { "package.json": "{}" });
      expect((await run(["--zip", zip, "--harness", "opencode"], root)).code).toBe(0);
      expect((await run(["--zip", zip], root)).code).toBe(1); // no dist/claudecode here
    });

    it("fails when dist/ differs from the zip, and names the file", async () => {
      const { root, zip } = repoWith("claudecode", { ...files, "plugin/core/a.ts": "changed\n" }, files);
      const r = await run(["--zip", zip], root);
      expect(r.code).toBe(1);
      expect(r.err).toContain("different bytes: plugin/core/a.ts");
    });

    it("no longer knows the plugin-dist branch options", async () => {
      const { root, zip } = repoWith("claudecode", files);
      for (const flag of ["--sha", "--branch", "--remote", "--wait", "--interval", "--grace", "--version"]) {
        const r = await run(["--zip", zip, flag, "x"], root);
        expect(r.code, flag).toBe(1);
        expect(r.err).toContain(`Bad argument "${flag}"`);
      }
    });

    it("runs from the command line", () => {
      const r = spawnSync("node", [join(ROOT, "scripts", "plugin-dist-compare.mjs"), "--help"], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("--zip");
      expect(r.stdout).not.toContain("plugin-dist branch");
    });
  });
});
