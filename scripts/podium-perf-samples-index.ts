#!/usr/bin/env -S npx tsx
// Measures the `samples(t)` index (#755, finding 11 in docs/PERFORMANCE.md) on a database holding the retention window's worth of samples.
//
// For each database named it seeds `--sessions` live sessions with one sample a second for `--hours` hours (the default retention is 24),
// then times, with the index dropped and again with it, the three things that read `samples` by time alone: `fleetTokensPerSecond` (every
// tick), `fleetCostPerMinute` (every five seconds) and the hourly retention delete. It also reports the index's size on disk and what it
// costs on the write path (`upsertSample`, the call the one-second sweep makes). Timings go through `Storage`, as the server calls them. The
// statements that are not a `Storage` call (seeding, dropping and creating the index, reading its size) are each adapter's own, behind
// `samplesPerf()` of its entry in the storage registry, so this script writes no SQL and imports no driver.
//
// It writes only to a database of its own, made and removed by the adapter: a SQLite file in a new temporary folder, and a database on the
// PostgreSQL or MariaDB server that PODIUM_TEST_PG or PODIUM_TEST_MARIADB names (the throwaway servers of `scripts/test-db.sh`).
// It never touches a server you use.
import { performance } from 'node:perf_hooks';
import { contractAdapterFor, openStorage } from '../server/src/storage/index.ts';
import type { SamplesPerf } from '../server/src/storage/contractAdapter.ts';

const HELP = `podium-perf-samples-index: time the samples(t) index on a full-retention database (#755).

Usage: npx tsx scripts/podium-perf-samples-index.ts [--sqlite] [--pg] [--mariadb] [options]

Databases (at least one):
  --sqlite            a SQLite file in a new temporary folder, removed afterwards
  --pg                PostgreSQL, on the throwaway server PODIUM_TEST_PG names (a database is made on it and dropped)
  --mariadb           MariaDB, on the throwaway server PODIUM_TEST_MARIADB names (a database is made on it and dropped)

Options:
  --sessions N        live sessions (default 20)
  --hours N           hours of samples, one a second for each session (default 24, the default retention)
  --reps N            repeats of each timed query (default 15); the median and the worst are reported
  --writes N          upsertSample calls timed for the write cost, each round (default 3000)
  --json FILE         also write the result as JSON
  -h, --help          show this help

The retention delete is timed on the oldest hour of samples, once with the index dropped and once with it (a different hour each time,
so the two deletes are the same size).`;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}
const arg = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const num = (n: string, d: number): number => {
  const v = Number(arg(n) ?? d);
  if (!Number.isFinite(v) || v < 1) throw new Error(`${n} must be a number of at least 1`);
  return v;
};
const KINDS_ASKED = (): boolean => ['--sqlite', '--pg', '--mariadb'].some((f) => args.includes(f));
const SESSIONS = num('--sessions', 20);
const HOURS = num('--hours', 24);
const REPS = num('--reps', 15);
const WRITES = num('--writes', 3000);
const JSON_OUT = arg('--json');
if (!KINDS_ASKED()) {
  console.error('Name at least one database: --sqlite, --pg or --mariadb. See --help.');
  process.exit(2);
}

/** One database kind to measure: the adapter's own helper makes the database and holds every statement that is not a `Storage` call. */
const KINDS: { flag: string; kind: string; serverVar: string | null }[] = [
  { flag: '--sqlite', kind: 'sqlite', serverVar: null },
  { flag: '--pg', kind: 'postgres', serverVar: 'PODIUM_TEST_PG' },
  { flag: '--mariadb', kind: 'mariadb', serverVar: 'PODIUM_TEST_MARIADB' },
];
const SECONDS = HOURS * 3600;
const sessionId = (i: number): string => `perf-${String(i).padStart(3, '0')}`;

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const ms = (n: number): number => Math.round(n * 100) / 100;

