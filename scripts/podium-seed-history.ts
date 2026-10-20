#!/usr/bin/env -S npx tsx
// Seeds about 45 days of daily rollups into a throwaway Podium database, so a person running the simulator can look at
// Admin > Reporting, the Spend projection and the long-period reports (#484, #483) without waiting for weeks of history.
//
// It writes the same rows the server's hourly retention writes (usage_daily, sessions_daily, failures_daily, fleet_daily),
// plus a few people, groups, reporters and Admin log entries, through the server's own migrations. Every random choice
// comes from a seeded generator, so one seed and one "today" always give the same rows.
//
// It only writes to a database passed with --db. It refuses the server's real database (the default one, $PODIUM_DB, the
// one in podiumctl's config, or anything in their folders): seed history belongs in a file you can throw away.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/src/fleet/db.ts';
import { PeopleStore } from '../server/src/fleet/people.ts';
import { Pricing } from '../server/src/fleet/pricing.ts';
import { addDays, localDay } from '../server/src/fleet/rollups.ts';
import { Rng } from './podium-sim.ts';

const HELP = `podium-seed-history: write about 45 days of Admin > Reporting history into a throwaway Podium database.

Usage: npx tsx scripts/podium-seed-history.ts --db <throwaway.db> [options]

Options:
  --db PATH     The SQLite file to write (required; made and migrated if it is not there). It must not be the
                server's real database: the default data/podium.sqlite, $PODIUM_DB, the one in podiumctl's
                config (~/.podium) and anything in those folders are refused.
  --days N      Days of history to write, ending yesterday (default 45, 14 to 395)
  --seed N      Random seed; the same seed gives the same rows (default 1)
  --today DAY   Treat DAY (YYYY-MM-DD) as today, for a repeatable run (default: today)
  -h, --help    Show this help

What it writes: people Ed, Priya, Marcus, Tomoko, Sam and Lena in groups Backend and Platform (Sam was active on only 2 days,
so his projection says "Not enough history"; Lena never reported), one model with no price (its cost is null), failures
across classes and tools, a few agent-heavy days, a spread of reporter and engine versions, and Admin log entries.
Then run the server on that file, for example:
  PODIUM_DB=<throwaway.db> PORT=4391 npm run dev -w server
and the simulator against it: npm run podium:sim -- --url http://127.0.0.1:4391`;

export interface SeedOptions {
  days: number;
  seed: number;
  /** `YYYY-MM-DD` of today; history ends the day before. */
  today: string;
}

export interface SeedResult {
  days: number;
  usage: number;
  sessions: number;
  failures: number;
  people: number;
  adminLog: number;
}

