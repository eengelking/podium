#!/usr/bin/env -S npx tsx
// Seeds a throwaway activity.sqlite with realistic Activity feed entries, to measure the Activity history store (#432) at a
// volume no short simulator run reaches: the seeding rate, the file size per million rows, and how the reads, the purge and
// the compaction behave on a big file.
//
// It writes through the server's own openActivityDb (so the schema, the indexes and the pragmas are the real ones) with one
// prepared INSERT in large transactions, and fills stored_sessions. Every random choice comes from a seeded generator, so one
// seed and one "now" always give the same rows.
//
// It only writes into a folder passed with --out. It refuses the folder of the server's real data (the repo's data/, the
// $PODIUM_DB folder, the one in podiumctl's config, ~/.podium) and a folder that already holds an activity.sqlite with rows
// unless --force is given.
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openActivityDb } from '../server/src/fleet/activityDb.ts';
import { protectedFolders } from './podium-seed-history.ts';
import { Rng } from './podium-sim.ts';

const HELP = `podium-seed-activity: write Activity feed entries into a throwaway activity.sqlite, to load-test the Activity history.

Usage: npx tsx scripts/podium-seed-activity.ts --out <folder> [options]

Options:
  --out DIR         The folder to write activity.sqlite into (required; made if it is not there). It must not be the
                    folder of the server's real data: the repo's data/, the folder of $PODIUM_DB, the one in podiumctl's
                    config and ~/.podium are refused.
  --force           Replace an activity.sqlite that already holds rows (without it, such a file is refused)
  --sessions N      Sessions to simulate (default 100)
  --agents N        Agents per session; each is a loop beside the orchestrator's (default 4)
  --per-minute N    Entries per loop per minute (default 20)
  --days N          Days of history ending now; a fraction is allowed (default 1)
  --batch N         Rows per transaction (default 50000)
  --seed N          Random seed; the same seed and the same clock give the same rows (default 1)
  -h, --help        Show this help

Rows written = sessions x (1 + agents) x per-minute x 1440 x days. The defaults make about 14.4 million rows a day, which takes
a few gigabytes of disk. The entries have the shape of the feed: tool calls with paths and commands (up to 300 characters),
text, reasoning, a few Podium-sent entries, and some text containing [redacted].`;

export interface SeedOptions {
  sessions: number;
  agents: number;
  perMinute: number;
  days: number;
  batch: number;
  seed: number;
  /** The end of the span, in epoch ms; the entries run from `now - days` up to it. */
  now: number;
}

export interface SeedResult {
  rows: number;
  sessions: number;
  seconds: number;
  rowsPerSecond: number;
  bytes: number;
  file: string;
}

const MINUTE_MS = 60_000;
const TEXT_MAX = 300;
const PROJECTS = ['claude-dashboard', 'billing-api', 'infra-notes', 'mobile-app', 'data-pipeline'];
const OWNERS = ['Ed', 'Priya', 'Marcus', 'Tomoko', 'Sam', 'Lena'];
const DIRS = ['src', 'server/src/fleet', 'frontend/src/fleet', 'scripts', 'docs', 'mod/podium-reporter/hooks', 'tests/unit', 'packages/core/lib'];
const FILES = ['index.ts', 'fleet.ts', 'activity.ts', 'App.tsx', 'tokens.css', 'SPEC.md', 'reports.ts', 'db.ts', 'package.json', 'settings.test.ts'];
const COMMANDS = ['npm test', 'git status --short', 'git diff --stat', 'npm run build', 'rg -n "TODO" src', 'ls -la', 'node --version', 'npx tsc --noEmit', 'gh pr checks --watch', 'sqlite3 data/podium.sqlite ".tables"'];
const SENTENCES = [
  'The test fails because the fixture still carries the old field, so I will update it first.',
  'Reading the module to see how the purge picks its rows before changing the query.',
  'That should cover the empty case. Running the suite again to confirm nothing else moved.',
  'The build is green. Next I will check the narrow layout, then write the changelog entry.',
  'I found two callers of this function; both pass the same arguments, so the change is safe.',
  'The token [redacted] was in the log, so I removed the line and rotated nothing else.',
  'Opening a PR against the integration branch once the checks finish.',
  'Splitting the helper in two so each half has one reason to change.',
];
const THOUGHTS = [
  'The cheaper option is to read the index first and only then scan, which keeps the common path fast.',
  'If the cap is hit mid-batch the loop must stop, otherwise the total goes negative and the guard never fires.',
  'Two readers share this file, so the write has to stay inside one transaction.',
];
const PODIUM_TEXTS = ['Go ahead with option B.', 'Yes, run the migration.', '/compact', 'Please also update the docs.'];

