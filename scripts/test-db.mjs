#!/usr/bin/env node
// `npm run test:db` (#1294): the server suite on every storage adapter, from one command with the options `npm run e2e:fast` has.
// scripts/db-servers.sh takes the machine's database lock and starts a throwaway container for each database server kind; this script
// chooses the kinds and the files, runs vitest in server/ with a JSON report, and ends with one "DB TEST RESULT:" line naming each database.
// Usage: node scripts/test-db.mjs [--db "KIND [KIND...]"] [--scope adapters|all] [--shards N] [--out DIR] [--image KIND=REF ...] [-- <vitest arguments>]
// Exit code: vitest's (0 pass, 1 a test failed), 2 for bad arguments or a setup error (a container that did not start or answer).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapter, kinds } from "./db-adapters.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const HELP = `Usage: node scripts/test-db.mjs [--db "KIND [KIND...]"] [--scope adapters|all] [--shards N] [--out DIR] [--image KIND=REF ...] [-- <vitest arguments>]
       npm run test:db -- [options]

Runs the server suite (vitest, in server/) on every storage adapter. It takes the machine's database lock first (scripts/db-lock.sh), starts
one throwaway container for each database that has a test server (PostgreSQL 17, MariaDB 11.4: the one version each is tested on), all at once
and on 127.0.0.1 only, waits until each answers, sets its test server variable (PODIUM_TEST_PG, PODIUM_TEST_MARIADB, ...), runs vitest, and
removes every container however the run ends. Each test file makes its own database on each server and drops it after.
Only one database job (this, or "npm run e2e:fast") runs at a time per user: a second one waits for its turn and says so.
PODIUM_DB_LOCK=off skips the lock; PODIUM_DB_LOCK_TIMEOUT_S=N gives up (exit 3) after N seconds of waiting. CI skips it.

