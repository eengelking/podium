#!/usr/bin/env node
// `npm run test:all` (#1295): every test suite from one command, with one database lock and one result line.
// It adds no new way to run a suite: each one is the command that already runs it (npm run test:db, npm test -w frontend, npm run test:core,
// test:mod:<harness> then typecheck:mod:<harness>, npm run e2e:fast). The harness suites are read from package.json, not listed here.
// Usage: node scripts/test-all.mjs [--suite "NAME [NAME...]"] [--db "KIND [KIND...]"] [--shards N] [--out DIR] [--fail-fast] [-- <arguments>]
// Exit code: 0 every selected suite passed, 1 one failed, 2 for bad arguments or a setup error.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kinds } from "./db-adapters.mjs";
import { harnesses } from "./harness-scripts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const HELP = `Usage: node scripts/test-all.mjs [--suite "NAME [NAME...]"] [--db "KIND [KIND...]"] [--shards N] [--out DIR] [--fail-fast] [-- <arguments>]
       npm run test:all -- [options]

Runs every test suite, one after another (never side by side), each through the command that already runs it:
  server           npm run test:db
  frontend         npm test -w frontend
  core             npm run test:core
  mod:<harness>    npm run test:mod:<harness>, then npm run typecheck:mod:<harness> (one suite per harness found in package.json)
  e2e              npm run e2e:fast
It takes the machine's database lock once (scripts/db-lock.sh) and keeps it for the whole run; the suites it starts do not wait for it again.
Only one database job runs at a time per user, so a second run waits its turn and says so.

Options:
  --suite "NAME [NAME...]"  The suites to run, space or comma separated, each once. Default: every suite. An unknown or repeated name is refused.
  --db "KIND [KIND...]"     Handed to server and e2e. Default: every registered kind in both.
  --shards N                Handed to server and e2e.
  --out DIR                 One folder holding a log and a report per suite. Default: a new folder under $TMPDIR.
  --fail-fast               Stop after the first failing suite. Otherwise a failing suite does not stop the later ones.
  -- <arguments>            Passed to the suite, only when exactly one suite is named (one list cannot mean the same to vitest, Cypress and the mod runners).
  -h, --help                Show this help.