const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng.next() * list.length)]!;

/** One feed entry: a kind and its text, cut to the feed's 300 characters. */
function entryOf(rng: Rng, project: string): { kind: 'tool' | 'text' | 'reasoning'; text: string } {
  const r = rng.next();
  if (r < 0.62) {
    const file = `/Users/ed/dev/${project}/${pick(rng, DIRS)}/${pick(rng, FILES)}`;
    const t = rng.next();
    let text: string;
    if (t < 0.35) text = `Read ${file}`;
    else if (t < 0.55) text = `Edit ${file}`;
    else if (t < 0.7) text = `Grep "${pick(rng, ['activity', 'purge', 'retention', 'seq'])}" in ${path.dirname(file)}`;
    else if (t < 0.9) text = `Bash: ${pick(rng, COMMANDS)}`;
    else text = `Bash: cd /Users/ed/dev/${project} && ${pick(rng, COMMANDS)} 2>&1 | tail -40 && echo "${'step-'.repeat(1 + Math.floor(rng.next() * 60))}done"`;
    return { kind: 'tool', text: text.slice(0, TEXT_MAX) };
  }
  if (r < 0.92) return { kind: 'text', text: pick(rng, SENTENCES) };
  return { kind: 'reasoning', text: pick(rng, THOUGHTS) };
}

/** Why `dir` may not be seeded, or null when it is a folder of its own to write. */
export function refusal(out: string | undefined, force: boolean, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  if (!out) return 'give the throwaway folder with --out DIR: it never seeds a folder it was not told to';
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const dir = real(path.resolve(out));
  const prot = protectedFolders(env, home);
  const folders = [...prot.folders, ...prot.files.map((f) => path.dirname(f))].map(real);
  const hit = folders.find((f) => dir === f || dir.startsWith(`${f}${path.sep}`));
  if (hit) return `${out} is the folder of the server's real data (${hit}); seed a folder somewhere else`;
  if (prot.files.some((f) => real(f) === path.join(dir, 'podium.sqlite'))) return `${out} holds the server's real podium.sqlite; seed a folder somewhere else`;
  const file = path.join(dir, 'activity.sqlite');
  if (existsSync(dir) && !statSync(dir).isDirectory()) return `${out} is not a folder`;
  if (!force && existsSync(file) && statSync(file).size > 0) {
    const db = openActivityDb(file);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;
    db.close();
    if (n > 0) return `${file} already holds ${n} rows; pass --force to replace it`;
  }
  return null;
}

