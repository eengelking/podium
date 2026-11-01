#!/usr/bin/env node
// Storage latency for the Podium server (#822): the same report load and snapshot load against SQLite and against PostgreSQL, on the
// same machine or over a network hop with a stated round-trip time. Starts its own throwaway server (built server/dist, a free port, a
// throwaway database it drops) and stops everything it started. Run `--help` for options.
//
// Per run: a pool of simulator reports is posted to /api/fleet/report, first one at a time (latency: p50/p95/p99), then several at a
// time, one session to one worker so each session stays in order (throughput). Then /api/fleet/state is fetched one at a time
// (snapshot build time). With PostgreSQL it also counts the queries the server sent for each phase.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, dropDatabase, isPostgresUrl, labelOf } from './throwaway-db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `Usage: node scripts/podium-perf-storage.mjs [options]

Posts a pool of simulator reports to a throwaway Podium server and times the report and snapshot paths on one database. Build the server
first (npm run build -w server). It never touches a server, port or database you use.

Options
  --db <v>         sqlite (default), or a postgres:// URL of a PostgreSQL server (a database of its own is made on it and dropped)
  --rtt <ms>       with a postgres:// URL: put a TCP delay proxy in front of the server so each query pays this round-trip time in
                   addition to the real one (the delay is rtt/2 on each direction of every chunk). Default 0: no proxy
  --sessions <n>   simulated sessions (default 20), each with --agents extra agents (default 10)
  --reports <n>    reports in the pool (default 1200); the first --serial of them are posted one at a time, the rest --concurrency at a time
  --serial <n>     reports posted one at a time (default 400)
  --concurrency <n> workers for the rest (default 8)
  --states <n>     GET /api/fleet/state this many times, one at a time (default 30)
  --runs <n>       runs, each on a fresh server and database (default 3), so the spread can be seen
  --seed <n>       simulator seed (default 822)
  --json <file>    also write the result as JSON
  -h, --help       show this help

