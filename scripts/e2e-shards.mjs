#!/usr/bin/env node
// Splits the end-to-end spec files into groups for scripts/e2e-all.sh --shards N (#1130), and reads a run's spec and test counts.
// The groups come from the files on disk (the specPattern in e2e/cypress.config.cjs), never from a list kept by hand, so a spec added
// later lands in a group without anyone editing a script. Every spec is in exactly one group, and the script checks that before it prints.
// A spec is weighed by the seconds it took in a recorded run (e2e/spec-times.json, written by --record from Cypress logs), because a
// count of tests or restarts does not predict a spec's time: three specs that wait on real timers took 38% of the suite.
// Usage: node scripts/e2e-shards.mjs --shards N [--explain]  one line per group: the comma-separated --spec list (paths relative to e2e/)
//        node scripts/e2e-shards.mjs --list                  one spec path per line
//        node scripts/e2e-shards.mjs --counts LOG...         specs= tests= passing= failing= for each Cypress log, one line each
//        node scripts/e2e-shards.mjs --record LOG...         write e2e/spec-times.json from the specs' durations in Cypress logs
// Exit code: 0 done, 1 a spec is in no group or in two, 2 bad arguments, a bad timings file or a log with no Cypress summary.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Orders strings by UTF-16 code unit, the order a bare sort() uses, so the groups and the lists do not change with the locale. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const SPEC_DIR = join("e2e", "cypress", "e2e");
const SPEC_FILE = /\.cy\.js$/;
export const TIMES_FILE = join("e2e", "spec-times.json");
const REFRESH = "node scripts/e2e-shards.mjs --record <Cypress logs>";
const ABOUT =
  "Seconds each end-to-end spec took, the weights scripts/e2e-shards.mjs uses to split the suite into shards (#1130). " +
  `Refresh it from the logs of a whole run: ${REFRESH} (see --help).`;

const USAGE = `Usage: node scripts/e2e-shards.mjs --shards N [--explain] | --list | --counts LOG... | --record LOG...

  --shards N      Split the spec files under e2e/cypress/e2e into N groups of about the same time and print one line per group:
                  the comma-separated list for cypress run --spec, each path relative to e2e/ (cypress/e2e/<area>/<name>.cy.js).
                  A spec weighs the seconds it took in ${TIMES_FILE}. A spec with no recorded time weighs the median of the
                  recorded ones, and a note on stderr names it. With no timings file at all a spec weighs its test count plus
                  two for each server restart (cy.resetServer), which predicts time badly.
  --explain       With --shards: also print each group's spec count and summed weight (seconds) on stderr, to show the balance.
  --list          Print every spec path, one per line, sorted.
  --counts LOG... For each Cypress log, print: specs=<found> tests=<n> passing=<n> failing=<n>.
  --record LOG... Read each spec's duration from the (Results) box of each Cypress log (the logs of e2e-all.sh or e2e-up.sh),
                  average a spec over the logs that have it, and write ${TIMES_FILE}. A spec on disk that no log has keeps
                  its time from the file, and a spec no longer on disk is dropped. Record from the logs of a whole run of the
                  suite on every database, for example: node scripts/e2e-shards.mjs --record <out>/sqlite*.log <out>/postgres*.log
  -h, --help      Show this help.

The groups are computed from the files on disk each time; a recorded time for a spec that is no longer there is ignored, and the
same files and times always give the same groups. stdout holds only the groups, so scripts/e2e-all.sh can read them.
Exit code: 0 done, 1 a spec is in no group or in two, 2 bad arguments, more groups than spec files, a timings file that does not
parse, or a log with no Cypress summary (--counts) or no spec durations (--record).`;

/** Every spec file under e2e/cypress/e2e, as a path relative to e2e/ with forward slashes, sorted. */
export function listSpecs(root) {
  const base = join(root, SPEC_DIR);
  if (!existsSync(base)) return [];
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return SPEC_FILE.test(e.name) ? [p] : [];
    });
  return walk(base)
    .map((p) => relative(join(root, "e2e"), p).split(sep).join("/"))
    .sort();
}