/** Writes the entries into `<out>/activity.sqlite` and returns what it wrote. */
export function seedActivity(out: string, opt: SeedOptions, log: (line: string) => void = () => undefined): SeedResult {
  const started = performance.now();
  const dir = path.resolve(out);
  const file = path.join(dir, 'activity.sqlite');
  mkdirSync(dir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  const rng = new Rng(opt.seed);
  const db = openActivityDb(file);
  const minutes = Math.max(1, Math.round(opt.days * 1440));
  const start = opt.now - minutes * MINUTE_MS;
  const loopsPer = 1 + opt.agents;
  const sessions = Array.from({ length: opt.sessions }, (_, i) => ({
    id: `seed-${String(i + 1).padStart(4, '0')}-${Math.floor(rng.next() * 0xffffffff).toString(16).padStart(8, '0')}`,
    name: `${pick(rng, ['Fix', 'Refactor', 'Review', 'Investigate', 'Document'])} ${pick(rng, ['the purge', 'login flow', 'billing totals', 'the wall', 'retention'])} ${i + 1}`,
    project: pick(rng, PROJECTS),
    owner: pick(rng, OWNERS),
    skew: Math.floor(rng.next() * 2000),
    loops: Array.from({ length: loopsPer }, (_, l) => ({ name: l === 0 ? '@orchestrator' : `agent-${l}`, seq: 0 })),
  }));
  const put = db.prepare('INSERT INTO entries (session_id, loop, seq, at, t, kind, text, "by", note, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let rows = 0;
  let inBatch = 0;
  let batches = 0;
  db.exec('BEGIN');
  for (let m = 0; m < minutes; m++) {
    const minuteStart = start + m * MINUTE_MS;
    for (const s of sessions) {
      for (const loop of s.loops) {
        for (let j = 0; j < opt.perMinute; j++) {
          // Spread the entries of one minute evenly, with a little jitter that never crosses into the next entry.
          const at = minuteStart + Math.floor(((j + rng.next() * 0.9) / opt.perMinute) * MINUTE_MS);
          const t = at - s.skew;
          loop.seq += 1;
          if (rng.next() < 0.002) {
            put.run(s.id, loop.name, loop.seq, at, at, 'podium', pick(rng, PODIUM_TEXTS), s.owner, rng.next() < 0.5 ? 'taken' : 'queued', `ref-${rows}`);
          } else {
            const e = entryOf(rng, s.project);
            put.run(s.id, loop.name, loop.seq, at, t, e.kind, e.text, null, null, null);
          }
          rows += 1;
          inBatch += 1;
          if (inBatch >= opt.batch) {
            db.exec('COMMIT');
            db.exec('BEGIN');
            inBatch = 0;
            batches += 1;
            if (batches % 20 === 0) log(`  ${rows} rows, ${((performance.now() - started) / 1000).toFixed(0)} s`);
          }
        }
      }
    }
  }
  const putSession = db.prepare('INSERT INTO stored_sessions (session_id, name, project, owner, first_t, last_t) VALUES (?, ?, ?, ?, ?, ?)');
  for (const s of sessions) putSession.run(s.id, s.name, s.project, s.owner, start - s.skew, opt.now - s.skew);
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const seconds = (performance.now() - started) / 1000;
  return { rows, sessions: opt.sessions, seconds, rowsPerSecond: Math.round(rows / Math.max(seconds, 1e-9)), bytes: statSync(file).size, file };
}

export interface Args extends SeedOptions {
  out?: string;
  force: boolean;
}

export function parseArgs(argv: string[], now: number = Date.now()): Args | 'help' {
  const a: Args = { sessions: 100, agents: 4, perMinute: 20, days: 1, batch: 50_000, seed: 1, now, force: false };
  const whole = (name: string, v: string, min: number): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = (): string => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value (see --help)`);
      return x;
    };
    switch (k) {
      case '-h':
      case '--help':
        return 'help';
      case '--force':
        a.force = true;
        break;
      case '--out':
        a.out = v();
        break;
      case '--sessions':
        a.sessions = whole(k, v(), 1);
        break;
      case '--agents':
        a.agents = whole(k, v(), 0);
        break;
      case '--per-minute':
        a.perMinute = whole(k, v(), 1);
        break;
      case '--batch':
        a.batch = whole(k, v(), 1);
        break;
      case '--seed':
        a.seed = whole(k, v(), 0);
        break;
      case '--days':
        a.days = Number(v());
        if (!Number.isFinite(a.days) || a.days <= 0 || a.days > 3650) throw new Error('--days must be a number above 0 and up to 3650');
        break;
      default:
        throw new Error(`unknown option ${k} (see --help)`);
    }
  }
  return a;
}

/** Runs the command line; returns the exit code. */
export function main(argv: string[], log: (line: string) => void = console.log, err: (line: string) => void = console.error): number {
  let args: Args | 'help';
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`podium-seed-activity: ${(e as Error).message}`);
    return 2;
  }
  if (args === 'help') {
    log(HELP);
    return 0;
  }
  const why = refusal(args.out, args.force);
  if (why) {
    err(`podium-seed-activity: refusing: ${why}`);
    return 2;
  }
  const total = args.sessions * (1 + args.agents) * args.perMinute * Math.max(1, Math.round(args.days * 1440));
  log(`podium-seed-activity: writing ${total} rows (${args.sessions} sessions, ${1 + args.agents} loops each, ${args.perMinute} a minute, ${args.days} days) to ${path.resolve(args.out!)}`);
  const r = seedActivity(args.out!, args, log);
  log(`podium-seed-activity: wrote ${r.rows} rows for ${r.sessions} sessions in ${r.seconds.toFixed(1)} s (${r.rowsPerSecond} rows/s); ${r.file} is ${r.bytes} bytes (${(r.bytes / 1024 ** 2).toFixed(1)} MiB)`);
  return 0;
}

const isMain = (() => {
  try {
    return process.argv[1]?.endsWith('podium-seed-activity.ts') === true && import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();
if (isMain) process.exit(main(process.argv.slice(2)));
