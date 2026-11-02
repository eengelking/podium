#!/usr/bin/env node
// Checks that a release zip and the plugin-dist branch hold the same plugin (#927): the same file list and the same bytes.
// release.yml runs this after the tag's zip is built. The branch is published by plugin-dist.yml (scripts/plugin-publish.mjs), which
// may still be running when the tag is pushed, so this waits, with a limit, for the commit that names the tag's source commit.
//
//   node scripts/plugin-dist-compare.mjs --zip <file> --sha <source-sha> [--harness claudecode] [--remote origin]
//        [--branch plugin-dist] [--wait <seconds>] [--interval <seconds>] [--grace <seconds>] [--version <x.y.z>]
//   node scripts/plugin-dist-compare.mjs --zip <file> --dir <folder>      (compare a zip to a folder; used by tests)
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { walk } from "./plugin-build.mjs";


const USAGE = `Usage: node scripts/plugin-dist-compare.mjs --zip <file> (--dir <folder> | --sha <source-sha>) [options]

Fails unless the zip's file list and bytes equal the folder, or dist/<harness>/ on the plugin-dist branch.
  --zip <file>        the release archive
  --dir <folder>      compare with this folder (no git involved)
  --sha <sha>         the tag's source commit; waits for a plugin-dist commit whose message names it
  --harness <name>    dist/<harness>/ on the branch (default claudecode)
  --remote <name>     where to fetch the branch (default origin)
  --branch <name>     the branch (default plugin-dist)
  --wait <seconds>    how long to wait for that commit (default 900)
  --interval <secs>   the pause between looks (default 30)
  --grace <seconds>   after this long with no commit naming the sha, compare with the branch tip if its plugin.json version equals
                      --version (a rerun of an unchanged tree publishes no commit). Default 300.
  --version <x.y.z>   the tag's number, for that fallback
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
  for (const name of [...zip.keys()].sort()) {
    if (!other.has(name)) problems.push(`only in the zip: ${name}`);
    else if (!zip.get(name).equals(other.get(name))) problems.push(`different bytes: ${name}`);
  }
  for (const name of [...other.keys()].sort()) if (!zip.has(name)) problems.push(`only in ${otherLabel}: ${name}`);
  return problems;
}

/** The files of a folder as a map of name to bytes. */
export function readDir(dir) {
  return new Map(walk(dir).map((n) => [n, readFileSync(join(dir, n))]));
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();

/** The files under `prefix` in `commit` as a map of path (relative to prefix) to bytes. */
export function readCommitDir(cwd, commit, prefix) {
  const names = git(cwd, ["ls-tree", "-r", "--name-only", "-z", commit, `${prefix}/`]).split("\0").filter(Boolean);
  const out = new Map();
  for (const n of names) {
    const r = spawnSync("git", ["show", `${commit}:${n}`], { cwd, maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git show ${commit}:${n} failed`);
    out.set(n.slice(prefix.length + 1), r.stdout);
  }
  return out;
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

/** Finds the plugin-dist commit to compare with, waiting up to `wait` seconds. Returns { commit, how }. */
export async function findCommit({ cwd, remote, branch, sha, harness, version, wait, interval, grace, log }) {
  const started = Date.now();
  for (;;) {
    git(cwd, ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`].filter(Boolean));
    const ref = `refs/remotes/${remote}/${branch}`;
    const named = git(cwd, ["log", "--fixed-strings", `--grep=Source commit: ${sha}`, "-n", "1", "--format=%H", ref]);
    if (named) return { commit: named, how: "names the source commit" };
    const waited = (Date.now() - started) / 1000;
    if (version && waited >= grace) {
      const tip = git(cwd, ["rev-parse", ref]);
      const r = spawnSync("git", ["show", `${tip}:dist/${harness}/.claude-plugin/plugin.json`], { cwd, encoding: "utf8" });
      if (r.status === 0 && JSON.parse(r.stdout).version === version) {
        return { commit: tip, how: `is the branch tip at version ${version}; no commit names ${sha}, which happens when a rerun finds an unchanged tree` };
      }
    }
    if (waited >= wait) {
      throw new Error(`No ${branch} commit naming ${sha} appeared in ${wait} seconds. Check the plugin-dist workflow run for that commit, fix it, then re-run this job.`);
    }
    log(`No ${branch} commit names ${sha} yet; waiting.`);
    await sleep(interval);
  }
}

export async function run(args, cwd = process.cwd(), log = console.log) {
  if (args.includes("--help") || args.includes("-h")) return { code: 0, out: USAGE };
  const o = { remote: "origin", branch: "plugin-dist", harness: "claudecode", wait: 900, interval: 30, grace: 300 };
  const names = { "--zip": "zip", "--dir": "dir", "--sha": "sha", "--harness": "harness", "--remote": "remote", "--branch": "branch", "--wait": "wait", "--interval": "interval", "--grace": "grace", "--version": "version" };
  for (let i = 0; i < args.length; i++) {
    const k = names[args[i]];
    const v = args[++i];
    if (!k || v === undefined || v.startsWith("--")) return { code: 1, err: `Bad argument "${args[i - 1]}".\n\n${USAGE}` };
    o[k] = ["wait", "interval", "grace"].includes(k) ? Number(v) : v;
  }
  if (!o.zip || (!o.dir && !o.sha)) return { code: 1, err: `Give --zip and one of --dir or --sha.\n\n${USAGE}` };
  try {
    const zip = readZipEntries(readFileSync(o.zip));
    let other;
    let label;
    if (o.dir) {
      other = readDir(o.dir);
      label = o.dir;
    } else {
      const found = await findCommit({ cwd, ...o, log });
      other = readCommitDir(cwd, found.commit, `dist/${o.harness}`);
      label = `${o.branch}@${found.commit.slice(0, 12)}`;
      log(`Comparing with ${label}, which ${found.how}.`);
    }
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