async function time(reps: number, fn: () => Promise<unknown>): Promise<{ median: number; max: number }> {
  await fn(); // one warm-up, so a cold cache does not count against the first state measured
  const xs: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await fn();
    xs.push(performance.now() - t0);
  }
  return { median: ms(median(xs)), max: ms(Math.max(...xs)) };
}

interface State {
  tokensPerSecond: { median: number; max: number };
  costPerMinute: { median: number; max: number };
  retainDeleteMs: number;
  retainDeleted: number;
  writeMsPerCall: number;
}

async function measure(d: SamplesPerf, nowSec: number, retainHour: number, withIndex: boolean): Promise<State> {
  const st = await openStorage({ PODIUM_DB: d.podiumDb } as NodeJS.ProcessEnv);
  try {
    const tokensPerSecond = await time(REPS, () => st.fleet.fleetTokensPerSecond(nowSec - 61));
    const costPerMinute = await time(REPS, () => st.fleet.fleetCostPerMinute((Math.floor(nowSec / 60) - 59) * 60));
    // The write path: new distinct rows after the seeded ones, one session, as the sweep writes them. Median of 3 rounds of WRITES calls.
    const rounds: number[] = [];
    for (let r = 0; r < 3; r++) {
      const base = nowSec + 1000 + r * WRITES + (withIndex ? 100_000 : 0);
      const t0 = performance.now();
      for (let i = 0; i < WRITES; i++) {
        await st.fleet.upsertSample({ session_id: sessionId(0), t: base + i, tokens_total: i, tokens_delta: 1, peak_context: 0.4, running_agents: 1, cost_usd: 0.01 });
      }
      rounds.push((performance.now() - t0) / WRITES);
    }
    // The hourly retention delete, deleting the oldest `retainHour` hours of what is left. Only `samples` can match in this database.
    const cutoffNow = nowSec - SECONDS + retainHour * 3600 + HOURS * 3600; // retain keeps `samplesMs` back from `now`
    const t0 = performance.now();
    const gone = await st.fleet.retain(cutoffNow * 1000, { samplesMs: HOURS * 3600_000, eventsMs: 1e15, sessionsMs: 1e15, adminLogMs: 1e15 });
    return { tokensPerSecond, costPerMinute, retainDeleteMs: ms(performance.now() - t0), retainDeleted: gone.samples, writeMsPerCall: Math.round(median(rounds) * 10000) / 10000 };
  } finally {
    await st.close();
  }
}

async function run(kind: string, d: SamplesPerf): Promise<Record<string, unknown>> {
  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`\n== ${kind}: seeding ${SESSIONS} sessions x ${SECONDS} s ...`);
  const s0 = performance.now();
  await d.seed(SESSIONS, SECONDS, nowSec);
  console.log(`   ${await d.rows()} rows in ${Math.round((performance.now() - s0) / 1000)} s`);
  await d.dropIndex();
  console.log('   measuring without the index ...');
  const before = await measure(d, nowSec, 1, false);
  const t0 = performance.now();
  await d.createIndex();
  const buildMs = Math.round(performance.now() - t0);
  const bytes = await d.indexBytes();
  console.log('   measuring with the index ...');
  const after = await measure(d, nowSec, 2, true);
  const out = { kind, sessions: SESSIONS, hours: HOURS, rows: SESSIONS * SECONDS, before, after, indexBuildMs: buildMs, indexBytes: bytes };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

const results: Record<string, unknown>[] = [];
for (const { flag, kind, serverVar } of KINDS) {
  if (!args.includes(flag)) continue;
  if (serverVar && !process.env[serverVar]) {
    console.error(`${flag} needs ${serverVar} set to a throwaway server (scripts/test-db.sh starts one).`);
    process.exit(2);
  }
  const adapter = await contractAdapterFor(kind);
  const d = await adapter.samplesPerf!();
  try {
    results.push(await run(kind, d));
  } finally {
    await d.close();
    await adapter.dispose();
  }
}
if (JSON_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
}
