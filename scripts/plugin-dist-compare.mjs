#!/usr/bin/env node
// Checks that a release zip and the tracked dist/<harness>/ hold the same plugin (#927, #983): the same file list and the same bytes.
// release.yml runs this after the tag's zip is built from dist/, in the checkout of the tag, so a difference means the archive was
// built from something other than the committed release build.
//
//   node scripts/plugin-dist-compare.mjs --zip <file> [--harness claudecode]
//   node scripts/plugin-dist-compare.mjs --zip <file> --dir <folder>      (compare a zip to any folder; used by tests)
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { walk } from "./plugin-build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);


const USAGE = `Usage: node scripts/plugin-dist-compare.mjs --zip <file> [--harness <name> | --dir <folder>]

Fails unless the zip's file list and bytes equal dist/<harness>/ of this checkout (or the folder named with --dir).
  --zip <file>        the release archive
  --harness <name>    dist/<harness>/ of this checkout (default claudecode)
  --dir <folder>      compare with this folder instead
  -h, --help          this text`;

/** The entries of a zip, from its central directory: name to bytes. */
export function readZipEntries(buf) {
  const end = buf.length - 22;
  if (buf.readUInt32LE(end) !== 0x06054b50) throw new Error("Not a zip file (no end of central directory).");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    p += 46 + nameLen;
  }
  return out;
}

/** The differences between two maps of name to bytes, as lines. Empty when they are equal. */
export function diffFiles(zip, other, otherLabel) {
  const problems = [];
  for (const name of [...zip.keys()].sort(byName)) {
    if (!other.has(name)) problems.push(`only in the zip: ${name}`);
    else if (!zip.get(name).equals(other.get(name))) problems.push(`different bytes: ${name}`);
  }
  for (const name of [...other.keys()].sort(byName)) if (!zip.has(name)) problems.push(`only in ${otherLabel}: ${name}`);
  return problems;
}

/** The files of a folder as a map of name to bytes. */
export function readDir(dir) {
  return new Map(walk(dir).map((n) => [n, readFileSync(join(dir, n))]));
}

export async function run(args, root = ROOT) {
  if (args.includes("--help") || args.includes("-h")) return { code: 0, out: USAGE };
  const o = { harness: "claudecode" };
  const names = { "--zip": "zip", "--dir": "dir", "--harness": "harness" };
  for (let i = 0; i < args.length; i++) {
    const k = names[args[i]];
    const v = args[++i];
    if (!k || v === undefined || v.startsWith("--")) return { code: 1, err: `Bad argument "${args[i - 1]}".\n\n${USAGE}` };
    o[k] = v;
  }
  if (!o.zip) return { code: 1, err: `Give --zip.\n\n${USAGE}` };
  const dir = o.dir ?? join(root, "dist", o.harness);
  const label = o.dir ? o.dir : `dist/${o.harness}`;
  try {
    const zip = readZipEntries(readFileSync(o.zip));
    const other = readDir(dir);
    if (other.size === 0) return { code: 1, err: `${label} holds no files to compare with.` };
    const problems = diffFiles(zip, other, label);
    if (problems.length) return { code: 1, err: `The zip and ${label} differ:\n${problems.map((p) => `  - ${p}`).join("\n")}` };
    return { code: 0, out: `The zip and ${label} agree: ${zip.size} files, same bytes.` };
  } catch (e) {
    return { code: 1, err: e.message };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, out, err } = await run(process.argv.slice(2));
  if (out) console.log(out);
  if (err) console.error(err);
  process.exitCode = code;
}
