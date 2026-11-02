import { execFileSync, spawnSync } from "node:child_process";
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

  describe("against a plugin-dist branch", () => {
    const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }).trim();
    function setup(version = "1.0.0", message = "Publish\n\nSource commit: abc123\n") {
      const dir = join(scratch, `g${++n}`);
      const bare = join(dir, "o.git");
      const work = join(dir, "w");
      const check = join(dir, "c");
      mkdirSync(work, { recursive: true });
      mkdirSync(check);
      g(dir, "init", "-q", "--bare", bare);
      g(work, "init", "-q", "-b", "plugin-dist");
      g(work, "config", "user.email", "t@e.com");
      g(work, "config", "user.name", "T");
      for (const [name, data] of Object.entries(files)) {
        const p = join(work, "dist", "claudecode", name);
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, name.endsWith("plugin.json") ? JSON.stringify({ version }) : data);
      }
      g(work, "add", ".");
      g(work, "commit", "-q", "-m", message);
      g(work, "push", "-q", bare, "plugin-dist");
      g(check, "init", "-q");
      g(check, "remote", "add", "origin", bare);
      const zip = join(dir, "x.zip");
      const zipFiles = { ...files, ".claude-plugin/plugin.json": JSON.stringify({ version }) };
      writeFileSync(zip, zipBytes(Object.entries(zipFiles).map(([k, v]) => [k, Buffer.from(v)])));
      return { check, zip };
    }

    it("compares with the commit that names the source commit", async () => {
      const { check, zip } = setup();
      const r = await run(["--zip", zip, "--sha", "abc123", "--wait", "0"], check, () => {});
      expect(r.code).toBe(0);
    });

    it("fails with a clear message when no commit names the sha within the wait", async () => {
      const { check, zip } = setup();
      const r = await run(["--zip", zip, "--sha", "def456", "--wait", "0"], check, () => {});
      expect(r.code).toBe(1);
      expect(r.err).toContain("No plugin-dist commit naming def456 appeared");
    });

    it("falls back to the tip at the tag's version when a rerun published no commit", async () => {
      const { check, zip } = setup("2.0.0");
      const r = await run(["--zip", zip, "--sha", "def456", "--wait", "0", "--grace", "0", "--version", "2.0.0"], check, () => {});
      expect(r.code).toBe(0);
      const wrong = await run(["--zip", zip, "--sha", "def456", "--wait", "0", "--grace", "0", "--version", "3.0.0"], check, () => {});
      expect(wrong.code).toBe(1);
    });

    it("runs from the command line", () => {
      const { zip } = setup();
      const r = spawnSync("node", [join(ROOT, "scripts", "plugin-dist-compare.mjs"), "--help"], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(zip).toBeTruthy();
    });
  });
});
