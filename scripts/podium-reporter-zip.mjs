#!/usr/bin/env node
// Zips a built plugin folder, dist/<harness>/, into podium-reporter-<version>.zip (#835, #927). Claude Desktop's plugin dialog
// takes only an archive, so every release carries one. CI (release.yml, nightly.yml) and a person run this same script after
// `node scripts/plugin-build.mjs`. It writes the zip itself with node:zlib, so a runner needs no zip tool, and the same tree
// gives the same bytes. It zips exactly the files the build wrote (the build already left out tests and .DS_Store).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { checkTree, HARNESSES, walk } from "./plugin-build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The archive's name stem for each harness. */
const NAMES = { claudecode: "podium-reporter", opencode: "podium-opencode" };

const USAGE = `Usage: node scripts/podium-reporter-zip.mjs [--harness <claudecode|opencode>] [--out <dir>] [--suffix <text>] [--expect-version <x.y.z>] [--src <dir>]

Zips the built folder dist/<harness>/ into <dir>/<name>-<version>[<suffix>].zip and prints the path. Run
\`node scripts/plugin-build.mjs\` first; this script fails when the folder is missing or not self-contained.
  --harness        which plugin (default claudecode). Names: claudecode is podium-reporter, opencode is podium-opencode.
  <version>        the version in the built folder's .claude-plugin/plugin.json
  --out <dir>      where to write the zip (default: the current directory; never inside the built folder)
  --suffix <text>  appended to the name before .zip, e.g. -nightly-2026-10-30
  --expect-version fail unless <version> equals this (a tag's number, without the v)
  --src <dir>      zip this folder instead of dist/<harness>/ (for tests)
The archive has .claude-plugin/plugin.json and hooks/hooks.json at its root.`;

/** Every file under `dir` as a path relative to it with forward slashes, in a fixed order. */
export function listFiles(dir) {
  return walk(dir);
}

/** The zip file for `files` (name to bytes), with a fixed timestamp so a rebuild is identical. */
export function zipBytes(files) {
  const time = 0;
  const date = (1 << 5) | 1; // 1980-01-01
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name);
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x031e, 4); // made by Unix, spec 3.0
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** The archive of the built folder `srcDir`: its name, version, file list and bytes. */
export function buildReporterZip(srcDir, suffix = "", harness = "claudecode") {
  const dir = srcDir ?? join(ROOT, "dist", harness);
  if (!existsSync(join(dir, ".claude-plugin", "plugin.json"))) {
    throw new Error(`${dir} has no .claude-plugin/plugin.json. Build the plugin first: node scripts/plugin-build.mjs ${harness}`);
  }
  const problems = checkTree(dir);
  if (problems.length) throw new Error(`${dir} is not a complete plugin folder:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  if (existsSync(join(dir, ".claude-plugin", "dev-build.json"))) {
    throw new Error(`${dir} carries .claude-plugin/dev-build.json, a dev stamp that must not be zipped. Rebuild without --dev-stamp: node scripts/plugin-build.mjs ${harness}`);
  }
  const version = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).version;
  const names = listFiles(dir);
  const bytes = zipBytes(names.map((n) => [n, readFileSync(join(dir, n))]));
  return { name: `${NAMES[harness]}-${version}${suffix}.zip`, version, files: names, bytes };
}

function option(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) return { value: undefined };
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value.\n\n${USAGE}` };
  return { value };
}

/** Runs the command line `args`; returns the exit code and what to print to stdout and stderr. */
export function run(args, root = ROOT) {
  if (args.includes("--help") || args.includes("-h")) return { code: 0, out: USAGE };
  const suffix = option(args, "--suffix");
  const expect = option(args, "--expect-version");
  const outDir = option(args, "--out");
  const harness = option(args, "--harness");
  const src = option(args, "--src");
  const bad = suffix.error ?? expect.error ?? outDir.error ?? harness.error ?? src.error;
  if (bad) return { code: 1, err: bad };
  const h = harness.value ?? "claudecode";
  if (!HARNESSES.includes(h)) return { code: 1, err: `Unknown harness "${h}". Known: ${HARNESSES.join(", ")}.` };
  const srcDir = resolve(src.value ?? join(root, "dist", h));
  let zip;
  try {
    zip = buildReporterZip(srcDir, suffix.value ?? "", h);
  } catch (e) {
    return { code: 1, err: e.message };
  }
  if (expect.value !== undefined && expect.value !== zip.version) {
    return { code: 1, err: `The plugin is version ${zip.version}, not ${expect.value}. Not building.` };
  }
  const dir = resolve(outDir.value ?? ".");
  const rel = relative(srcDir, dir);
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) {
    return { code: 1, err: `The output folder ${dir} is inside the built folder ${srcDir}; the zip would ship itself. Pick another --out.` };
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, zip.name);
  writeFileSync(file, zip.bytes);
  return { code: 0, out: file };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, out, err } = run(process.argv.slice(2));
  if (out) console.log(out);
  if (err) console.error(err);
  process.exitCode = code;
}