/** A spec's weight: its tests, plus two for each server restart. At least 1, so an empty file still lands somewhere. */
export function weight(text) {
  const tests = (text.match(/(^|[^\w.$])it\(/g) || []).length;
  const restarts = (text.match(/cy\.resetServer\(/g) || []).length;
  return Math.max(1, tests + 2 * restarts);
}

/**
 * Splits specs into n groups: heaviest first, each into the lightest group so far (ties go to the lower group number), and specs of
 * equal weight in path order, so the same files always give the same groups. Each group is sorted by path.
 * @param {{ path: string, weight: number }[]} specs
 */
export function shard(specs, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`the shard count must be a whole number of 1 or more, not ${n}`);
  if (n > specs.length) throw new Error(`${n} shards is more than the ${specs.length} spec files`);
  const groups = Array.from({ length: n }, () => ({ weight: 0, paths: [] }));
  const order = [...specs].sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const s of order) {
    let best = groups[0];
    for (const g of groups) if (g.weight < best.weight) best = g;
    best.weight += s.weight;
    best.paths.push(s.path);
  }
  return groups.map((g) => g.paths.sort(byCodeUnit));
}

/** One line per problem: a spec in no group, in two, or a group naming a file that is not a spec. Empty when every spec is in one group. */
export function checkShards(specs, groups) {
  const seen = new Map();
  groups.forEach((g, i) => g.forEach((p) => seen.set(p, [...(seen.get(p) || []), i + 1])));
  const problems = [];
  for (const p of specs) {
    const in_ = seen.get(p) || [];
    if (in_.length === 0) problems.push(`${p} is in no shard`);
    else if (in_.length > 1) problems.push(`${p} is in shards ${in_.join(" and ")}`);
  }
  const known = new Set(specs);
  for (const p of seen.keys()) if (!known.has(p)) problems.push(`shard list names ${p}, which is not a spec file`);
  return problems;
}