Ends with one "TEST ALL RESULT:" line, one entry per suite: server=PASS frontend=PASS core=PASS mod:opencode=PASS mod:claudecode=NOT RUN e2e=PASS,
and each suite's counts. A suite that cannot run on this machine (mod:claudecode without the Claude Code CLI, e2e without a running container
engine) is NOT RUN with the reason. A run that leaves anything out (--suite, --db, a NOT RUN suite) says LIMITED and is not a pass for a pull
request or a release. An agent does not use --suite or --db to get a green run unless the person asked for that in the session.
Exit code: 0 every selected suite passed, 1 one failed, 2 bad arguments or a setup error.
`;

/** The harnesses that have a test:mod and typecheck:mod script pair in package.json, read from the repo (plugin/ folders) and its scripts. */
export function harnessSuites(scripts, folders = harnesses(join(ROOT, "plugin"))) {
  const found = new Set(folders);
  for (const name of Object.keys(scripts)) {
    const m = /^(?:test|typecheck):mod:(.+)$/.exec(name);
    if (m) found.add(m[1]);
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

/**
 * Every suite in run order: { name, steps: [{ cmd, args }], takes } where takes lists the options the suite accepts ("db", "shards").
 * A step's args are npm arguments; the options are added by `stepsFor`.
 */
export function suites(scripts, folders) {
  const list = [
    { name: "server", takes: ["db", "shards"], steps: [["run", "test:db"]] },
    { name: "frontend", takes: [], steps: [["test", "-w", "frontend"]] },
    { name: "core", takes: [], steps: [["run", "test:core"]] },
  ];
  for (const h of harnessSuites(scripts, folders)) {
    list.push({ name: `mod:${h}`, takes: [], harness: h, steps: [["run", `test:mod:${h}`], ["run", `typecheck:mod:${h}`]] });
  }
  list.push({ name: "e2e", takes: ["db", "shards"], steps: [["run", "e2e:fast"]] });
  return list;
}

/** The harness script pairs in package.json that no suite runs (a test fails on any). */
export function unrunHarnessScripts(scripts, list) {
  const run = new Set(list.flatMap((s) => s.steps.map((st) => st[1])));
  return Object.keys(scripts).filter((n) => /^(?:test|typecheck):mod:/.test(n) && !run.has(n));
}

/**
 * Reads the arguments. Returns { help }, { error } or { names, limited, db, shards, out, failFast, pass }.
 * `list` is every suite; `known` is every registered database kind.
 */
export function parseArgs(argv, list, known = kinds()) {
  let suite;
  let db;
  let shards;
  let out;
  let failFast = false;
  let pass = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pass = argv.slice(i + 1); break; }
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--fail-fast") { failFast = true; continue; }
    // npm drops the first "--", so the first argument that is not a long option of ours starts the pass-through arguments.
    if (!a.startsWith("--")) { pass = argv.slice(i); break; }
    if (!["--suite", "--db", "--shards", "--out"].includes(a)) return { error: `unknown option ${a} (see --help)` };
    const v = argv[++i];
    if (v === undefined) return { error: `${a} needs a value (see --help)` };
    if (a === "--suite") suite = v;
    else if (a === "--db") db = v;
    else if (a === "--out") out = v;
    else if (/^[1-9][0-9]*$/.test(v)) shards = Number(v);
    else return { error: `--shards needs a whole number of 1 or more, not "${v}"` };
  }
  const all = list.map((s) => s.name);
  let names = all;
  if (suite !== undefined) {
    names = suite.split(/[\s,]+/).filter(Boolean);
    if (names.length === 0) return { error: "--suite needs at least one suite name" };
    const twice = names.find((n, i) => names.indexOf(n) !== i);
    if (twice) return { error: `--suite names "${twice}" twice; a suite is run once` };
    const unknown = names.find((n) => !all.includes(n));
    if (unknown) return { error: `--suite names "${unknown}", which is not a suite (suites: ${all.join(", ")})` };
    names = all.filter((n) => names.includes(n)); // always in run order
  }
  let dbs;
  if (db !== undefined) {
    dbs = db.split(/[\s,]+/).filter(Boolean);
    if (dbs.length === 0) return { error: "--db needs at least one database kind" };
    const twice = dbs.find((k, i) => dbs.indexOf(k) !== i);
    if (twice) return { error: `--db names "${twice}" twice; a database is run once` };
    const unknown = dbs.find((k) => !known.includes(k));
    if (unknown) return { error: `--db names "${unknown}", which is not a storage kind (registered: ${known.join(", ")})` };
  }
  if (pass.length > 0 && names.length !== 1) {
    return { error: `arguments after -- go to one suite, and ${names.length} are selected; name one with --suite (one list cannot mean the same to vitest, Cypress and the mod runners)` };
  }
  const limited = suite !== undefined && names.length < all.length || (dbs !== undefined && dbs.length < known.length);
  return { names, limited, db: dbs, shards, out, failFast, pass };
}

/** The npm commands one suite runs: the options it takes are added to its first step, and the pass-through arguments to its first (the tests, not the typecheck). */
export function stepsFor(suite, args) {
  return suite.steps.map((s, i) => {
    const extra = [];
    if (i === 0) {
      // The default is every registered kind in both suites; e2e:fast alone would default to SQLite.
      if (suite.takes.includes("db")) extra.push("--db", (args.db ?? kinds(suite.name === "e2e" ? "e2e" : undefined)).join(" "));
      if (args.shards && suite.takes.includes("shards")) extra.push("--shards", String(args.shards));
    }
    // e2e:fast and test:db read their own options before a "--" and hand what follows it on (Cypress or vitest arguments), so an option such as --spec needs it.
    if (i === 0) extra.push(...(suite.takes.includes("db") && args.pass.length ? ["--"] : []), ...args.pass);
    const needsDash = s[0] === "run" || s[0] === "test";
    // `npm run X -- a b` and `npm test -w frontend -- a b`: everything after the first -- reaches the script.
    return { cmd: "npm", args: extra.length ? [...s, ...(needsDash ? ["--"] : []), ...extra] : s };
  });
}

/** Why a suite cannot run on this machine, or undefined. `run` is spawnSync-like. */
export function cannotRun(name, run = spawnSync, env = process.env, dbs = kinds(), servers = kinds("server")) {
  const ok = (cmd, a) => run(cmd, a, { stdio: "ignore" }).status === 0;
  if (name === "mod:claudecode" && !ok("claude", ["--version"])) return "the Claude Code CLI (claude) is not installed or does not answer";
  const needsEngine = name === "e2e" || (name === "server" && dbs.some((k) => servers.includes(k)));
  if (needsEngine) {
    const engines = env.CONTAINER_ENGINE || env.E2E_ENGINE ? [env.CONTAINER_ENGINE || env.E2E_ENGINE] : ["podman", "docker"];
    if (!engines.some((e) => ok(e, ["info"]))) return `no container engine is running (tried ${engines.join(", ")})`;
  }
  return undefined;
}

/** The counts line of a suite, from its log: the last line that looks like a result summary, or undefined. */
export function countsOf(name, text) {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const last = (re) => [...lines].reverse().find((l) => re.test(l))?.trim();
  if (name === "server") {
    const at = lines.findIndex((l) => l.startsWith("DB TEST RESULT:"));
    return at < 0 ? undefined : lines.slice(at + 1).filter((l) => /^ {2}\S+: \d+ files/.test(l)).map((l) => l.trim()).join("; ") || undefined;
  }
  if (name === "e2e") return last(/E2E RESULT:/);
  const ran = last(/^Ran \d+ tests across \d+ files/); // claude plugin test
  return last(/^\s*Tests\s+\d+/) ?? ran ?? last(/\b\d+ (passed|failed)\b/);
}

/** Runs a command, forwarding its output to ours and to the log. Resolves with its exit code (130 for a signal, 2 when it did not start). */
export function runLogged(cmd, args, opts, log) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["inherit", "pipe", "pipe"] });
    const tee = (stream, sink) => stream.on("data", (b) => { sink.write(b); appendFileSync(log, b); });
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    child.on("error", () => resolve(2));
    child.on("close", (code, signal) => resolve(code ?? (signal ? 130 : 2)));
  });
}

/** The result lines: the one "TEST ALL RESULT:" line, one line of counts per suite that ran, and the LIMITED notice. */
export function resultLines(results, allNames, limited) {
  const word = (r) => (r.status === "FAIL" ? `FAIL(${r.code})` : r.status);
  const by = Object.fromEntries(results.map((r) => [r.name, r]));
  const shown = allNames.map((n) => by[n]).filter(Boolean);
  const lines = [`TEST ALL RESULT: ${shown.map((r) => `${r.name}=${word(r)}`).join(" ")}`];
  for (const r of shown) {
    if (r.status === "NOT RUN") lines.push(`  ${r.name}: NOT RUN, ${r.reason}`);
    else lines.push(`  ${r.name}: ${r.counts ?? "no counts found in its log"} (${r.seconds}s, log ${r.log})`);
  }
  const notRun = shown.filter((r) => r.status === "NOT RUN");
  if (limited || notRun.length) {
    const left = allNames.filter((n) => !by[n] || by[n].status === "NOT RUN");
    lines.push(`LIMITED${left.length ? `: NOT RUN ${left.join(" ")}` : ""}${limited ? ", the run was narrowed with --suite or --db" : ""}. A limited run is not a pass for a pull request or a release.`);
  }
  return lines;
}

/** 0 only when every selected suite passed; a failed suite and a NOT RUN suite are both 1 (a NOT RUN is never a pass). */
export function exitCode(results) {
  return results.every((r) => r.status === "PASS") ? 0 : 1;
}

/**
 * Takes the lock once for the whole run. The lock is bash (scripts/db-lock.sh), so this starts a bash that acquires it, exports
 * PODIUM_DB_LOCK_HELD and runs this script again with TEST_ALL_LOCKED set; the bash's own traps release the lock on exit or a signal.
 */
export function lockedRun(argv, env = process.env, run = spawnSync) {
  const script = `source ${JSON.stringify(join(HERE, "db-lock.sh"))} && db_lock_acquire "npm run test:all" && node ${JSON.stringify(fileURLToPath(import.meta.url))} "$@"`;
  const r = run("bash", ["-c", `${script}; code=$?; db_lock_release; exit $code`, "test-all", ...argv], { stdio: "inherit", env: { ...env, TEST_ALL_LOCKED: "1" } });
  return r.status ?? (r.signal ? 130 : 2);
}

export async function main(argv, env = process.env, exec = runLogged, run = spawnSync, scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {}) {
  const list = suites(scripts);
  const args = parseArgs(argv, list);
  if (args.help) { process.stdout.write(HELP); return 0; }
  if (args.error) { process.stderr.write(`test-all: ${args.error}\n`); return 2; }
  if (!env.TEST_ALL_LOCKED) return lockedRun(argv, env, run);
  const out = args.out ?? mkdtempSync(join(env.TMPDIR || tmpdir(), "podium-test-all-"));
  mkdirSync(out, { recursive: true });
  const allNames = list.map((s) => s.name);
  process.stdout.write(`test-all: ${args.names.join(" ")}, one after another, one lock for the run; output in ${out}\n`);
  const results = [];
  for (const name of args.names) {
    const suite = list.find((s) => s.name === name);
    const log = join(out, `${name.replace(/[^a-z0-9]+/gi, "-")}.log`);
    writeFileSync(log, "");
    const reason = cannotRun(name, run, env, args.db ?? kinds());
    if (reason) {
      process.stdout.write(`\ntest-all: ${name}: NOT RUN, ${reason}\n`);
      results.push({ name, status: "NOT RUN", reason, log });
      continue;
    }
    const started = Date.now();
    let code = 0;
    for (const step of stepsFor(suite, args)) {
      process.stdout.write(`\ntest-all: ${name}: ${step.cmd} ${step.args.join(" ")}\n`);
      code = await exec(step.cmd, step.args, { cwd: ROOT, env }, log);
      if (code !== 0) break;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    results.push({ name, status: code === 0 ? "PASS" : "FAIL", code, seconds, log, counts: countsOf(name, readFileSync(log, "utf8")) });
    if (code === 130) break; // interrupted: stop, the lock is released by the shell above
    if (code !== 0 && args.failFast) break;
  }
  writeFileSync(join(out, "report.json"), JSON.stringify({ results, limited: args.limited }, null, 2));
  process.stdout.write(`\n${resultLines(results, allNames, args.limited).join("\n")}\n`);
  return exitCode(results);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
