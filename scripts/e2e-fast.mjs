#!/usr/bin/env node
// `npm run e2e:fast` (#1249): the end-to-end suite on ONE database, split into shards that run side by side, through scripts/e2e-all.sh.
// The shard count is chosen from the container engine's machine, never above MAX_SHARDS, and printed with the reason. `--shards N`
// replaces the choice (any whole number; e2e-all.sh warns when the runs outnumber the CPUs). `npm run e2e` stays the serial run.
// Usage: node scripts/e2e-fast.mjs [--db KIND] [--shards N] [--out DIR] [--no-build] [-- <cypress run arguments>]
//        KIND defaults to $E2E_DB, then sqlite. Exit code: what e2e-all.sh exits with (0 pass, 1 a shard failed, 2 setup error), 2 for bad arguments.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Past 3 shards a 6-CPU, 16 GB machine was no faster and one run hung for 15 minutes (DECISIONS 49, `e2e-all.sh --help`). */
export const MAX_SHARDS = 3;
/** Each run (a server, a Chrome, a database container) takes about this much memory, in GB. */
export const GB_PER_RUN = 2;

const HELP = `Usage: node scripts/e2e-fast.mjs [--db KIND] [--shards N] [--out DIR] [--no-build] [-- <cypress run arguments>]

Runs the whole end-to-end suite on one database (KIND, else $E2E_DB, else sqlite) split into shards at once, with scripts/e2e-all.sh.
Ends with one "E2E RESULT:" line naming each shard. Exit code: 0 every shard passed, 1 a shard failed, 2 a setup error.

The shard count is the smallest of ${MAX_SHARDS}, the engine's CPUs, and its memory in GB divided by ${GB_PER_RUN}, and at least 1. It is printed with the reason.
--shards N uses N instead (e2e-all.sh warns when N is more than the CPUs). When the machine supports one shard, one runs.
"npm run e2e" is the serial run: use it to reproduce a failure that only shows when sharded, or on a machine too small to shard.
`;

/**
 * The shard count for a machine. cpus and memGb are numbers or undefined (not read); override is a whole number or undefined.
 * @param {{ cpus?: number, memGb?: number, override?: number }} machine
 * @returns {{ shards: number, reason: string }}
 */
export function chooseShards({ cpus, memGb, override }) {
  if (override !== undefined) return { shards: override, reason: `--shards ${override} was given` };
  if (!Number.isFinite(cpus) || !Number.isFinite(memGb)) {
    return { shards: 1, reason: "the engine's CPUs and memory could not be read, so one shard (pass --shards N to choose)" };
  }
  const byMem = Math.floor(memGb / GB_PER_RUN);
  const n = Math.max(1, Math.min(MAX_SHARDS, cpus, byMem));
  const limits = `cap ${MAX_SHARDS}, ${cpus} CPUs, ${memGb.toFixed(1)} GB / ${GB_PER_RUN} = ${byMem}`;
  if (n === 1) return { shards: 1, reason: `this machine supports one shard (${limits}), so it runs one` };
  const limiter = n === MAX_SHARDS ? `the cap of ${MAX_SHARDS}` : n === cpus ? "the CPUs" : "the memory";
  return { shards: n, reason: `${n} is limited by ${limiter} (${limits})` };
}

/** The engine's CPUs and memory in GB, or undefined for each that could not be read. */
export function readMachine(env = process.env, run = spawnSync) {
  let engine = env.E2E_ENGINE;
  if (!engine) {
    for (const e of ["podman", "docker"]) if (run(e, ["--version"], { stdio: "ignore" }).status === 0) { engine = e; break; }
  }
  const fmt = engine === "podman" ? "{{.Host.CPUs}} {{.Host.MemTotal}}" : "{{.NCPU}} {{.MemTotal}}";
  if (engine !== "podman" && engine !== "docker") return {};
  const r = run(engine, ["info", "--format", fmt], { encoding: "utf8" });
  const [c, m] = String(r.stdout ?? "").trim().split(/\s+/).map(Number);
  return { cpus: r.status === 0 && c > 0 ? c : undefined, memGb: r.status === 0 && m > 0 ? m / 1024 ** 3 : undefined };
}

/** Reads the arguments. Returns { error } or { db, shards, passthrough }, where passthrough is the e2e-all.sh options and the Cypress arguments. */
export function parseArgs(argv, env = process.env) {
  let db = env.E2E_DB || "sqlite";
  let override;
  const pass = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pass.push(...argv.slice(i)); break; }
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--no-build") pass.push(a);
    else if (a === "--db" || a === "--shards" || a === "--out") {
      const v = argv[++i];
      if (v === undefined) return { error: `${a} needs a value (see --help)` };
      if (a === "--db") db = v;
      else if (a === "--out") pass.push(a, v);
      else if (/^[1-9][0-9]*$/.test(v)) override = Number(v);
      else return { error: `--shards needs a whole number of 1 or more, not "${v}"` };
    } else return { error: `unknown option ${a} (see --help)` };
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(db)) return { error: `not a database kind: "${db}"` };
  return { db, override, pass };
}

export function main(argv, env = process.env, run = spawnSync) {
  const args = parseArgs(argv, env);
  if (args.help) { process.stdout.write(HELP); return 0; }
  if (args.error) { process.stderr.write(`e2e-fast: ${args.error}\n`); return 2; }
  const { shards, reason } = chooseShards({ ...(args.override === undefined ? readMachine(env, run) : {}), override: args.override });
  process.stdout.write(`e2e-fast: ${args.db}, ${shards} shard${shards === 1 ? "" : "s"}: ${reason}\n`);
  const script = join(dirname(fileURLToPath(import.meta.url)), "e2e-all.sh");
  return run("bash", [script, "--databases", args.db, "--shards", String(shards), ...args.pass], { stdio: "inherit" }).status ?? 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