const GROUPS = { Backend: ['Priya', 'Marcus', 'Ed'], Platform: ['Tomoko', 'Sam'] } as const;
const PEOPLE = ['Ed', 'Priya', 'Marcus', 'Tomoko', 'Sam', 'Lena'] as const;
/** Who works how much: the chance of a session slot on a weekday. Sam is handled apart, Lena never reports. */
const PACE: Record<string, number> = { Ed: 0.9, Priya: 0.8, Marcus: 0.6, Tomoko: 0.45 };
const MODELS = [
  { name: 'claude-opus-5-5', weight: 4 },
  { name: 'claude-sonnet-5-5', weight: 4 },
  { name: 'claude-haiku-4-5', weight: 2 },
  { name: 'local-llama-3', weight: 1 }, // a model nobody priced: its cost stays out
] as const;
const PROJECTS = ['claude-dashboard', 'billing-api', 'infra-notes', 'mobile-app'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const PLANS = ['TaskCreate', 'TodoWrite', 'podium_plan', 'none'];
const OUTCOMES = ['completed', 'completed', 'completed', 'interrupted', 'error', 'cleared'];
const FAILURES: { cls: string; tool: string }[] = [
  { cls: 'Tool error', tool: 'Bash' },
  { cls: 'Tool error', tool: 'Edit' },
  { cls: 'Blocked by permission', tool: 'Bash' },
  { cls: 'Blocked by permission', tool: 'WebFetch' },
  { cls: 'Model API error', tool: '' },
  { cls: 'Context window exhausted', tool: '' },
  { cls: 'Aborted', tool: 'Task' },
];
/** The reporter version a day runs, as people upgrade: [first day offset from the start as a share of the span, version]. */
const REPORTER_RELEASES: [number, string][] = [[0, '1.1.0'], [0.35, '1.2.0'], [0.7, '1.2.2']];
const ENGINE_VERSIONS = ['2.1.288', '2.1.296', '2.1.301'];

/** Paths the server's real database could live at: seeding any of them is refused. */
export function protectedFolders(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): { files: string[]; folders: string[] } {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const podiumHome = env.PODIUMCTL_HOME || path.join(home, '.podium');
  const files = [path.join(repo, 'data', 'podium.sqlite'), path.join(podiumHome, 'data', 'podium.sqlite')];
  if (env.PODIUM_DB) files.push(path.resolve(env.PODIUM_DB));
  try {
    const line = readFileSync(path.join(podiumHome, 'config.env'), 'utf8').split('\n').find((l) => l.startsWith('PODIUM_DB='));
    if (line) files.push(path.resolve(line.slice('PODIUM_DB='.length).trim().replace(/^["']|["']$/g, '')));
  } catch {
    // no podiumctl config: nothing more to protect
  }
  return { files, folders: [path.join(repo, 'data'), podiumHome] };
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    // the file is not there yet: resolve its folder instead, so a link in the way is still followed
    try {
      return path.join(realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
};

/** Why `db` may not be seeded, or null when it is a file of its own to write. */
export function refusal(db: string | undefined, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  if (!db) return 'give the throwaway database with --db PATH: it never seeds a database it was not told to';
  if (db === ':memory:') return 'a memory database would be gone at once; give a file with --db PATH';
  const target = real(path.resolve(db));
  const base = target.replace(/-(wal|shm)$/, '');
  const { files, folders } = protectedFolders(env, home);
  if (files.some((f) => real(f) === base)) return `${db} is the server's real database; seed a throwaway file instead`;
  if (folders.some((d) => base.startsWith(`${real(d)}${path.sep}`))) return `${db} is in the folder of the server's real data (${folders.find((d) => base.startsWith(`${real(d)}${path.sep}`))}); seed a file somewhere else`;
  if (existsSync(target) && statSync(target).isDirectory()) return `${db} is a folder; give a file`;
  return null;
}

const isWeekend = (day: string): boolean => {
  const dow = new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))).getDay();
  return dow === 0 || dow === 6;
};

interface Cost { sessions: number; agents: number; cost: number; unpriced: number; tokIn: number; tokOut: number; tokCr: number; tokCw: number }

/** Writes the history into an open database through the server's own tables and returns what it wrote. */
export function seedHistory(file: string, opt: SeedOptions): SeedResult {
  const rng = new Rng(opt.seed);
  const db = openDb(file);
  const people = new PeopleStore(db);
  const pricing = new Pricing({});
  const SRC = 'seed-history';
  const first = addDays(opt.today, -opt.days);
  const dayList = Array.from({ length: opt.days }, (_, i) => addDays(first, i));
  const startMs = (day: string) => new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 9).getTime();

  db.exec('BEGIN');
  try {
    // People and groups, made the way Admin makes them, only when they are not there yet.
    const groupIds = new Map<string, number>();
    for (const g of Object.keys(GROUPS)) {
      const have = people.allGroups().find((x) => x.name === g);
      groupIds.set(g, have ? have.id : people.createGroup(g, startMs(first)).id);
    }
    const groupOf = (name: string): string => Object.entries(GROUPS).find(([, m]) => (m as readonly string[]).includes(name))?.[0] ?? '';
    for (const name of PEOPLE) {
      const exists = db.prepare('SELECT 1 AS x FROM people WHERE name_lower = ?').get(name.toLowerCase());
      if (!exists) people.createPerson(name, groupIds.get(groupOf(name)) ?? null, startMs(first));
    }

    for (const t of ['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily']) db.prepare(`DELETE FROM ${t} WHERE day >= ? AND day <= ?`).run(first, addDays(opt.today, -1));
    const putUsage = db.prepare('INSERT INTO usage_daily (day, owner, group_name, model, project, sessions, agents, cost_usd, unpriced_sessions, tok_in, tok_out, tok_cr, tok_cw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const putSessions = db.prepare('INSERT INTO sessions_daily (day, outcome, model, effort, plan, sessions, duration_s, max_duration_s, agents, blowouts, max_context_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const putFailure = db.prepare('INSERT INTO failures_daily (day, owner, class, tool, count) VALUES (?, ?, ?, ?, ?)');
    const putFleet = db.prepare('INSERT INTO fleet_daily (day, active_people, active_reporters, sessions_started, peak_live_sessions, reporter_versions_json, engine_versions_json) VALUES (?, ?, ?, ?, ?, ?, ?)');

    // Two agent-heavy days, and the two days Sam works (both in the last two weeks, so the projection's window sees 2 of 14).
    const heavy = new Set([addDays(opt.today, -Math.round(opt.days * 0.6)), addDays(opt.today, -Math.round(opt.days * 0.25))]);
    const samDays = new Set([addDays(opt.today, -4), addDays(opt.today, -9)]);
    const counts = { usage: 0, sessions: 0, failures: 0 };
    const lastSeen = new Map<string, number>();

    dayList.forEach((day, di) => {
      const usage = new Map<string, Cost & { owner: string; model: string; project: string }>();
      const sess = new Map<string, { outcome: string; model: string; effort: string; plan: string; sessions: number; dur: number; maxDur: number; agents: number; blow: number; ctx: number }>();
      const fail = new Map<string, { owner: string; cls: string; tool: string; n: number }>();
      const active = new Set<string>();
      let started = 0;
      const weekend = isWeekend(day);
      for (const owner of PEOPLE) {
        const works = owner === 'Sam' ? samDays.has(day) : owner === 'Lena' ? false : rng.next() < (PACE[owner] ?? 0.5) * (weekend ? 0.2 : 1);
        if (!works) continue;
        active.add(owner);
        const n = owner === 'Sam' ? 2 : 1 + Math.floor(rng.next() * 4);
        for (let i = 0; i < n; i++) {
          started += 1;
          const pick = rng.next() * MODELS.reduce((s, m) => s + m.weight, 0);
          let acc = 0;
          const model = (MODELS.find((m) => (acc += m.weight) > pick) ?? MODELS[0]).name;
          const project = PROJECTS[Math.floor(rng.next() * PROJECTS.length)]!;
          const agents = heavy.has(day) ? 8 + Math.floor(rng.next() * 8) : Math.floor(rng.next() * 4);
          const tokIn = Math.round((40_000 + rng.next() * 400_000) * (1 + agents / 4));
          const tokOut = Math.round(tokIn * (0.04 + rng.next() * 0.08));
          const tokCr = Math.round(tokIn * (2 + rng.next() * 6));
          const tokCw = Math.round(tokIn * 0.3);
          const usd = pricing.costOf([{ model, tier: 'std', tokens: { input: tokIn, output: tokOut, cacheRead: tokCr, cacheWrite: tokCw, cacheWrite1h: 0 } }]);
          const uk = `${owner}\u0000${model}\u0000${project}`;
          const u = usage.get(uk) ?? { owner, model, project, sessions: 0, agents: 0, cost: 0, unpriced: 0, tokIn: 0, tokOut: 0, tokCr: 0, tokCw: 0 };
          u.sessions += 1;
          u.agents += agents;
          if (usd === null) u.unpriced += 1;
          else u.cost += usd;
          u.tokIn += tokIn;
          u.tokOut += tokOut;
          u.tokCr += tokCr;
          u.tokCw += tokCw;
          usage.set(uk, u);

          const outcome = OUTCOMES[Math.floor(rng.next() * OUTCOMES.length)]!;
          const effort = EFFORTS[Math.floor(rng.next() * EFFORTS.length)]!;
          const plan = PLANS[Math.floor(rng.next() * PLANS.length)]!;
          const dur = Math.round(300 + rng.next() * 5400 * (1 + agents / 6));
          const blow = rng.next() < 0.12 ? 1 : 0;
          const ctx = Math.round((35 + rng.next() * 60) * 10) / 10;
          const sk = `${outcome}\u0000${model}\u0000${effort}\u0000${plan}`;
          const s = sess.get(sk) ?? { outcome, model, effort, plan, sessions: 0, dur: 0, maxDur: 0, agents: 0, blow: 0, ctx: 0 };
          s.sessions += 1;
          s.dur += dur;
          s.maxDur = Math.max(s.maxDur, dur);
          s.agents += agents;
          s.blow += blow;
          s.ctx = Math.max(s.ctx, ctx);
          sess.set(sk, s);

          if (outcome === 'error' || rng.next() < 0.1) {
            const f = FAILURES[Math.floor(rng.next() * FAILURES.length)]!;
            const fk = `${owner}\u0000${f.cls}\u0000${f.tool}`;
            const row = fail.get(fk) ?? { owner, cls: f.cls, tool: f.tool, n: 0 };
            row.n += 1;
            fail.set(fk, row);
          }
        }
        lastSeen.set(owner, startMs(day) + 3_600_000);
      }
      for (const u of usage.values()) {
        putUsage.run(day, u.owner, groupOf(u.owner), u.model, u.project, u.sessions, u.agents, Math.round(u.cost * 1e6) / 1e6, u.unpriced, u.tokIn, u.tokOut, u.tokCr, u.tokCw);
        counts.usage += 1;
      }
      for (const s of sess.values()) {
        putSessions.run(day, s.outcome, s.model, s.effort, s.plan, s.sessions, s.dur, s.maxDur, s.agents, s.blow, s.ctx);
        counts.sessions += 1;
      }
      for (const f of fail.values()) {
        putFailure.run(day, f.owner, f.cls, f.tool, f.n);
        counts.failures += 1;
      }
      // Reporters: one per active person, plus Ed's second machine; versions move up as the span goes on.
      const share = di / Math.max(1, dayList.length - 1);
      const rv: Record<string, number> = {};
      const ev: Record<string, number> = {};
      const reporters = active.size + (active.has('Ed') ? 1 : 0);
      for (let r = 0; r < reporters; r++) {
        const ahead = share >= (REPORTER_RELEASES[2]![0] + (r % 3) * 0.05) ? 2 : share >= REPORTER_RELEASES[1]![0] + (r % 2) * 0.1 ? 1 : 0;
        const v = REPORTER_RELEASES[ahead]![1];
        rv[v] = (rv[v] ?? 0) + 1;
        const e = ENGINE_VERSIONS[Math.min(2, ahead + (r % 2))]!;
        ev[e] = (ev[e] ?? 0) + 1;
      }
      putFleet.run(day, active.size, reporters, started, started === 0 ? 0 : Math.max(1, Math.min(8, Math.round(started / 2 + rng.next() * 2))), JSON.stringify(rv), JSON.stringify(ev));
    });

    // Reporters and the last time each person reported, so the People and groups page has something to say.
    const lastDay = addDays(opt.today, -1);
    db.prepare('DELETE FROM reporters WHERE key LIKE ?').run('seed-%');
    const putReporter = db.prepare("INSERT INTO reporters (key, kind, machine_id, owner, reporter_version, engine_version, first_seen_at, last_seen_at) VALUES (?, 'mod', ?, ?, ?, ?, ?, ?)");
    [['Ed', 'mbp', '1.2.2'], ['Ed', 'studio', '1.2.0'], ['Priya', 'laptop', '1.2.2'], ['Marcus', 'dev-box', '1.2.0'], ['Tomoko', 'thinkpad', '1.1.0'], ['Sam', 'chromebook', '1.1.0']].forEach(([owner, machine, version]) => {
      putReporter.run(`seed-${machine}`, `seed-${machine}`, owner, version, ENGINE_VERSIONS[2], startMs(first), lastSeen.get(owner!) ?? startMs(lastDay));
    });
    for (const [name, t] of lastSeen) db.prepare('UPDATE people SET last_report_at = ? WHERE name = ?').run(t, name);

    // The Admin log: who did what, spread over the span, written the way Admin writes it.
    db.prepare('DELETE FROM admin_log WHERE source = ?').run(SRC);
    const entries: [string, string][] = [
      ['unlock', 'Admin unlocked'], ['group_created', 'Created group Backend'], ['group_created', 'Created group Platform'], ['person_created', 'Created person Priya'],
      ['person_created', 'Created person Marcus'], ['person_created', 'Created person Tomoko'], ['person_created', 'Created person Sam'], ['person_created', 'Created person Lena'],
      ['person_group_set', 'Moved Tomoko to Platform'], ['model_price_changed', 'Set the price of local-llama-3'], ['setting_changed', 'Turned the wall notice about stale sessions off'],
      ['token_rotated', 'Rotated the token of Marcus'], ['unlock', 'Admin unlocked'], ['unlock_failed', 'A wrong admin secret was tried'], ['reporter_removed', 'Removed the reporter chromebook'],
      ['person_revoked', 'Revoked the token of Sam'], ['unlock', 'Admin unlocked'], ['setting_changed', 'Turned Respond from Podium on'],
    ];
    entries.forEach(([kind, detail], i) => {
      const day = dayList[Math.min(dayList.length - 1, Math.floor((i / entries.length) * dayList.length))]!;
      people.log(kind, detail, SRC, startMs(day) + i * 60_000, 'Admin');
    });

    db.exec('COMMIT');
    db.close();
    return { days: opt.days, usage: counts.usage, sessions: counts.sessions, failures: counts.failures, people: PEOPLE.length, adminLog: entries.length };
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
}

export interface Args {
  db?: string;
  days: number;
  seed: number;
  today: string;
}

export function parseArgs(argv: string[], now: number = Date.now()): Args | 'help' {
  const a: Args = { days: 45, seed: 1, today: localDay(now) };
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
      case '--db':
        a.db = v();
        break;
      case '--days':
        a.days = Number(v());
        if (!Number.isInteger(a.days) || a.days < 14 || a.days > 395) throw new Error('--days must be a whole number from 14 to 395');
        break;
      case '--seed':
        a.seed = Number(v());
        if (!Number.isInteger(a.seed) || a.seed < 0) throw new Error('--seed must be a whole number');
        break;
      case '--today':
        a.today = v();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(a.today) || localDay(new Date(Number(a.today.slice(0, 4)), Number(a.today.slice(5, 7)) - 1, Number(a.today.slice(8, 10))).getTime()) !== a.today) throw new Error('--today must be a day as YYYY-MM-DD');
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
    err(`podium-seed-history: ${(e as Error).message}`);
    return 2;
  }
  if (args === 'help') {
    log(HELP);
    return 0;
  }
  const why = refusal(args.db);
  if (why) {
    err(`podium-seed-history: refusing: ${why}`);
    return 2;
  }
  const r = seedHistory(path.resolve(args.db!), args);
  log(`podium-seed-history: wrote ${r.days} days (${args.today} is read live) to ${path.resolve(args.db!)}: ${r.usage} usage rows, ${r.sessions} session rows, ${r.failures} failure rows, ${r.people} people, ${r.adminLog} Admin log entries`);
  log(`Run a server on it: PODIUM_DB=${path.resolve(args.db!)} PORT=4391 npm run dev -w server   (then npm run podium:sim -- --url http://127.0.0.1:4391)`);
  return 0;
}

const isMain = (() => {
  try {
    return process.argv[1]?.endsWith('podium-seed-history.ts') === true && import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();
if (isMain) process.exit(main(process.argv.slice(2)));

