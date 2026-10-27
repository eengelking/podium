#!/usr/bin/env node
// Load baseline for the Podium server (#682). Starts its own throwaway server (built server/dist, a free port, a temp database it
// deletes), runs the simulator against it at idle, small, medium and large fleet sizes, keeps SSE clients open, and measures what the
// server costs in a fixed window after a warm-up. Run it twice per size to see how far the numbers repeat. Run `--help` for options.
//
// Measured per run: server CPU (user plus system, as a share of one core) and resident memory, event-loop delay (a preload that runs
// `perf_hooks.monitorEventLoopDelay` and writes its histogram on SIGUSR2), the bytes and messages one SSE client receives per second
// and per event type, what the same stream would cost with gzip (one stream, flushed after every chunk the way an SSE response
// would be), and the size of the full snapshot (`/api/fleet/state`) raw and gzipped.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip, gzipSync, constants as zc } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Fleet sizes: orchestrators, and extra agents under each (the simulator caps sessions at 50 and agents at 190). */
const FLEETS = {
  idle: { sessions: 0, agents: 0 },
  small: { sessions: 5, agents: 3 },
  medium: { sessions: 20, agents: 10 },
  large: { sessions: 50, agents: 20 },
};

const HELP = `Usage: node scripts/podium-perf.mjs [options]

Measures the cost of the Podium server at several fleet sizes against a throwaway server that the script starts, and stops, itself.
It never touches a server, port or data folder you use. Build the server first (npm run build -w server).

Options
  --fleet <f>      idle, small, medium, large or all (default all). small is 5 sessions x 3 agents, medium 20 x 10, large 50 x 20
  --duration <s>   seconds measured after the warm-up (default 60)
  --warmup <s>     seconds before measuring (default 10)
  --runs <n>       runs per fleet size, each on a fresh server (default 2), so the repeat margin can be checked
  --clients <n>    SSE clients kept open (default 3)
  --margin <pct>   how far two runs may differ on CPU, RSS and bytes per second before they are called not repeatable (default 15)
  --seed <n>       simulator seed (default 682)
  --json <file>    also write the result as JSON
  --keep-data      keep the temp folder and print its path (default: deleted)
  -h, --help       show this help

CPU and resident memory come from proc_pid_rusage on macOS (python3 ctypes) and from ps elsewhere (CPU then has ps's coarse time).
Everything the script starts is stopped at the end.`;

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
const FLEET = arg('--fleet', 'all');
if (FLEET !== 'all' && !FLEETS[FLEET]) throw new Error(`--fleet must be all, ${Object.keys(FLEETS).join(', ')}`);
const DURATION = num('--duration', 60);
const WARMUP = num('--warmup', 10);
const RUNS = Math.max(1, Math.floor(num('--runs', 2)));
const CLIENTS = Math.max(1, Math.floor(num('--clients', 3)));
const MARGIN = num('--margin', 15);
const SEED = num('--seed', 682);
const KEEP = args.includes('--keep-data');
const JSON_OUT = arg('--json', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.error(`podium-perf: ${m}`);

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const PY = `
import ctypes, ctypes.util, sys
lib = ctypes.CDLL(ctypes.util.find_library('proc'))
sysl = ctypes.CDLL(ctypes.util.find_library('System'))
class TB(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]
tb = TB(); sysl.mach_timebase_info(ctypes.byref(tb))
class RU(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [(n, ctypes.c_uint64) for n in ('user_time', 'system_time', 'pkg_idle_wkups', 'interrupt_wkups', 'pageins', 'wired_size', 'resident_size', 'phys_footprint', 'proc_start_abstime', 'proc_exit_abstime', 'child_user_time', 'child_system_time', 'child_pkg_idle_wkups', 'child_interrupt_wkups', 'child_pageins', 'child_elapsed_abstime', 'diskio_bytesread', 'diskio_byteswritten')]
r = RU()
if lib.proc_pid_rusage(int(sys.argv[1]), 2, ctypes.byref(r)) != 0: raise SystemExit(1)
f = tb.numer / tb.denom
print(int(r.user_time * f), int(r.system_time * f), r.resident_size)
`;

/** CPU time in nanoseconds and resident bytes of one process, or null when this system cannot say. */
function procStats(pid) {
  try {
    if (process.platform === 'darwin') {
      const [user, sys, rss] = execFileSync('/usr/bin/python3', ['-I', '-c', PY, String(pid)], { encoding: 'utf8' }).trim().split(' ').map(Number);
      return { cpuNs: user + sys, rss };
    }
    const [rssKb, cpu] = execFileSync('/bin/ps', ['-o', 'rss=', '-o', 'cputime=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
    const parts = cpu.split(/[:.]/).map(Number);
    const secs = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    return { cpuNs: secs * 1e9, rss: Number(rssKb) * 1024 };
  } catch {
    return null;
  }
}

/** Preload for the server: an event-loop delay histogram that SIGUSR2 writes to a file and resets. */
const PRELOAD = (outFile) => `
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
process.on('SIGUSR2', () => {
  // The histogram records the whole timer interval, so the 10 ms resolution is taken off to leave the delay.
  const ms = (n) => (Number.isFinite(n) ? Math.max(0, Math.round((n / 1e6 - 10) * 100) / 100) : 0);
  writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ meanMs: ms(h.mean), p50Ms: ms(h.percentile(50)), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max), count: h.count }));
  h.reset();
});
`;

class Server {
  constructor() {
    this.dir = mkdtempSync(path.join(tmpdir(), 'podium-perf-'));
    this.token = randomBytes(24).toString('hex');
    this.elFile = path.join(this.dir, 'eventloop.json');
    this.preload = path.join(this.dir, 'preload.mjs');
  }
  async start() {
    if (!existsSync(path.join(ROOT, 'server/dist/index.js'))) throw new Error('server/dist is missing: run npm run build -w server first');
    writeFileSync(this.preload, PRELOAD(this.elFile));
    this.port = await freePort();
    this.url = `http://127.0.0.1:${this.port}`;
    const out = openSync(path.join(this.dir, 'server.log'), 'w');
    this.child = spawn(process.execPath, ['--import', this.preload, path.join(ROOT, 'server/dist/index.js')], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(this.port), HOST: '127.0.0.1', PODIUM_DB: path.join(this.dir, 'podium.sqlite'), PODIUM_TOKEN: this.token, PODIUM_LOG_LEVEL: 'info' },
      stdio: ['ignore', out, out],
    });
    this.exited = new Promise((r) => this.child.once('exit', r));
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${this.url}/api/health`)).ok) return;
      } catch {
        /* not up yet */
      }
      await sleep(100);
    }
    throw new Error(`the server did not start; see ${path.join(this.dir, 'server.log')}`);
  }
  /** Event-loop delay since the last call (the first call only clears what start-up recorded). */
  async eventLoop() {
    try {
      rmSync(this.elFile, { force: true });
    } catch {
      /* none yet */
    }
    this.child.kill('SIGUSR2');
    for (let i = 0; i < 50; i++) {
      if (existsSync(this.elFile)) return JSON.parse(readFileSync(this.elFile, 'utf8'));
      await sleep(50);
    }
    return null;
  }
  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    await this.exited;
    clearTimeout(force);
  }
  cleanup() {
    if (!KEEP) rmSync(this.dir, { recursive: true, force: true });
    else log(`kept: ${this.dir}`);
  }
}

/** One SSE client: counts bytes and messages per event type while `measuring`, and (the first one only) gzips the stream as it goes. */
class SseClient {
  constructor(url, withGzip) {
    this.url = url;
    this.measuring = false;
    this.bytes = 0;
    this.byType = {};
    this.gzBytes = 0;
    this.snapshotBytes = 0;
    this.abort = new AbortController();
    this.gz = withGzip ? createGzip({ flush: zc.Z_SYNC_FLUSH }) : null;
    this.gz?.on('data', (c) => {
      if (this.measuring) this.gzBytes += c.length;
    });
  }
  /** Opens the stream. Not done in the constructor, so building a client never starts work. */
  start() {
    this.done = this.run();
    return this;
  }
  async run() {
    try {
      const res = await fetch(`${this.url}/api/fleet/stream`, { signal: this.abort.signal });
      let buf = '';
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        if (this.gz) {
          this.gz.write(chunk);
          this.gz.flush(zc.Z_SYNC_FLUSH);
        }
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i + 2);
          buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(frame)?.[1] ?? 'message';
          const size = Buffer.byteLength(frame);
          if (type === 'snapshot' && !this.snapshotBytes) this.snapshotBytes = size;
          if (!this.measuring) continue;
          this.bytes += size;
          const t = (this.byType[type] ??= { messages: 0, bytes: 0 });
          t.messages += 1;
          t.bytes += size;
        }
      }
    } catch {
      /* aborted at the end of the run */
    }
  }
  begin() {
    this.measuring = true;
    this.bytes = 0;
    this.gzBytes = 0;
    this.byType = {};
  }
  end() {
    this.measuring = false;
  }
  close() {
    this.abort.abort();
    this.gz?.destroy();
  }
}

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

async function runOnce(name, fleet, run) {
  const server = new Server();
  let sim = null;
  const clients = [];
  try {
    await server.start();
    for (let i = 0; i < CLIENTS; i++) clients.push(new SseClient(server.url, i === 0).start());
    if (fleet.sessions > 0) {
      sim = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'scripts/podium-sim.ts'), '--url', server.url, '--token', server.token, '--sessions', String(fleet.sessions), '--agents', String(fleet.agents), '--seed', String(SEED), '--duration', String(WARMUP + DURATION + 30)], { stdio: 'ignore', detached: true });
    }
    log(`${name} run ${run}: warming up ${WARMUP}s`);
    await sleep(WARMUP * 1000);
    await server.eventLoop();
    const s0 = procStats(server.child.pid);
    const t0 = process.hrtime.bigint();
    clients.forEach((c) => c.begin());
    log(`${name} run ${run}: measuring ${DURATION}s`);
    await sleep(DURATION * 1000);
    const wallNs = Number(process.hrtime.bigint() - t0);
    const s1 = procStats(server.child.pid);
    clients.forEach((c) => c.end());
    const el = await server.eventLoop();
    const state = await (await fetch(`${server.url}/api/fleet/state`)).text();
    const first = clients[0];
    const secs = wallNs / 1e9;
    const sessionCount = JSON.parse(state).sessions?.length ?? 0;
    return {
      fleet: name,
      run,
      sessions: sessionCount,
      cpuPercentOfOneCore: s0 && s1 ? round(((s1.cpuNs - s0.cpuNs) / wallNs) * 100) : null,
      rssMb: s1 ? round(s1.rss / 1048576, 1) : null,
      rssGrowthMb: s0 && s1 ? round((s1.rss - s0.rss) / 1048576, 1) : null,
      eventLoop: el,
      sse: {
        clients: CLIENTS,
        bytesPerSecond: round(first.bytes / secs, 0),
        messagesPerSecond: round(Object.values(first.byType).reduce((n, t) => n + t.messages, 0) / secs),
        gzipBytesPerSecond: round(first.gzBytes / secs, 0),
        gzipRatio: first.bytes ? round(first.gzBytes / first.bytes, 3) : null,
        byType: Object.fromEntries(Object.entries(first.byType).map(([k, v]) => [k, { messagesPerSecond: round(v.messages / secs), bytesPerSecond: round(v.bytes / secs, 0), avgBytes: round(v.bytes / v.messages, 0) }])),
        connectSnapshotBytes: first.snapshotBytes,
      },
      stateBytes: Buffer.byteLength(state),
      stateGzipBytes: gzipSync(state).length,
    };
  } finally {
    clients.forEach((c) => c.close());
    if (sim && sim.exitCode === null) {
      // The simulator runs under the tsx wrapper in its own process group; signal the group so a kill reaches the real process.
      const signal = (s) => {
        try {
          process.kill(-sim.pid, s);
        } catch {
          /* already gone */
        }
      };
      signal('SIGTERM');
      await sleep(500);
      if (sim.exitCode === null) signal('SIGKILL');
    }
    await server.stop();
    server.cleanup();
  }
}

/** Percent difference between two numbers, as a share of the larger; 0 when both are 0. */
const spread = (a, b) => (Math.max(Math.abs(a), Math.abs(b)) === 0 ? 0 : (Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b))) * 100);

function repeatability(runs) {
  if (runs.length < 2) return null;
  const metrics = { cpuPercentOfOneCore: (r) => r.cpuPercentOfOneCore, rssMb: (r) => r.rssMb, bytesPerSecond: (r) => r.sse.bytesPerSecond };
  const out = {};
  for (const [k, get] of Object.entries(metrics)) {
    const v = runs.map(get);
    if (v.some((x) => x === null)) continue;
    out[k] = round(spread(Math.min(...v), Math.max(...v)), 1);
  }
  // A small CPU figure moves by a few tenths of a point from run to run, which is a large share of it, so a gap of half a point
  // passes whatever the percentage says.
  const cpu = runs.map((r) => r.cpuPercentOfOneCore).filter((x) => x !== null);
  const cpuOk = cpu.length < 2 || Math.max(...cpu) - Math.min(...cpu) <= 0.5 || (out.cpuPercentOfOneCore ?? 0) <= MARGIN;
  const ok = cpuOk && (out.rssMb ?? 0) <= MARGIN && (out.bytesPerSecond ?? 0) <= MARGIN;
  return { marginPercent: MARGIN, spreadPercent: out, repeatable: ok };
}

const names = FLEET === 'all' ? Object.keys(FLEETS) : [FLEET];
const results = [];
try {
  for (const name of names) {
    const runs = [];
    for (let r = 1; r <= RUNS; r++) runs.push(await runOnce(name, FLEETS[name], r));
    results.push({ fleet: name, ...FLEETS[name], runs, repeat: repeatability(runs) });
  }
} catch (e) {
  console.error(`podium-perf: ${e.message}`);
  process.exitCode = 1;
}

const out = { tool: 'podium-perf', node: process.version, platform: `${process.platform} ${process.arch}`, warmupSeconds: WARMUP, durationSeconds: DURATION, results };
if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(out, null, 2)}\n`);
const row = (c) => c.map((x, i) => String(x ?? 'n/a').padEnd([8, 4, 9, 8, 7, 9, 7, 8][i])).join(' ');
console.log(row(['fleet', 'run', 'sessions', 'cpu %', 'rss MB', 'B/s', 'msg/s', 'gzip B/s']) + '  loop p99 ms  repeat');
for (const f of results) {
  for (const r of f.runs) {
    console.log(row([r.fleet, r.run, r.sessions, r.cpuPercentOfOneCore, r.rssMb, r.sse.bytesPerSecond, r.sse.messagesPerSecond, r.sse.gzipBytesPerSecond]) + `  ${String(r.eventLoop?.p99Ms ?? 'n/a').padEnd(11)}  ${r.run === 1 ? (f.repeat ? (f.repeat.repeatable ? 'ok' : 'NOT repeatable') : '-') : ''}`);
  }
}
