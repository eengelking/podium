#!/usr/bin/env -S npx tsx
// Measures the `samples(t)` index (#755, finding 11 in docs/PERFORMANCE.md) on a database holding the retention window's worth of samples.
//
// For each database named it seeds `--sessions` live sessions with one sample a second for `--hours` hours (the default retention is 24),
// then times, with the index dropped and again with it, the three things that read `samples` by time alone: `fleetTokensPerSecond` (every
// tick), `fleetCostPerMinute` (every five seconds) and the hourly retention delete. It also reports the index's size on disk and what it
// costs on the write path (`upsertSample`, the call the one-second sweep makes). Timings go through `Storage`, as the server calls them;
// only the seeding, the index drop and create, and the size read use the database directly, which is why this is a script and not server code.
//
// It writes only to a database of its own: a SQLite file in a new temporary folder, and a database made on the PostgreSQL or MariaDB server
// you name, dropped afterwards (`scripts/throwaway-db.mjs`). It never touches a server you use. Start a server with a container, as
// `scripts/test-db.sh` does, and pass its URL.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { openStorage } from '../server/src/storage/index.ts';
import { createDatabase, dropDatabase, mariadbAdminOptions } from './throwaway-db.mjs';

const HELP = `podium-perf-samples-index: time the samples(t) index on a full-retention database (#755).

Usage: npx tsx scripts/podium-perf-samples-index.ts [--sqlite] [--pg <server-url>] [--mariadb <server-url>] [options]

Databases (at least one):
  --sqlite            a SQLite file in a new temporary folder, removed afterwards
  --pg URL            a PostgreSQL server (postgres://user:pass@host:port/postgres); a database is made on it and dropped
  --mariadb URL       a MariaDB server (mariadb://user:pass@host:port/); a database is made on it and dropped

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
const SESSIONS = num('--sessions', 20);
const HOURS = num('--hours', 24);
const REPS = num('--reps', 15);
const WRITES = num('--writes', 3000);
const JSON_OUT = arg('--json');
if (!args.includes('--sqlite') && !arg('--pg') && !arg('--mariadb')) {
  console.error('Name at least one database: --sqlite, --pg <url> or --mariadb <url>. See --help.');
  process.exit(2);
}

const require = createRequire(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server', 'package.json'));

/** What one database kind needs the script to do directly. */
interface Driver {
  label: string;
  /** PODIUM_DB for `openStorage`. */
  target: string;
  /** Fills `samples` with SESSIONS x seconds rows ending at `endSec`. */
  seed(endSec: number): Promise<void>;
  dropIndex(): Promise<void>;
  createIndex(): Promise<void>;
  /** Bytes the index takes on disk, measured as the database reports it. */
  indexBytes(): Promise<number | null>;
  rows(): Promise<number>;
  close(): Promise<void>;
}

const SECONDS = HOURS * 3600;
const sessionId = (i: number): string => `perf-${String(i).padStart(3, '0')}`;

async function sqliteDriver(): Promise<Driver> {
  const dir = mkdtempSync(path.join(tmpdir(), 'podium-samples-index-'));
  const file = path.join(dir, 'perf.sqlite');
  const { openDb } = await import('../server/src/storage/sqlite/db.ts');
  const db = openDb(file); // migrates to the current schema; the index is made here
  return {
    label: 'sqlite',
    target: file,
    async seed(endSec) {
      db.exec('BEGIN');
      const ins = db.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO samples (session_id, t, tokens_total, tokens_delta, peak_context, running_agents, cost_usd)
         SELECT ?, ? - i, i * 100, 100, 0.4, 2, i * 0.0001 FROM n`,
      );
      for (let s = 0; s < SESSIONS; s++) ins.run(SECONDS - 1, sessionId(s), endSec);
      db.exec('COMMIT');
    },
    async dropIndex() { db.exec('DROP INDEX IF EXISTS samples_t'); },
    async createIndex() { db.exec('CREATE INDEX IF NOT EXISTS samples_t ON samples(t)'); },
    async indexBytes() {
      try {
        return Number((db.prepare("SELECT SUM(pgsize) AS b FROM dbstat WHERE name = 'samples_t'").get() as { b: number }).b);
      } catch {
        return null; // dbstat is not compiled into this SQLite
      }
    },
    async rows() { return Number((db.prepare('SELECT COUNT(*) AS n FROM samples').get() as { n: number }).n); },
    async close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function pgDriver(serverUrl: string): Promise<Driver> {
  const pg = require('pg');
  const url: string = await createDatabase(serverUrl, 'samples');
  // Open as the server does, so the schema and its migrations exist before the seed.
  const st = await openStorage({ PODIUM_DB: url } as NodeJS.ProcessEnv);
  await st.close();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return {
    label: 'postgres',
    target: url,
    async seed(endSec) {
      for (let s = 0; s < SESSIONS; s++) {
        await client.query(
          `INSERT INTO podium.samples (session_id, t, tokens_total, tokens_delta, peak_context, running_agents, cost_usd)
           SELECT $1, $2::bigint - g, g * 100, 100, 0.4, 2, g * 0.0001 FROM generate_series(0, $3::int) AS g`,
          [sessionId(s), endSec, SECONDS - 1],
        );
      }
      await client.query('ANALYZE podium.samples');
    },
    async dropIndex() { await client.query('DROP INDEX IF EXISTS podium.samples_t'); await client.query('ANALYZE podium.samples'); },
    async createIndex() { await client.query('CREATE INDEX IF NOT EXISTS samples_t ON podium.samples(t)'); await client.query('ANALYZE podium.samples'); },
    async indexBytes() { return Number((await client.query("SELECT pg_relation_size('podium.samples_t') AS b")).rows[0].b); },
    async rows() { return Number((await client.query('SELECT COUNT(*) AS n FROM podium.samples')).rows[0].n); },
    async close() {
      await client.end();
      await dropDatabase(url);
    },
  };
}