Query counts need PostgreSQL: a preload counts the pg driver's calls (BEGIN and COMMIT included) and the idle rate is taken off.
Environment
  PODIUM_DB        used for --db when --db is not given and it is a postgres:// URL.`;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const num = (n, d) => {
  const v = Number(arg(n, d));
  if (!Number.isFinite(v) || v < 0) throw new Error(`${n} must be a number of at least 0`);
  return v;
};
const DB = arg('--db', isPostgresUrl(process.env.PODIUM_DB) ? process.env.PODIUM_DB : 'sqlite');
const PG = isPostgresUrl(DB);
const RTT = num('--rtt', 0);
const SESSIONS = Math.min(50, Math.max(1, Math.floor(num('--sessions', 20))));
const AGENTS = num('--agents', 10);
const REPORTS = Math.floor(num('--reports', 1200));
const SERIAL = Math.min(REPORTS, Math.floor(num('--serial', 400)));
const CONC = Math.max(1, Math.floor(num('--concurrency', 8)));
const STATES = Math.floor(num('--states', 30));
const RUNS = Math.max(1, Math.floor(num('--runs', 3)));
const SEED = num('--seed', 822);
const JSON_OUT = arg('--json', '');
if (RTT > 0 && !PG) throw new Error('--rtt needs a postgres:// --db');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.error(`podium-perf-storage: ${m}`);

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** A TCP proxy that holds every chunk back by `oneWayMs` in each direction, in order. Returns { port, close }. */
async function delayProxy(targetHost, targetPort, oneWayMs) {
  const sockets = new Set();
  const server = createServer((client) => {
    const upstream = connect(targetPort, targetHost);
    sockets.add(client).add(upstream);
    const pipe = (from, to) => {
      from.on('data', (chunk) => setTimeout(() => to.writable && to.write(chunk), oneWayMs));
      from.on('end', () => setTimeout(() => to.end(), oneWayMs));
      from.on('error', () => to.destroy());
    };
    pipe(client, upstream);
    pipe(upstream, client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Preload: counts calls of the pg driver's Client.query; SIGUSR2 writes the total to a file. */
const PRELOAD = (outFile, pgPath) => `
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const pg = createRequire(${JSON.stringify(pgPath)})('pg');
let n = 0;
const shapes = {};
const q = pg.Client.prototype.query;
pg.Client.prototype.query = function (...a) {
  n++;
  const t = typeof a[0] === 'string' ? a[0] : a[0] && a[0].text;
  const k = String(t ?? '?').replace(/\\s+/g, ' ').trim().slice(0, 110);
  shapes[k] = (shapes[k] ?? 0) + 1;
  return q.apply(this, a);
};
process.on('SIGUSR2', () => writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ n, shapes })));
`;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
const r2 = (n) => Math.round(n * 100) / 100;

/** The simulator's reports as parsed objects, in the order the simulator would send them. */
function makePool() {
  const out = execFileSync(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'scripts/podium-sim.ts'), '--print', '--sessions', String(SESSIONS), '--agents', String(AGENTS), '--seed', String(SEED), '--ticks', String(Math.ceil(REPORTS / SESSIONS) + 2)], { encoding: 'utf8', maxBuffer: 1 << 29 });
  const pool = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (pool.length < REPORTS) throw new Error(`the simulator gave ${pool.length} reports, wanted ${REPORTS}`);
  return pool.slice(0, REPORTS);
}

async function oneRun(pool, n) {
  const dir = mkdtempSync(path.join(tmpdir(), 'podium-perf-storage-'));
  const token = randomBytes(24).toString('hex');
  const countFile = path.join(dir, 'count');
  let dbUrl = path.join(dir, 'podium.sqlite');
  let throwaway = null;
  let proxy = null;
  let child = null;
  let sse = null;
  try {
    if (PG) {
      throwaway = await createDatabase(DB, 'perfstorage');
      dbUrl = throwaway;
      if (RTT > 0) {
        const u = new URL(throwaway);
        proxy = await delayProxy(u.hostname, Number(u.port || 5432), RTT / 2);
        u.hostname = '127.0.0.1';
        u.port = String(proxy.port);
        dbUrl = u.toString();
      }
      log(`run ${n}: database ${labelOf(throwaway)}${proxy ? ` through a ${RTT} ms round-trip proxy` : ''}`);
    }
    const preload = path.join(dir, 'preload.mjs');
    writeFileSync(preload, PRELOAD(countFile, path.join(ROOT, 'package.json')));
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const out = openSync(path.join(dir, 'server.log'), 'w');
    child = spawn(process.execPath, [...(PG ? ['--import', preload] : []), path.join(ROOT, 'server/dist/index.js')], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), HOST: '127.0.0.1', PODIUM_DB: dbUrl, PODIUM_DATA_DIR: dir, PODIUM_TOKEN: token, PODIUM_LOG_LEVEL: 'warn' },
      stdio: ['ignore', out, out],
    });
    let up = false;
    for (let i = 0; i < 300 && !up; i++) {
      try {
        up = (await fetch(`${url}/api/health`)).ok;
      } catch {
        await sleep(100);
      }
    }
    if (!up) throw new Error(`the server did not start; see ${path.join(dir, 'server.log')}`);

    // One stream client, as a console would be, so a report also pays for the broadcast.
    const abort = new AbortController();
    sse = abort;
    fetch(`${url}/api/fleet/stream`, { signal: abort.signal }).then(async (res) => { for await (const _ of res.body); }).catch(() => {});

    const queries = async () => {
      if (!PG) return null;
      rmSync(countFile, { force: true });
      child.kill('SIGUSR2');
      for (let i = 0; i < 50; i++) {
        if (existsSync(countFile)) {
          const text = readFileSync(countFile, 'utf8');
          if (text.endsWith('}')) return JSON.parse(text);
        }
        await sleep(20);
      }
      return null;
    };
    const post = async (rep) => {
      const body = JSON.stringify({ ...rep, sentAt: Date.now() });
      const t0 = performance.now();
      const res = await fetch(`${url}/api/fleet/report`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-podium-token': token }, body });
      await res.arrayBuffer();
      if (!res.ok) throw new Error(`report refused: ${res.status}`);
      return performance.now() - t0;
    };

    await sleep(1500);
    const i0 = await queries();
    await sleep(5000);
    const i1 = await queries();
    const idlePerSec = i0 === null ? 0 : (i1.n - i0.n) / 5;
    const idleShapes = (k) => (i0 === null ? 0 : ((i1.shapes[k] ?? 0) - (i0.shapes[k] ?? 0)) / 5);
    const topShapes = (a, b, per, sec) => Object.keys(b.shapes).map((k) => [k, ((b.shapes[k] ?? 0) - (a.shapes[k] ?? 0) - idleShapes(k) * sec) / per]).filter(([, v]) => v >= 0.05).sort((x, y) => y[1] - x[1]).slice(0, 14).map(([k, v]) => ({ perCall: r2(v), sql: k }));

    // Latency: one at a time.
    const lat = [];
    const q0 = await queries();
    const s0 = performance.now();
    for (const rep of pool.slice(0, SERIAL)) lat.push(await post(rep));
    const serialSec = (performance.now() - s0) / 1000;
    const q1 = await queries();
    lat.sort((a, b) => a - b);

    // Throughput: the rest, one session to one worker.
    const rest = pool.slice(SERIAL);
    const lanes = Array.from({ length: CONC }, () => []);
    const laneOf = new Map();
    for (const rep of rest) {
      if (!laneOf.has(rep.session.id)) laneOf.set(rep.session.id, laneOf.size % CONC);
      lanes[laneOf.get(rep.session.id)].push(rep);
    }
    const lat2 = [];
    const c0 = performance.now();
    await Promise.all(lanes.map(async (lane) => { for (const rep of lane) lat2.push(await post(rep)); }));
    const concSec = (performance.now() - c0) / 1000;
    lat2.sort((a, b) => a - b);

    // Snapshot: one at a time.
    const st = [];
    let bytes = 0;
    let sessions = 0;
    const sq0 = await queries();
    for (let i = 0; i < STATES; i++) {
      const t0 = performance.now();
      const res = await fetch(`${url}/api/fleet/state`, { headers: { 'x-podium-token': token } });
      const text = await res.text();
      st.push(performance.now() - t0);
      if (i === 0) {
        bytes = Buffer.byteLength(text);
        sessions = JSON.parse(text).sessions?.length ?? 0;
      }
    }
    const sq1 = await queries();
    st.sort((a, b) => a - b);

    const perReport = q1 === null || SERIAL === 0 ? null : (q1.n - q0.n - idlePerSec * serialSec) / SERIAL;
    const perState = sq1 === null || STATES === 0 ? null : (sq1.n - sq0.n) / STATES;
    return {
      report: { n: lat.length, p50: r2(pct(lat, 50)), p95: r2(pct(lat, 95)), p99: r2(pct(lat, 99)), mean: r2(lat.reduce((a, b) => a + b, 0) / lat.length), perSec: r2(lat.length / serialSec), queries: perReport === null ? null : r2(perReport) },
      concurrent: { n: lat2.length, workers: CONC, p50: r2(pct(lat2, 50)), p95: r2(pct(lat2, 95)), p99: r2(pct(lat2, 99)), perSec: r2(lat2.length / concSec) },
      state: { n: st.length, p50: r2(pct(st, 50)), p95: r2(pct(st, 95)), p99: r2(pct(st, 99)), first: r2(st[0]), bytes, sessions, queries: perState === null ? null : r2(perState) },
      idleQueriesPerSec: r2(idlePerSec),
      shapes: q1 === null ? null : { report: topShapes(q0, q1, SERIAL, serialSec), state: topShapes(sq0, sq1, STATES, 0) },
    };
  } finally {
    sse?.abort();
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(force);
    }
    await proxy?.close();
    if (throwaway) await dropDatabase(throwaway).catch((e) => log(`could not drop the database: ${e.message}`));
    rmSync(dir, { recursive: true, force: true });
  }
}

if (!existsSync(path.join(ROOT, 'server/dist/index.js'))) throw new Error('server/dist is missing: run npm run build -w server first');
const pool = makePool();
log(`${pool.length} reports, ${SESSIONS} sessions x ${AGENTS} agents, db ${PG ? labelOf(DB) : 'sqlite'}${RTT ? `, +${RTT} ms round trip` : ''}`);
const runs = [];
for (let i = 1; i <= RUNS; i++) {
  runs.push(await oneRun(pool, i));
  log(`run ${i}: ${JSON.stringify(runs[i - 1].report)} state p50 ${runs[i - 1].state.p50}`);
}
const result = { db: PG ? 'postgres' : 'sqlite', rttMs: RTT, sessions: SESSIONS, agents: AGENTS, reports: REPORTS, serial: SERIAL, runs };
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