Options:
  --db "KIND [KIND...]"  The kinds to run, space or comma separated, each once. Default: $PODIUM_TEST_ONLY, else every registered kind
                         (${kinds().join(", ")}). A run that leaves one out says LIMITED and what was NOT RUN: it is not a pass for a pull request.
                         An agent does not use this to leave a database out unless the person asked for that in the session.
  --scope adapters|all   all (the default) runs the whole server config; adapters runs only the tests that depend on a database server
                         (each chosen server kind's folder under server/src/storage/, adapters.test.ts and the chatGoneReads files).
  --shards N             Runs vitest's --shard i/N for i = 1..N, one after another on the same containers (default 1). A full run takes
                         about four minutes on a developer laptop, so sharding does not help locally; it is for reproducing a CI split.
  --out DIR              Where each run's log (vitest.log) and report (report-<shard>.json) go. Default: a new folder under $TMPDIR.
  --image KIND=REF       Run one kind from another image (for example mariadb=docker.io/library/mariadb:11.8). Untested.
  -- <vitest arguments>  Passed to vitest: test files (paths from server/) and -t still work.
  -h, --help             Show this help.

Ends with one "DB TEST RESULT:" line: sqlite=PASS postgres=FAIL(1) mariadb=NOT RUN, and then each database's files and tests. A test counts
for a database when its file is in that database's folder, or its describe titles name it (its kind or its label, for example "PostgreSQL");
every other test is counted under sqlite, the default. A kind left out is NOT RUN. CONTAINER_ENGINE chooses podman (default) or docker.
PODIUM_TEST_ONLY is what CI and "npm test" use to leave kinds out; it works here the same way when --db is not given.
Exit code: vitest's, or 2 for bad arguments or a container that did not start or answer; a setup error is never a pass.
`;

/**
 * Reads the arguments. Returns { help }, { error } or { dbs, limited, scope, shards, out, images, pass }.
 * `known` is every registered kind. `env` supplies PODIUM_TEST_ONLY when --db is not given.
 */
export function parseArgs(argv, env = process.env, known = kinds()) {
  let db;
  let scope = "all";
  let shards = 1;
  let out;
  const images = [];
  let pass = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pass = argv.slice(i + 1); break; }
    if (a === "-h" || a === "--help") return { help: true };
    // npm drops the first "--", so `npm run test:db -- src/x.test.ts -t y` arrives without one: the first argument that is not a long option
    // of ours (a file, or -t) starts the vitest arguments. A misspelled long option is still an error.
    if (!a.startsWith("--")) { pass = argv.slice(i); break; }
    if (!["--db", "--scope", "--shards", "--out", "--image"].includes(a)) return { error: `unknown option ${a} (see --help)` };
    const v = argv[++i];
    if (v === undefined) return { error: `${a} needs a value (see --help)` };
    if (a === "--db") db = v;
    else if (a === "--out") out = v;
    else if (a === "--image") {
      if (!/^[a-z][a-z0-9_-]*=.+$/.test(v)) return { error: "--image needs KIND=REF" };
      images.push(v);
    } else if (a === "--scope") {
      if (v !== "adapters" && v !== "all") return { error: `--scope is adapters or all, not "${v}"` };
      scope = v;
    } else if (/^[1-9][0-9]*$/.test(v)) shards = Number(v);
    else return { error: `--shards needs a whole number of 1 or more, not "${v}"` };
  }
  const named = db ?? env.PODIUM_TEST_ONLY ?? "";
  const from = db === undefined ? "PODIUM_TEST_ONLY" : "--db";
  let dbs = named.split(/[\s,]+/).filter(Boolean);
  const limited = dbs.length > 0;
  if (db !== undefined && !limited) return { error: "--db needs at least one database kind" };
  const twice = dbs.find((k, i) => dbs.indexOf(k) !== i);
  if (twice) return { error: `${from} names "${twice}" twice; a database is run once` };
  const unknown = dbs.find((k) => !known.includes(k));
  if (unknown) return { error: `${from} names "${unknown}", which is not a storage kind (registered: ${known.join(", ")})` };
  for (const im of images) {
    const k = im.slice(0, im.indexOf("="));
    if (!known.includes(k)) return { error: `--image names "${k}", which is not a storage kind (registered: ${known.join(", ")})` };
  }
  if (!limited) dbs = [...known];
  return { dbs, limited, scope, shards, out, images, pass };
}

/** The vitest file filters for --scope adapters: each chosen kind's folder, the shared adapter test and the files that open a store per server. */
export function adapterFilters(dbs, known = kinds(), servers = kinds("server")) {
  const own = dbs.filter((k) => servers.includes(k) && known.includes(k)).map((k) => `storage/${k}/`);
  return [...own, "storage/adapters.test", "chatGoneReads"];
}

/** The kind a test counts for: its folder, else a describe title that names a kind or its label, else the default kind (the first registered). */
export function kindOfTest(file, titles, known = kinds()) {
  const folder = known.find((k) => file.includes(`/storage/${k}/`));
  if (folder) return folder;
  const hay = titles.join(" ").toLowerCase();
  const named = known.slice(1).find((k) => hay.includes(k) || hay.includes(adapter(k).label.toLowerCase()));
  return named ?? known[0];
}

/**
 * One database's numbers from vitest's JSON report(s): { files, tests, failed } per kind in `ran`; a kind left out has no entry.
 * A suite that failed to load (no assertions) counts as one failure for its file.
 */
export function summarize(reports, ran, known = kinds()) {
  const sums = Object.fromEntries(ran.map((k) => [k, { files: 0, tests: 0, failed: 0 }]));
  for (const rep of reports) {
    for (const f of rep.testResults ?? []) {
      const seen = new Set();
      const count = (k, failed, test) => {
        const s = sums[k];
        if (!s) return;
        if (!seen.has(k)) { seen.add(k); s.files++; }
        if (test) s.tests++;
        if (failed) s.failed++;
      };
      const results = f.assertionResults ?? [];
      for (const t of results) {
        if (t.status === "pending" || t.status === "skipped" || t.status === "todo") continue;
        count(kindOfTest(f.name ?? "", t.ancestorTitles ?? [], known), t.status === "failed", true);
      }
      if (f.status === "failed" && !results.some((t) => t.status === "failed")) count(kindOfTest(f.name ?? "", [], known), true, false);
    }
  }
  return sums;
}

/** The result lines: the one "DB TEST RESULT:" line, a line of counts per database, and the LIMITED notice when a kind was left out. */
export function resultLines(sums, all, ran, limited, code) {
  const word = (k) => {
    if (!ran.includes(k)) return "NOT RUN";
    const s = sums[k];
    if (s.failed > 0) return `FAIL(${s.failed})`;
    if (code !== 0) return "FAIL(0)";
    return s.tests === 0 ? "NO TESTS" : "PASS"; // a database no test was counted for did not prove anything
  };
  const lines = [`DB TEST RESULT: ${all.map((k) => `${k}=${word(k)}`).join(" ")}`];
  for (const k of ran) lines.push(`  ${k}: ${sums[k].files} files, ${sums[k].tests} tests${sums[k].failed ? `, ${sums[k].failed} failed` : ""}`);
  const left = all.filter((k) => !ran.includes(k));
  if (left.length) lines.push(`LIMITED to ${ran.join(" ")}. NOT RUN: ${left.join(" ")}. A limited run is not a pass for a pull request.`);
  return lines;
}

/** Runs a command, forwarding its output to ours and to the log file. Resolves with its exit code. */
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

export async function main(argv, env = process.env, exec = runLogged) {
  const args = parseArgs(argv, env);
  if (args.help) { process.stdout.write(HELP); return 0; }
  if (args.error) { process.stderr.write(`test-db: ${args.error}\n`); return 2; }
  const all = kinds();
  const servers = kinds("server");
  const out = args.out ?? join(env.TMPDIR || tmpdir(), `podium-test-db-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(out, { recursive: true });
  const log = join(out, "vitest.log");
  writeFileSync(log, "");
  const filters = args.scope === "adapters" ? adapterFilters(args.dbs, all, servers) : [];
  const reports = [];
  const child = { ...env };
  delete child.PODIUM_TEST_ONLY;
  if (args.limited) child.PODIUM_TEST_ONLY = args.dbs.join(",");
  const wanted = args.dbs.filter((k) => servers.includes(k));
  process.stdout.write(`test-db: ${args.dbs.join(" ")}, scope ${args.scope}, ${args.shards} shard${args.shards === 1 ? "" : "s"}${args.shards === 1 ? " (a full run takes minutes, so sharding is opt-in)" : " (--shards was given)"}; output in ${out}\n`);
  // One vitest command per shard, run one after another inside one db-servers.sh call so the containers start once.
  const runs = [];
  for (let i = 1; i <= args.shards; i++) {
    const report = join(out, `report-${i}.json`);
    reports.push(report);
    const v = ["npx", "vitest", "run", ...filters, ...args.pass, "--reporter=default", "--reporter=json", `--outputFile.json=${report}`];
    if (args.shards > 1) v.push(`--shard=${i}/${args.shards}`);
    runs.push(v);
  }
  const bashArgs = [join(HERE, "db-servers.sh"), "--kinds", wanted.join(" ")];
  for (const im of args.images) bashArgs.push("--image", im);
  // Every shard runs; the exit code is the worst one.
  bashArgs.push("--", "bash", "-c", `code=0 ; ${runs.map((v) => `${v.map((w) => `'${w.replace(/'/g, "'\\''")}'`).join(" ")} || { c=$? ; [ "$c" -gt "$code" ] && code=$c ; }`).join(" ; ")} ; exit $code`);
  let code = await exec("bash", bashArgs, { env: child }, log);
  const found = reports.filter((r) => existsSync(r)).map((r) => { try { return JSON.parse(readFileSync(r, "utf8")); } catch { return undefined; } }).filter(Boolean);
  if (found.length === 0 && code !== 0 && code !== 130) code = code === 1 ? 2 : code; // no report: the run never reached vitest's end
  const sums = summarize(found, args.dbs, all);
  process.stdout.write(`\n${resultLines(sums, all, args.dbs, args.limited, code).join("\n")}\n`);
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