async function mariadbDriver(serverUrl: string): Promise<Driver> {
  const mariadb = require('mariadb');
  const url: string = await createDatabase(serverUrl, 'samples');
  const st = await openStorage({ PODIUM_DB: url } as NodeJS.ProcessEnv);
  await st.close();
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const conn = await mariadb.createConnection({ ...mariadbAdminOptions(serverUrl), database });
  return {
    label: 'mariadb',
    target: url,
    async seed(endSec) {
      // The Sequence engine gives 0 .. N-1 without a table of numbers.
      for (let s = 0; s < SESSIONS; s++) {
        await conn.query(
          `INSERT INTO samples (session_id, t, tokens_total, tokens_delta, peak_context, running_agents, cost_usd)
           SELECT ?, ? - seq, seq * 100, 100, 0.4, 2, seq * 0.0001 FROM seq_0_to_${SECONDS - 1}`,
          [sessionId(s), endSec],
        );
      }
      await conn.query('ANALYZE TABLE samples');
    },
    async dropIndex() { await conn.query('DROP INDEX IF EXISTS samples_t ON samples'); await conn.query('ANALYZE TABLE samples'); },
    async createIndex() { await conn.query('CREATE INDEX IF NOT EXISTS samples_t ON samples(t)'); await conn.query('ANALYZE TABLE samples'); },
    async indexBytes() {
      // information_schema reports one number for every secondary index of the table; samples has only this one.
      const r = await conn.query("SELECT index_length AS b FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'samples'");
      return Number(r[0].b);
    },
    async rows() { return Number((await conn.query('SELECT COUNT(*) AS n FROM samples'))[0].n); },
    async close() {
      await conn.end();
      await dropDatabase(url);
    },
  };
}

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

async function measure(d: Driver, nowSec: number, retainHour: number, withIndex: boolean): Promise<State> {
  const st = await openStorage({ PODIUM_DB: d.target } as NodeJS.ProcessEnv);
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

async function run(d: Driver): Promise<Record<string, unknown>> {
  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`\n== ${d.label}: seeding ${SESSIONS} sessions x ${SECONDS} s ...`);
  const s0 = performance.now();
  await d.seed(nowSec);
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
  const out = { kind: d.label, sessions: SESSIONS, hours: HOURS, rows: SESSIONS * SECONDS, before, after, indexBuildMs: buildMs, indexBytes: bytes };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

const results: Record<string, unknown>[] = [];
const drivers: (() => Promise<Driver>)[] = [];
if (args.includes('--sqlite')) drivers.push(sqliteDriver);
if (arg('--pg')) drivers.push(() => pgDriver(arg('--pg')!));
if (arg('--mariadb')) drivers.push(() => mariadbDriver(arg('--mariadb')!));
for (const make of drivers) {
  const d = await make();
  try {
    results.push(await run(d));
  } finally {
    await d.close();
  }
}
if (JSON_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
}
