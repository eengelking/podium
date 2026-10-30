#!/usr/bin/env node
// Builds podium-reporter-<version>.zip from mod/podium-reporter/ (#835). Claude Desktop's plugin dialog takes only an archive, so
// every release carries one. CI (release.yml, nightly.yml) and a person run this same script. It writes the zip itself with
// node:zlib, so a runner needs no zip tool, and the same tree gives the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MOD = join(ROOT, "mod", "podium-reporter");

const USAGE = `Usage: node scripts/podium-reporter-zip.mjs [--out <dir>] [--suffix <text>] [--expect-version <x.y.z>]

Zips mod/podium-reporter/ into <dir>/podium-reporter-<version>[<suffix>].zip and prints the path.
  <version>        the version in mod/podium-reporter/.claude-plugin/plugin.json
  --out <dir>      where to write the zip (default: the current directory)
  --suffix <text>  appended to the name before .zip, e.g. -nightly-2026-10-30
  --expect-version fail unless <version> equals this (a tag's number, without the v)
The archive has .claude-plugin/plugin.json and hooks/hooks.json at its root, and leaves out *.test.ts and .DS_Store.`;

/** Whether a file of the mod goes into the archive. */
export function included(rel) {
  return !rel.endsWith(".test.ts") && rel.split("/").at(-1) !== ".DS_Store";
}

/** Every file under `dir`, as paths relative to it with forward slashes, in a fixed order. */
export function listFiles(dir, rel = "") {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (included(r)) out.push(r);
  }
  return out;
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

/** The archive of the mod in `modDir`: its name, version, file list and bytes. */
export function buildReporterZip(modDir = MOD, suffix = "") {
  const version = JSON.parse(readFileSync(join(modDir, ".claude-plugin", "plugin.json"), "utf8")).version;
  const names = listFiles(modDir);
  const bytes = zipBytes(names.map((n) => [n, readFileSync(join(modDir, n))]));
  return { name: `podium-reporter-${version}${suffix}.zip`, version, files: names, bytes };
}

function option(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} needs a value.\n\n${USAGE}`);
    process.exit(1);
  }
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const zip = buildReporterZip(MOD, option(args, "--suffix") ?? "");
  const expected = option(args, "--expect-version");
  if (expected !== undefined && expected !== zip.version) {
    console.error(`The mod is version ${zip.version}, not ${expected}. Not building.`);
    process.exit(1);
  }
  const out = resolve(option(args, "--out") ?? ".");
  mkdirSync(out, { recursive: true });
  const file = join(out, zip.name);
  writeFileSync(file, zip.bytes);
  console.log(file);
}