/** The recorded times ({ path: seconds }), or null when there is no timings file. Throws when the file does not parse. */
export function readTimes(root) {
  const file = join(root, TIMES_FILE);
  if (!existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${TIMES_FILE} does not parse: ${e.message}`);
  }
  const times = data && typeof data === "object" ? data.times : undefined;
  if (!times || typeof times !== "object" || Array.isArray(times)) throw new Error(`${TIMES_FILE} has no "times" object`);
  for (const [p, t] of Object.entries(times)) {
    if (!Number.isInteger(t) || t < 1) throw new Error(`${TIMES_FILE}: the time of ${p} must be a whole number of seconds, 1 or more`);
  }
  return times;
}

/** The middle of the sorted values (the mean of the two middle ones, rounded, for an even count). */
export function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

/**
 * The weight of each spec on disk: its recorded seconds, or the median of the recorded times of the specs on disk when it has none.
 * A recorded time for a spec that is not on disk is ignored. With no times (null), or none for any spec on disk, the heuristic.
 * @returns {{ specs: { path: string, weight: number }[], missing: string[], fill: number | null, source: "times" | "heuristic" }}
 */
export function weigh(root, paths, times) {
  const known = times ? paths.filter((p) => Object.hasOwn(times, p)) : [];
  if (!known.length) {
    const specs = paths.map((p) => ({ path: p, weight: weight(readFileSync(join(root, "e2e", p), "utf8")) }));
    return { specs, missing: times ? [...paths] : [], fill: null, source: "heuristic" };
  }
  const fill = median(known.map((p) => times[p]));
  const missing = paths.filter((p) => !Object.hasOwn(times, p));
  return { specs: paths.map((p) => ({ path: p, weight: Object.hasOwn(times, p) ? times[p] : fill })), missing, fill, source: "times" };
}

/**
 * The groups for the spec files under root, checked, with each group's summed weight and how the specs were weighed. Throws on a bad
 * count or a timings file that does not parse; the problems are listed instead when the check fails.
 */
export function shardsFor(root, n) {
  const paths = listSpecs(root);
  const w = weigh(root, paths, readTimes(root));
  const groups = shard(w.specs, n);
  const of = new Map(w.specs.map((s) => [s.path, s.weight]));
  const weights = groups.map((g) => g.reduce((sum, p) => sum + of.get(p), 0));
  return { groups, problems: checkShards(paths, groups), weights, missing: w.missing, fill: w.fill, source: w.source };
}

const UNIT = { hour: 3600, minute: 60, second: 1 };

/** Seconds in a Cypress duration ("14 seconds", "2 minutes, 2 seconds", "1 hour, 3 minutes", "850ms"), or null when it is none. */
export function durationSeconds(text) {
  const trimmed = text.trim();
  if (trimmed.endsWith("ms")) {
    const n = trimmed.slice(0, -2).trim();
    if (/^\d+$/.test(n)) return Number(n) / 1000;
  }
  const parts = [...text.matchAll(/(\d+) (hour|minute|second)s?\b/g)];
  if (!parts.length) return null;
  return parts.reduce((sum, [, n, unit]) => sum + Number(n) * UNIT[unit], 0);
}

/**
 * Each spec's name and seconds from the (Results) box Cypress prints after a spec, in log order. The name is as Cypress shows it,
 * relative to the common folder of the specs of that run (resolveSpec turns it into a path). The end-of-run table is not read: it
 * cuts and wraps long names.
 */
export function specTimesIn(log) {
  const found = [];
  let box = null;
  let last = "";
  for (const line of log.split(/\r?\n/)) {
    if (line.includes("(Results)")) {
      box = { name: null, seconds: null };
      continue;
    }
    if (!box) continue;
    const cell = /│(.*)│/.exec(line);
    const body = cell ? cell[1].trim() : "";
    let m;
    if ((m = /^Duration:\s+(\S.*)$/.exec(body))) {
      box.seconds = durationSeconds(m[1]);
      last = "duration";
    } else if ((m = /^Spec Ran:\s+(\S+)$/.exec(body))) {
      box.name = m[1];
      last = "spec";
    } else if (cell && last === "spec" && /^[^\s:]+$/.test(body)) {
      box.name += body; // a long name wraps onto the next line of the box
    } else if (cell) {
      last = "";
    }
    if (line.includes("└")) {
      if (box.name && box.seconds !== null) found.push({ name: box.name, seconds: box.seconds });
      box = null;
      last = "";
    }
  }
  return found;
}

/** The path on disk (relative to e2e/) a name from a Cypress log means, or null when none or several do. */
export function resolveSpec(name, paths) {
  if (paths.includes(name)) return name;
  const hits = paths.filter((p) => p.endsWith(`/${name}`));
  if (hits.length === 1) return hits[0];
  const full = `cypress/e2e/${name}`;
  return hits.includes(full) ? full : null;
}

/**
 * The timings file's content from the logs' texts: each spec on disk that a log has, averaged over the logs that have it, rounded to
 * whole seconds and at least 1; then the old times of the other specs on disk. Keys sorted.
 * @returns {{ data: object, fromLogs: number, kept: number, unknown: string[], none: string[], empty: number[] }}
 */
export function record(logs, paths, old, recorded) {
  const seen = new Map();
  const unknown = new Set();
  const empty = [];
  logs.forEach((text, i) => {
    const specs = specTimesIn(text);
    if (!specs.length) empty.push(i);
    for (const { name, seconds } of specs) {
      const p = resolveSpec(name, paths);
      if (!p) {
        unknown.add(name);
        continue;
      }
      seen.set(p, [...(seen.get(p) || []), seconds]);
    }
  });
  const times = {};
  let kept = 0;
  const none = [];
  for (const p of paths) {
    const t = seen.get(p);
    if (t) times[p] = Math.max(1, Math.round(t.reduce((a, b) => a + b, 0) / t.length));
    else if (old && Object.hasOwn(old, p)) {
      times[p] = old[p];
      kept++;
    } else none.push(p);
  }
  const data = { about: ABOUT, recorded, logs: logs.length, times };
  return { data, fromLogs: seen.size, kept, unknown: [...unknown].sort(byCodeUnit), none, empty };
}

const num = (s) => (s === "-" ? 0 : Number(s));

/** The spec count Cypress found and the totals row of its last run summary, or null when the log has neither. */
export function countsIn(log) {
  const found = [...log.matchAll(/Specs:\s+(\d+) found/g)].pop();
  const total = [...log.matchAll(/^[ \t]*[✔✖][ \t]+(?:All specs passed!|\d+ of \d+ failed \(\d+%\))[ \t]+\S+[ \t]+(\d+|-)[ \t]+(\d+|-)[ \t]+(\d+|-)/gmu)].pop();
  if (!found || !total) return null;
  return { specs: Number(found[1]), tests: num(total[1]), passing: num(total[2]), failing: num(total[3]) };
}

/** The note on stderr about how the specs were weighed, when something is missing; empty when every spec has a recorded time. */
function weighNotes(r) {
  if (r.source === "heuristic") {
    const why = r.missing.length ? `${TIMES_FILE} has no time for any spec on disk` : `there is no ${TIMES_FILE}`;
    return [`e2e-shards: ${why}, so each spec is weighed by its tests and restarts, which predicts time badly; record the times with ${REFRESH}`];
  }
  if (!r.missing.length) return [];
  return [
    `e2e-shards: ${r.missing.length} spec(s) with no recorded time, weighed at the median (${r.fill} s): ${r.missing.join(", ")}`,
    `e2e-shards: refresh ${TIMES_FILE} with ${REFRESH} after a whole run`,
  ];
}

/** Today's local date as YYYY-MM-DD. */
function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The command line. Returns the exit code; writes through out and err. today() is the date written into a new timings file. */
export function main(argv, { root, out, err, today = localDate }) {
  const [cmd, ...rest] = argv;
  if (cmd === "-h" || cmd === "--help") {
    out(USAGE);
    return 0;
  }
  if (cmd === "--list") {
    listSpecs(root).forEach((p) => out(p));
    return 0;
  }
  if (cmd === "--shards" && (rest.length === 1 || (rest.length === 2 && rest[1] === "--explain"))) {
    const n = /^\d+$/.test(rest[0]) ? Number(rest[0]) : Number.NaN;
    let result;
    try {
      result = shardsFor(root, n);
    } catch (e) {
      err(`e2e-shards: ${e.message}`);
      return 2;
    }
    if (result.problems.length) {
      result.problems.forEach((p) => err(`e2e-shards: ${p}`));
      return 1;
    }
    weighNotes(result).forEach((line) => err(line));
    if (rest[1] === "--explain") {
      const unit = result.source === "times" ? " s" : " (tests and restarts, not seconds)";
      result.groups.forEach((g, i) => err(`e2e-shards: shard ${i + 1}: ${g.length} specs, ${result.weights[i]}${unit}`));
    }
    result.groups.forEach((g) => out(g.join(",")));
    return 0;
  }
  if (cmd === "--counts" && rest.length > 0) {
    let code = 0;
    for (const f of rest) {
      const c = existsSync(f) ? countsIn(readFileSync(f, "utf8")) : null;
      if (c) out(`specs=${c.specs} tests=${c.tests} passing=${c.passing} failing=${c.failing}`);
      else {
        out("specs=? tests=? passing=? failing=?");
        err(`e2e-shards: no Cypress summary in ${f}`);
        code = 2;
      }
    }
    return code;
  }
  if (cmd === "--record" && rest.length > 0) {
    const gone = rest.filter((f) => !existsSync(f));
    if (gone.length) {
      err(`e2e-shards: no such log: ${gone.join(", ")}; nothing was written`);
      return 2;
    }
    let old;
    try {
      old = readTimes(root);
    } catch (e) {
      err(`e2e-shards: ${e.message}; fix or delete it, then record again`);
      return 2;
    }
    const r = record(rest.map((f) => readFileSync(f, "utf8")), listSpecs(root), old, today());
    if (r.empty.length) {
      err(`e2e-shards: no spec durations ((Results) boxes) in ${r.empty.map((i) => rest[i]).join(", ")}; nothing was written`);
      return 2;
    }
    writeFileSync(join(root, TIMES_FILE), `${JSON.stringify(r.data, null, 2)}\n`);
    out(`e2e-shards: wrote ${TIMES_FILE}: ${Object.keys(r.data.times).length} specs, ${r.fromLogs} from ${rest.length} log(s), ${r.kept} kept from the old file`);
    if (r.unknown.length) err(`e2e-shards: not a spec on disk (skipped): ${r.unknown.join(", ")}`);
    if (r.none.length) err(`e2e-shards: no time in any log or the old file, so weighed at the median: ${r.none.join(", ")}`);
    return 0;
  }
  err(`e2e-shards: unknown arguments: ${argv.join(" ") || "(none)"} (see --help)`);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  process.exitCode = main(process.argv.slice(2), { root, out: (s) => console.log(s), err: (s) => console.error(s) });
}
