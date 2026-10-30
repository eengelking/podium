import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildReporterZip, included, listFiles, zipBytes } from "./podium-reporter-zip.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "podium-reporter-zip.mjs");

/** The entries of a zip, read from its central directory: name to content. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.set(name, inflateRawSync(buf.subarray(start, start + size)));
    p += 46 + nameLen;
  }
  return out;
}

describe("podium-reporter-zip", () => {
  const version = JSON.parse(readFileSync(join(ROOT, "mod/podium-reporter/.claude-plugin/plugin.json"), "utf8")).version;

  it("is named for the version in plugin.json", () => {
    expect(buildReporterZip().name).toBe(`podium-reporter-${version}.zip`);
    expect(buildReporterZip(undefined, "-nightly-2026-10-30").name).toBe(`podium-reporter-${version}-nightly-2026-10-30.zip`);
  });

  it("has plugin.json and hooks.json at its root and no tests or .DS_Store", () => {
    const { files } = buildReporterZip();
    expect(files).toContain(".claude-plugin/plugin.json");
    expect(files).toContain("hooks/hooks.json");
    expect(files).toContain("hooks/register.ts");
    expect(files.some((f: string) => f.startsWith("podium-reporter/"))).toBe(false);
    expect(files.filter((f: string) => f.endsWith(".test.ts") || f.endsWith(".DS_Store"))).toEqual([]);
  });

  it("lists exactly the mod's files that are not tests, in the zip's central directory", () => {
    const zip = buildReporterZip();
    const entries = readZip(zip.bytes);
    expect([...entries.keys()]).toEqual(zip.files);
    expect(zip.files).toEqual(listFiles(join(ROOT, "mod/podium-reporter")));
    expect(entries.get(".claude-plugin/plugin.json")?.equals(readFileSync(join(ROOT, "mod/podium-reporter/.claude-plugin/plugin.json")))).toBe(true);
  });

  it("builds the same bytes twice", () => {
    expect(buildReporterZip().bytes.equals(buildReporterZip().bytes)).toBe(true);
  });

  it("is a zip the system unzip accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "reporter-zip-"));
    const file = execFileSync("node", [SCRIPT, "--out", dir], { encoding: "utf8" }).trim();
    expect(file).toBe(join(dir, `podium-reporter-${version}.zip`));
    const r = spawnSync("unzip", ["-tq", file], { encoding: "utf8" });
    if (r.error) return; // no unzip on this machine
    expect(r.status).toBe(0);
  });

  it("refuses when the version is not the one expected", () => {
    const r = spawnSync("node", [SCRIPT, "--out", mkdtempSync(join(tmpdir(), "reporter-zip-")), "--expect-version", "0.0.0"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`version ${version}, not 0.0.0`);
    expect(spawnSync("node", [SCRIPT, "--out", mkdtempSync(join(tmpdir(), "reporter-zip-")), "--expect-version", version]).status).toBe(0);
  });

  it("prints usage for --help and -h", () => {
    for (const flag of ["--help", "-h"]) expect(execFileSync("node", [SCRIPT, flag], { encoding: "utf8" })).toContain("Usage:");
  });

  it("skips tests and .DS_Store but not other files", () => {
    expect(included("hooks/a.test.ts")).toBe(false);
    expect(included("hooks/.DS_Store")).toBe(false);
    expect(included("hooks/a.ts")).toBe(true);
  });

  it("walks a folder in name order and writes a zip for a fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "reporter-zip-"));
    mkdirSync(join(dir, ".claude-plugin"));
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), '{"version":"9.9.9"}');
    writeFileSync(join(dir, "hooks", "b.ts"), "b");
    writeFileSync(join(dir, "hooks", "a.ts"), "a");
    writeFileSync(join(dir, "hooks", "a.test.ts"), "t");
    const zip = buildReporterZip(dir);
    expect(zip.name).toBe("podium-reporter-9.9.9.zip");
    expect(zip.files).toEqual([".claude-plugin/plugin.json", "hooks/a.ts", "hooks/b.ts"]);
    expect(readZip(zipBytes([["x/é.txt", Buffer.from("hi")]])).get("x/é.txt")?.toString()).toBe("hi");
  });
});
