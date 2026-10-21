#!/usr/bin/env node
// Write-load measurement for session recording (#353, SPEC 6.4 "Measured write load"). Starts its own throwaway Podium server (built
// server/dist, a free port, PODIUM_TOKEN set, a temp data folder it deletes), drives a fleet of recorded sessions the way the reporter
// mod would (it uses the mod's own `Recorder` for redaction, cutting and batching), and measures what the server costs.
//
// Phases:
//   load    N sessions, each an orchestrator with K agents, for a fixed time, with recording on or off (the baseline).
//   caps    fills one recording to the per-session limit and the total to the disk budget, and checks the `limit` mark and the stop.
//   purge   the purge against a fleet that keeps writing (aged rows), and against a full 2 GB budget.
//
// Measurement (macOS): bytes written by the server process come from proc_pid_rusage (ri_diskio_byteswritten, through python3 ctypes);
// `time -l` reports 0 block operations on macOS and is useless here. Write operations per second come from ioreg's block storage
// driver counters, which are system-wide. CPU is the server's user plus system time from the same call. Run `--help` for the options.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAG = '--experimental-transform-types';

const HELP = `Usage: node scripts/podium-recording-load.mjs [--phase load|caps|purge] [options]

Measures the write load of session recording against a throwaway Podium server that the script starts, and stops, itself. It never
touches a server, port or data folder you use. Build the server first (npm run build -w server). Needs macOS for the disk numbers
(python3 and ioreg); on another system the disk columns read n/a.

Common options
  --phase <p>        load (default), caps or purge
  --keep-data        keep the temp data folder and print its path (default: deleted)
  --json <file>      also write the result as JSON
  --seed <n>         seed of the pseudo-random generator (default 353)
  -h, --help         show this help

load
  --sessions <n>     orchestrators (default 5)
  --agents <k>       agents under each orchestrator (default 3), so n*(k+1) loops
  --duration <s>     seconds measured after the warm-up (default 120)
  --warmup <s>       seconds before measuring (default 10)
  --mode <m>         on (default) or off (baseline: same reports, nothing recorded)
  --interval <ms>    time between batches of one session (default 1000, the mod's RECORDING_BATCH_INTERVAL_MS)
  --call-every <s>   mean seconds between tool calls of one loop (default 8)
  --profile <p>      busy (default: results 1 KB to 200 KB, median about 6 KB, mean about 22 KB) or typical (mean about 4.6 KB)
  --report-every <s> seconds between a session's reports (default 5)

caps
  --full             use the real defaults (256 MB per session, 2 GB budget) instead of the lowest settings (8 MB and 64 MB)

purge
  --minutes <m>      minutes of steady load with aged rows (default 11, so two of the server's 5-minute purge runs happen)
  --sessions <n>     orchestrators during the purge run (default 20)
  --full-budget      instead: fill the 2 GB budget, age it all, and time the purge of the lot`;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}
// The mod's Recorder is TypeScript with parameter properties, which plain Node cannot strip; run again with the transform flag on.
if (!process.execArgv.includes(FLAG)) {
  const r = spawnSync(process.execPath, [FLAG, '--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const num = (n, d) => {
  const v = Number(arg(n, d));
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${n} must be a positive number`);
  return v;
};
const PHASE = arg('--phase', 'load');
const SEED = num('--seed', 353);
const KEEP = args.includes('--keep-data');
const MAIN = '@orchestrator';
const MB = 1024 * 1024;

const { Recorder } = await import(pathToFileURL(path.join(ROOT, 'mod/podium-reporter/hooks/recording.ts')).href);
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const sqlite = process.getBuiltinModule('node:sqlite');

// ---- small helpers ---------------------------------------------------------------------------
let rngState = SEED >>> 0;
const rnd = () => {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a, b) => a + rnd() * (b - a);
const logU = (a, b) => Math.exp(between(Math.log(a), Math.log(b)));
const pick = (list) => list[Math.floor(rnd() * list.length)];
const exp = (mean) => -Math.log(1 - rnd()) * mean;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => randomBytes(6).toString('hex');
const pct = (list, p) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
const fmtMB = (b) => (b / MB).toFixed(2);
const log = (...a) => console.error(...a);

// Pseudo source code: realistic enough in length and line structure; no word in it looks like a secret to the redactor.
const WORDS = ['invoice', 'schema', 'handler', 'router', 'column', 'value', 'config', 'parse', 'build', 'render', 'widget', 'state', 'model', 'fleet', 'agent', 'order', 'price', 'total', 'count', 'index', 'query', 'result', 'client', 'server', 'cache', 'queue', 'batch', 'entry', 'format', 'filter', 'select', 'update', 'delete', 'insert', 'merge', 'split'];
const CORPUS = (() => {
  const out = [];
  let n = 0;
  while (n < 2_000_000) {
    const a = pick(WORDS);
    const b = pick(WORDS);
    const c = pick(WORDS);
    const i = Math.floor(rnd() * 900);
    const line = pick([
      `export function ${a}${i}(${b}: ${c}Row, opts: ${a}Options = {}): ${c}Result {`,
      `  const ${b}${i} = await ${a}.${c}(${b}, { limit: ${i}, offset: ${i * 2} });`,
      `  if (!${b}${i} || ${b}${i}.${c} < ${i}) throw new Error('${a} ${b} ${c} is out of range at ${i}');`,
      `  // ${a} the ${b} before the ${c} runs, then write the ${a} back (case ${i})`,
      `server/src/${a}/${b}${i}.ts:${i}:${i % 80}  ${c}: Expected ${a} but received ${b}`,
      `  return rows.map((r) => ({ ...r, ${a}: r.${b} ?? ${i}, ${c}: String(r.${c}) }));`,
      `}`,
    ]);
    out.push(line);
    n += line.length + 1;
  }
  return out.join('\n');
})();
const slice = (chars) => {
  const at = Math.floor(rnd() * (CORPUS.length - chars - 1));
  return CORPUS.slice(at, at + chars);
};

// ---- the throwaway server ----------------------------------------------------------------------
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
print(r.diskio_bytesread, r.diskio_byteswritten, int(r.user_time * f), int(r.system_time * f), r.resident_size)
`;

const DARWIN = process.platform === 'darwin';
function procStats(pid) {
  if (!DARWIN) return null;
  try {
    const [read, written, userNs, sysNs, rss] = execFileSync('python3', ['-I', '-c', PY, String(pid)], { encoding: 'utf8' }).trim().split(' ').map(Number);
    return { read, written, cpuNs: userNs + sysNs, rss };
  } catch {
    return null;
  }
}
function ioregStats() {
  if (!DARWIN) return null;
  try {
    const text = execFileSync('ioreg', ['-c', 'IOBlockStorageDriver', '-r', '-w0', '-d1'], { encoding: 'utf8' });
    let ops = 0;
    let bytes = 0;
    for (const m of text.matchAll(/"Operations \(Write\)"=(\d+)/g)) ops += Number(m[1]);
    for (const m of text.matchAll(/"Bytes \(Write\)"=(\d+)/g)) bytes += Number(m[1]);
    return { ops, bytes };
  } catch {
    return null;
  }
}
const sizeOf = (f) => {
  try {
    return statSync(f).size;
  } catch {
    return 0;
  }
};

class Server {
  constructor() {
    this.dir = mkdtempSync(path.join(tmpdir(), 'podium-rec-load-'));
    this.token = randomBytes(24).toString('hex');
    this.logFile = path.join(this.dir, 'server.log');
    this.activity = path.join(this.dir, 'activity.sqlite');
    this.main = path.join(this.dir, 'podium.sqlite');
    this.adminCookie = '';
    this.jar = '';
  }
  async start() {
    if (!existsSync(path.join(ROOT, 'server/dist/index.js'))) throw new Error('server/dist is missing: run npm run build -w server first');
    this.port = await freePort();
    this.url = `http://127.0.0.1:${this.port}`;
    const out = openSync(this.logFile, 'w');
    this.child = spawn(process.execPath, [path.join(ROOT, 'server/dist/index.js')], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(this.port), HOST: '127.0.0.1', PODIUM_DB: this.main, PODIUM_TOKEN: this.token, PODIUM_LOG_LEVEL: 'info' },
      stdio: ['ignore', out, out],
    });
    this.exited = new Promise((r) => this.child.once('exit', r));
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${this.url}/api/health`)).ok) return;
      } catch {
        await sleep(100);
      }
    }
    throw new Error(`the server did not start; see ${this.logFile}`);
  }
  async stop() {
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      await Promise.race([this.exited, sleep(5000)]);
      if (this.child.exitCode === null) this.child.kill('SIGKILL');
    }
  }
  cleanup() {
    if (KEEP) log(`kept: ${this.dir}`);
    else rmSync(this.dir, { recursive: true, force: true });
  }
  async call(method, p, headers, body) {
    const res = await fetch(new URL(p, this.url), { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie?.() ?? [];
    const text = await res.text();
    return { status: res.status, set, body: text ? JSON.parse(text) : null };
  }
  async admin(method, p, body, retried = false) {
    const r = await this.call(method, `/api/admin${p}`, { 'X-Podium-Admin': '1', cookie: this.adminCookie }, body);
    if (r.set.length) this.adminCookie = r.set.map((c) => c.split(';')[0]).join('; ');
    if (r.status === 401 && p !== "/unlock" && !retried) {
      // The Admin sign-in lapses after a while; a long run signs in again.
      await this.admin("POST", "/unlock", { name: "Admin", token: this.token });
      return this.admin(method, p, body, true);
    }
    return r;
  }
  async browser(method, p, body) {
    const r = await this.call(method, `/api/fleet/respond${p}`, { 'X-Podium-Respond': '1', cookie: this.jar }, body);
    if (r.set.length) {
      const pairs = r.set.map((c) => c.split(';')[0]).map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]);
      this.jar = [...new Map(pairs.filter(([, v]) => v)).entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    return r;
  }
  /** Unlocks the Admin, turns the flags on or off, makes a person and signs them in. */
  async setup(recordingOn) {
    const must = (r, what) => {
      if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
      return r;
    };
    must(await this.admin('POST', '/unlock', { name: 'Admin', token: this.token }), 'unlock');
    if (recordingOn) must(await this.admin('PUT', '/settings', { features: { 'session-recording': true, respond: true } }), 'flags');
    const made = must(await this.admin('POST', '/people', { name: 'Loadtest' }), 'person');
    this.person = made.body.person.name;
    this.personToken = made.body.token;
    if (recordingOn) must(await this.browser('POST', '/sign-in', { name: this.person, token: this.personToken }), 'sign in');
  }
  setLimits(p) {
    return this.admin('PUT', '/settings', { recording: p });
  }
  async totals() {
    const r = await this.admin('GET', '/settings');
    return r.body?.recording ?? null;
  }
  /** The recordings' files: the activity database and its WAL. */
  dbBytes() {
    return sizeOf(this.activity) + sizeOf(`${this.activity}-wal`);
  }
  checkpoint() {
    const db = new sqlite.DatabaseSync(this.activity);
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }
}

// ---- sessions (what the reporter mod would send) -----------------------------------------------
const machine = { name: 'loadgen', id: `mac${rid()}`, os: 'macOS 26.0' };
function agentReport(a) {
  const now = Date.now();
  return {
    id: a.id, parentId: null, kind: 'subagent', type: 'general-purpose', name: a.name, description: a.name, model: 'claude-sonnet-5-5', effort: 'medium', effortSource: 'requested',
    status: 'running', startedAt: now - 300_000, endedAt: null, context: { tokens: 100_000, window: 1_000_000, percent: 10 }, tokens: { input: 1000, output: 500, cacheRead: 8000, cacheWrite: 500 },
    costUsdEst: 0.12, skills: [], lastTool: 'Read', toolCalls: 3, toolCounts: null, blowouts: 0, steps: { done: 2, total: null }, promptExcerpt: 'Find every call site.', answerExcerpt: null, failure: null,
  };
}
function reportOf(s, userName, recordingOn) {
  const now = Date.now();
  return {
    v: 1, sentAt: now, reporter: { name: 'podium-reporter', version: VERSION, engineVersion: '2.1.301', hostSurface: 'terminal' }, userName, machine,
    session: {
      id: s.id, name: s.name, status: 'running', waitReason: null, waitNote: null, endReason: null, resumeId: null, startedAt: now - 3_000_000, cwd: `/Users/dev/${s.name}`, projectRoot: `/Users/dev/${s.name}`,
      repoName: `eengelking/${s.name}`, git: { branch: 'main', detached: false, isWorktree: false, worktreePath: null, ahead: 0, behind: 0, dirty: 3 }, model: 'claude-opus-5-5', effort: 'xhigh',
      context: { tokens: 410_000, window: 1_000_000, percent: 41 }, costUsd: 12.84, tokens: { input: 300_000, output: 30_000, cacheRead: 0, cacheWrite: 0 }, rateLimits: [], blowouts: 0, plan: null,
      loop: { skills: [], lastTool: 'Read', toolCalls: 4, toolCounts: { Read: 4 }, steps: { done: 6, total: null }, }, files: null, attached: true, activityFeed: false, sessionRecording: recordingOn,
    },
    agents: s.agents.map(agentReport), events: [],
  };
}

const PROFILES = {
  busy: () => {
    const x = rnd();
    if (x < 0.005) return 150_000;
    if (x < 0.555) return logU(1000, 8000);
    if (x < 0.855) return logU(8000, 50_000);
    return logU(50_000, 200_000);
  },
  typical: () => {
    const x = rnd();
    if (x < 0.8) return logU(300, 4000);
    if (x < 0.98) return logU(4000, 30_000);
    return logU(30_000, 100_000);
  },
};
const TOOLS = [
  ['Read', 0.35], ['Bash', 0.25], ['Grep', 0.15], ['Edit', 0.12], ['Write', 0.03], ['Glob', 0.1],
];
const pickTool = () => {
  let x = rnd();
  for (const [name, p] of TOOLS) if ((x -= p) < 0) return name;
  return 'Read';
};
function inputFor(tool) {
  const file = `/Users/dev/proj/src/${pick(WORDS)}/${pick(WORDS)}${Math.floor(rnd() * 90)}.ts`;
  const big = Math.floor(logU(500, 5000));
  switch (tool) {
    case 'Read': return { file_path: file, offset: 0, limit: 2000 };
    case 'Glob': return { pattern: `src/**/${pick(WORDS)}*.ts` };
    case 'Grep': return { pattern: `${pick(WORDS)}\\w+\\(`, path: 'src', output_mode: 'content', '-n': true };
    case 'Bash': return { command: slice(Math.min(big, 800)).replaceAll('\n', ' && '), description: `Run ${pick(WORDS)} step` };
    case 'Edit': return { file_path: file, old_string: slice(Math.floor(big / 2)), new_string: slice(Math.floor(big / 2)) };
    default: return { file_path: file, content: slice(big) };
  }
}

class LoadSession {
  constructor(i, nAgents, recordingOn, userName, srv, opts) {
    this.srv = srv;
    this.opts = opts;
    this.recordingOn = recordingOn;
    this.userName = userName;
    this.id = `load-${String(i).padStart(3, '0')}-${rid()}`;
    this.name = `load-${String(i).padStart(3, '0')}`;
    this.agents = Array.from({ length: nAgents }, (_, k) => ({ id: `ag${k}-${rid()}`, name: `agent-${k}` }));
    this.loops = [MAIN, ...this.agents.map((a) => a.id)].map((loop) => ({ loop, nextCallAt: Infinity, results: [] }));
    this.rec = new Recorder();
    this.stats = { requests: 0, entries: 0, bytes: 0, latencies: [], statuses: {}, errors: 0, ended: null, queueMax: 0, batchMax: 0 };
    this.nextReportAt = Date.now() + rnd() * opts.reportEveryMs;
  }
  report() {
    return this.srv.call('POST', '/api/fleet/report', { 'X-Podium-Token': this.srv.personToken }, reportOf(this, this.userName, this.recordingOn)).then(
      (r) => {
        if (r.status >= 300) this.stats.errors++;
        return r;
      },
      () => void this.stats.errors++,
    );
  }
  async start() {
    const first = await this.report();
    if (!first || first.status >= 300) throw new Error(`report failed: ${first?.status} ${JSON.stringify(first?.body)}`);
    if (this.recordingOn) {
      const r = await this.srv.browser('PUT', `/sessions/${this.id}/recording`, { loops: this.loops.map((l) => l.loop) });
      if (r.status >= 300) throw new Error(`start recording: ${r.status} ${JSON.stringify(r.body)}`);
      this.rec.begin(this.id);
      this.rec.apply(r.body.grant, true);
      if (!this.rec.capturing) throw new Error(`the grant does not allow capture: ${JSON.stringify(r.body.grant)}`);
      const now = Date.now();
      for (const l of this.loops) this.rec.prompt(l.loop, slice(Math.floor(logU(500, 4000))), now);
    }
    const now = Date.now();
    for (const l of this.loops) l.nextCallAt = now + exp(this.opts.callEveryMs);
  }
  /** Events that are due, then the report and the batch when due. */
  step(now) {
    if (now >= this.nextReportAt) {
      this.nextReportAt = now + this.opts.reportEveryMs;
      void this.report();
    }
    if (!this.recordingOn || this.stats.ended) return;
    const rec = this.rec;
    for (const l of this.loops) {
      while (l.results.length && l.results[0].at <= now) {
        const r = l.results.shift();
        rec.outcome(l.loop, r.tool, r.input, r.callSeq, { text: r.text, isError: r.failed }, now);
      }
      if (now >= l.nextCallAt) {
        l.nextCallAt = now + exp(this.opts.callEveryMs);
        if (rnd() < 0.4) rec.thinking(l.loop, now);
        if (rnd() < 0.5) rec.said(l.loop, slice(Math.floor(logU(150, 2000))), now);
        const tool = pickTool();
        const input = inputFor(tool);
        const callSeq = rec.call(l.loop, tool, input, now);
        const chars = Math.floor(this.opts.resultSize());
        l.results.push({ at: now + between(200, 3000), tool, input, callSeq, text: slice(chars), failed: rnd() < 0.05 });
      }
    }
    this.stats.queueMax = Math.max(this.stats.queueMax, rec.queuedBytes);
    if (rec.queued > 0 && !rec.inFlight && now - rec.lastSentAt >= this.opts.intervalMs) this.send(now);
  }
  send(now) {
    const next = this.rec.nextBatch(now);
    if (!next) return;
    const body = JSON.stringify(next.batch);
    const t0 = performance.now();
    this.stats.requests++;
    this.stats.bytes += body.length;
    this.stats.batchMax = Math.max(this.stats.batchMax, body.length);
    fetch(`${this.srv.url}/api/fleet/sessions/${this.id}/recording`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Podium-Token': this.srv.personToken }, body }).then(
      async (res) => {
        this.stats.latencies.push(performance.now() - t0);
        this.stats.statuses[res.status] = (this.stats.statuses[res.status] ?? 0) + 1;
        const j = await res.json().catch(() => null);
        if (res.status === 200) {
          this.stats.entries += next.count;
          this.rec.done(next.count, Date.now());
          const ap = this.rec.apply(j.recording, true);
          if (ap.ended) this.stats.ended = ap.ended;
        } else {
          this.rec.drop(next.count, Date.now());
          this.stats.ended = `http ${res.status}`;
        }
      },
      () => {
        this.stats.errors++;
        this.rec.failed(Date.now());
      },
    );
  }
}

// ---- the meter ------------------------------------------------------------------------------------
class Meter {
  constructor(srv) {
    this.srv = srv;
    this.rows = [];
  }
  sample() {
    return { t: performance.now(), proc: procStats(this.srv.child.pid), io: ioregStats(), dbBytes: this.srv.dbBytes() };
  }
  start() {
    this.first = this.sample();
    this.timer = setInterval(() => this.rows.push(this.sample()), 1000);
    this.probes = [];
    this.probeTimer = setInterval(async () => {
      const t0 = performance.now();
      try {
        await fetch(`${this.srv.url}/api/health`);
        this.probes.push(performance.now() - t0);
      } catch {
        // a probe that fails is left out
      }
    }, 250);
  }
  stop() {
    clearInterval(this.timer);
    clearInterval(this.probeTimer);
    this.last = this.sample();
    const all = [this.first, ...this.rows, this.last];
    const secs = (this.last.t - this.first.t) / 1000;
    const per = [];
    for (let i = 1; i < all.length; i++) {
      const dt = (all[i].t - all[i - 1].t) / 1000;
      if (all[i].proc && all[i - 1].proc) {
        per.push({
          wBytes: (all[i].proc.written - all[i - 1].proc.written) / dt,
          cpu: ((all[i].proc.cpuNs - all[i - 1].proc.cpuNs) / 1e9 / dt) * 100,
          ops: all[i].io && all[i - 1].io ? (all[i].io.ops - all[i - 1].io.ops) / dt : null,
        });
      }
    }
    const f = this.first;
    const l = this.last;
    const has = f.proc && l.proc;
    return {
      seconds: secs,
      procWriteBytesPerSec: has ? (l.proc.written - f.proc.written) / secs : null,
      procWriteBytesPerSecMax1s: per.length ? Math.max(...per.map((x) => x.wBytes)) : null,
      sysWriteOpsPerSec: f.io && l.io ? (l.io.ops - f.io.ops) / secs : null,
      sysWriteOpsPerSecMax1s: per.some((x) => x.ops !== null) ? Math.max(...per.map((x) => x.ops ?? 0)) : null,
      sysWriteBytesPerSec: f.io && l.io ? (l.io.bytes - f.io.bytes) / secs : null,
      cpuPercentMean: has ? ((l.proc.cpuNs - f.proc.cpuNs) / 1e9 / secs) * 100 : null,
      cpuPercentMax1s: per.length ? Math.max(...per.map((x) => x.cpu)) : null,
      rssMaxMB: all.some((x) => x.proc) ? Math.max(...all.filter((x) => x.proc).map((x) => x.proc.rss)) / MB : null,
      dbGrowthBytesPerSec: (l.dbBytes - f.dbBytes) / secs,
      healthMsP50: pct(this.probes, 50),
      healthMsP95: pct(this.probes, 95),
      healthMsMax: Math.max(0, ...this.probes),
    };
  }
}

// ---- phase: load ---------------------------------------------------------------------------------
async function load() {
  const sessions = num('--sessions', 5);
  const agents = Number(arg('--agents', 3));
  const duration = num('--duration', 120);
  const warmup = Number(arg('--warmup', 10));
  const mode = arg('--mode', 'on');
  if (mode !== 'on' && mode !== 'off') throw new Error('--mode must be on or off');
  const profile = arg('--profile', 'busy');
  if (!PROFILES[profile]) throw new Error('--profile must be busy or typical');
  const opts = { intervalMs: num('--interval', 1000), callEveryMs: num('--call-every', 8) * 1000, reportEveryMs: num('--report-every', 5) * 1000, resultSize: PROFILES[profile] };
  const srv = new Server();
  try {
    await srv.start();
    await srv.setup(mode === 'on');
    const list = Array.from({ length: sessions }, (_, i) => new LoadSession(i, agents, mode === 'on', srv.person, srv, opts));
    for (const s of list) await s.start();
    const loops = sessions * (agents + 1);
    log(`load: ${sessions} sessions x ${agents + 1} loops = ${loops}, recording ${mode}, interval ${opts.intervalMs} ms, ${profile}, warm-up ${warmup}s then ${duration}s`);
    const meter = new Meter(srv);
    const tStart = Date.now();
    let measuring = false;
    let before = null;
    let fileStart = 0;
    const gen = process.cpuUsage();
    const genT0 = performance.now();
    let genCpu0 = gen;
    let genWall0 = genT0;
    while (Date.now() - tStart < (warmup + duration) * 1000) {
      const now = Date.now();
      if (!measuring && now - tStart >= warmup * 1000) {
        measuring = true;
        before = { totals: await srv.totals(), stats: list.map((s) => ({ ...s.stats, latencies: [...s.stats.latencies] })) };
        srv.checkpoint();
        fileStart = sizeOf(srv.activity);
        meter.start();
        genCpu0 = process.cpuUsage();
        genWall0 = performance.now();
      }
      for (const s of list) s.step(now);
      await sleep(20);
    }
    const m = meter.stop();
    const genCpu = process.cpuUsage(genCpu0);
    const genWall = performance.now() - genWall0;
    const after = await srv.totals();
    for (const s of list) s.rec.close?.();
    await sleep(1500); // let in-flight requests finish
    srv.checkpoint();
    const lat = list.flatMap((s, i) => s.stats.latencies.slice(before.stats[i].latencies.length));
    const reqs = list.reduce((a, s, i) => a + s.stats.requests - before.stats[i].requests, 0);
    const entries = list.reduce((a, s, i) => a + s.stats.entries - before.stats[i].entries, 0);
    const sentBytes = list.reduce((a, s, i) => a + s.stats.bytes - before.stats[i].bytes, 0);
    const statuses = {};
    for (const s of list) for (const [k, v] of Object.entries(s.stats.statuses)) statuses[k] = (statuses[k] ?? 0) + v;
    const accounted = mode === 'on' ? after.totals.bytes - before.totals.totals.bytes : 0;
    const secs = m.seconds;
    const out = {
      phase: 'load', mode, sessions, agentsPerSession: agents, loops, profile, intervalMs: opts.intervalMs, callEverySec: opts.callEveryMs / 1000, measuredSeconds: Number(secs.toFixed(1)),
      requestsPerSec: reqs / secs, entriesPerSec: entries / secs, bodyBytesPerSec: sentBytes / secs, meanBatchEntries: reqs ? entries / reqs : 0, meanBatchKB: reqs ? sentBytes / reqs / 1024 : 0,
      requestMsP50: pct(lat, 50), requestMsP95: pct(lat, 95), requestMsMax: Math.max(0, ...lat), statuses,
      accountedBytesPerSec: accounted / secs, accountedMBPerHourPerLoop: (accounted / secs) * 3600 / MB / loops, accountedMBPerHourPerSession: (accounted / secs) * 3600 / MB / sessions,
      onDiskMBPerHourPerLoop: (((sizeOf(srv.activity) - fileStart) / secs) * 3600) / MB / loops,
      stopped: list.filter((s) => s.stats.ended).map((s) => `${s.name}:${s.stats.ended}`),
      loadgenCpuPercent: ((genCpu.user + genCpu.system) / 1000 / genWall) * 100,
      queueMaxKB: Math.max(...list.map((s) => s.stats.queueMax)) / 1024,
      batchMaxKB: Math.max(...list.map((s) => s.stats.batchMax)) / 1024,
      ...m,
    };
    if (mode === 'on') out.fileAfterCheckpointMB = sizeOf(srv.activity) / MB;
    return out;
  } finally {
    await srv.stop();
    srv.cleanup();
  }
}

// ---- phase: caps ---------------------------------------------------------------------------------
/** A batch of `n` entries of `chars` characters each, for the fill tests. */
function fillBatch(loop, startSeq, n, chars) {
  const at = Date.now();
  return { v: 1, sentAt: at, entries: Array.from({ length: n }, (_, i) => ({ loop, seq: startSeq + i, at, kind: i % 2 ? 'result' : 'text', text: slice(chars), ...(i % 2 ? { name: 'Bash', callSeq: startSeq + i - 1 } : {}) })) };
}
async function newRecorded(srv, name) {
  const s = new LoadSession(name, 0, true, srv.person, srv, { reportEveryMs: 1e9, callEveryMs: 1e9, intervalMs: 1000, resultSize: PROFILES.busy });
  await s.start();
  return s;
}
/** Posts batches to one session until the server stops taking them (or `maxBytes`). Returns what happened. */
async function fill(srv, s, maxBytes, chars = 99_000, perBatch = 4) {
  let seq = 1_000_000;
  let sent = 0;
  let posted = 0;
  let last = null;
  const t0 = performance.now();
  while (sent < maxBytes) {
    const batch = fillBatch(MAIN, seq, perBatch, chars);
    seq += perBatch;
    const r = await srv.call('POST', `/api/fleet/sessions/${s.id}/recording`, { 'X-Podium-Token': srv.personToken }, batch);
    posted++;
    last = r;
    if (r.status !== 200) break;
    sent += perBatch * chars;
    if (r.body.recording.state !== 'recording') break;
  }
  return { posted, sentMB: sent / MB, seconds: (performance.now() - t0) / 1000, last };
}
const recordingOf = async (srv, id) => (await srv.admin('GET', `/recordings?pageSize=100`)).body.rows.find((r) => r.sessionId === id);
async function replayTail(srv, id) {
  const r = await srv.browser('GET', `/sessions/${id}/recording?limit=3`);
  return r.status === 200 ? { grant: r.body.grant, tail: r.body.entries.slice(-2).map((e) => ({ kind: e.kind, text: e.text.slice(0, 80) })), total: r.body.total } : { status: r.status, body: r.body };
}

async function caps() {
  const full = args.includes('--full');
  const srv = new Server();
  const out = { phase: 'caps', full };
  try {
    await srv.start();
    await srv.setup(true);
    const limits = full ? { sessionMb: 256, budgetMb: 2048 } : { sessionMb: 8, budgetMb: 64 };
    if (!full) {
      const r = await srv.setLimits(limits);
      if (r.status >= 300) throw new Error(`limits: ${JSON.stringify(r.body)}`);
    }
    // Per-session cap.
    const a = await newRecorded(srv, 1);
    const fa = await fill(srv, a, (limits.sessionMb + 20) * MB);
    srv.checkpoint();
    const rowA = await recordingOf(srv, a.id);
    const after = await srv.call('POST', `/api/fleet/sessions/${a.id}/recording`, { 'X-Podium-Token': srv.personToken }, fillBatch(MAIN, 9_000_000, 1, 1000));
    const restart = await srv.browser('PUT', `/sessions/${a.id}/recording`, { loops: [MAIN] });
    out.session = {
      capMB: limits.sessionMb, postedBatches: fa.posted, sentMB: Number(fa.sentMB.toFixed(1)), seconds: Number(fa.seconds.toFixed(1)), mbPerSec: Number((fa.sentMB / fa.seconds).toFixed(1)),
      lastBatchStatus: fa.last.status, grantAfter: { state: fa.last.body?.recording?.state, limit: fa.last.body?.recording?.limit }, storedMB: rowA ? Number((rowA.bytes / MB).toFixed(2)) : null,
      stateInAdmin: rowA ? { state: rowA.state, limit: rowA.limit } : null, fileAfterCheckpointMB: Number(fmtMB(sizeOf(srv.activity))),
      batchAfterLimit: { status: after.status, error: after.body?.error }, restartWithPut: { status: restart.status, error: restart.body?.error }, replay: await replayTail(srv, a.id),
    };
    // Total budget: sessions fill until the budget stops all of them. With the real defaults, nine sessions of 256 MB pass 2 GB.
    const nSessions = Math.ceil(limits.budgetMb / limits.sessionMb) + 2;
    const running = [];
    for (let i = 0; i < nSessions; i++) running.push(await newRecorded(srv, 100 + i));
    const t0 = performance.now();
    const results = [];
    // Round-robin one batch at a time, so every running recording is still going when the budget is reached.
    const seqs = running.map(() => 2_000_000);
    let budgetHit = false;
    for (let round = 0; round < 100_000 && !budgetHit; round++) {
      for (let i = 0; i < running.length; i++) {
        const s = running[i];
        if (s.done) continue;
        const r = await srv.call('POST', `/api/fleet/sessions/${s.id}/recording`, { 'X-Podium-Token': srv.personToken }, fillBatch(MAIN, seqs[i], 4, 99_000));
        seqs[i] += 4;
        results[i] = r;
        if (r.status !== 200 || r.body.recording.state !== 'recording') {
          s.done = true;
          if (r.status === 200 && r.body.recording.limit === 'budget') budgetHit = true;
        }
      }
      if (running.every((s) => s.done)) break;
    }
    const secs = (performance.now() - t0) / 1000;
    srv.checkpoint();
    const t = await srv.totals();
    const fileAtBudgetMB = Number(fmtMB(sizeOf(srv.activity)));
    const rows = (await srv.admin('GET', '/recordings?pageSize=100')).body;
    const mine = rows.rows.filter((r) => running.some((s) => s.id === r.sessionId));
    const budgetLimited = mine.filter((r) => r.state === 'limit' && r.limit === 'budget').length;
    const sessionLimited = mine.filter((r) => r.state === 'limit' && r.limit === 'session').length;
    const freshS = await newRecorded(srv, 999).catch((e) => e.message);
    let fresh = freshS;
    if (typeof freshS !== 'string') {
      const r = await srv.call('POST', `/api/fleet/sessions/${freshS.id}/recording`, { 'X-Podium-Token': srv.personToken }, fillBatch(MAIN, 1, 1, 99_000));
      fresh = { start: 'started', firstBatch: { status: r.status, state: r.body?.recording?.state, limit: r.body?.recording?.limit } };
    }
    const limitedId = running.find((s) => mine.find((r) => r.sessionId === s.id && r.limit === "budget"))?.id ?? running[1].id;
    const replayLimited = await replayTail(srv, limitedId);
    const victim = running[0];
    const del = await srv.browser('DELETE', `/sessions/${victim.id}/recording`);
    const afterDel = await newRecorded(srv, 998).then(
      () => 'started',
      (e) => e.message,
    );
    out.budget = {
      budgetMB: limits.budgetMb, sessions: nSessions, seconds: Number(secs.toFixed(1)), totalStoredMB: Number(fmtMB(t.totals.bytes)), totalStoredIncludesSessionCapRun: true,
      fileAfterCheckpointMB: fileAtBudgetMB, stoppedByBudget: budgetLimited, stoppedBySessionCap: sessionLimited, runningLeft: t.totals.running,
      newRecordingWhileAtBudget: fresh, deleteStatus: del.status, newRecordingAfterDelete: afterDel,
      replayTailOfLimited: replayLimited,
    };
    return out;
  } finally {
    await srv.stop();
    srv.cleanup();
  }
}

// ---- phase: purge --------------------------------------------------------------------------------
/** Moves rows recorded in the last hour (but not the last 30 s) back by `hours` + 1 hours, so the server's next purge finds them old. */
function ageRows(srv, keepHours, minAgeMs = 30_000) {
  const db = new sqlite.DatabaseSync(srv.activity);
  db.exec('PRAGMA busy_timeout = 10000');
  const now = Date.now();
  const r = db.prepare('UPDATE rec_entries SET t = t - ? WHERE t < ? AND t > ?').run((keepHours + 1) * 3_600_000, now - minAgeMs, now - 3_600_000);
  db.close();
  return Number(r.changes);
}
async function purge() {
  const srv = new Server();
  const full = args.includes('--full-budget');
  try {
    await srv.start();
    await srv.setup(true);
    if (full) {
      await srv.setLimits({ sessionMb: 256, budgetMb: 2048 });
      const list = [];
      for (let i = 0; i < 9; i++) list.push(await newRecorded(srv, 200 + i));
      const t0 = performance.now();
      const seqs = list.map(() => 3_000_000);
      for (;;) {
        let live = 0;
        for (let i = 0; i < list.length; i++) {
          if (list[i].done) continue;
          const r = await srv.call('POST', `/api/fleet/sessions/${list[i].id}/recording`, { 'X-Podium-Token': srv.personToken }, fillBatch(MAIN, seqs[i], 4, 99_000));
          seqs[i] += 4;
          if (r.status !== 200 || r.body.recording.state !== 'recording') list[i].done = true;
          else live++;
        }
        if (!live) break;
      }
      const filled = await srv.totals();
      srv.checkpoint();
      const fileBefore = sizeOf(srv.activity);
      log(`filled ${fmtMB(filled.totals.bytes)} MB accounted in ${((performance.now() - t0) / 1000).toFixed(0)}s; file ${fmtMB(fileBefore)} MB. Aging every row, then waiting for the server's purge (up to 5 minutes).`);
      const aged = ageRows(srv, 6, 0);
      return await watchPurge(srv, { phase: 'purge-full', fillMB: Number(fmtMB(filled.totals.bytes)), fileBeforeMB: Number(fmtMB(fileBefore)), aged }, filled.totals.bytes, 8 * 60_000);
    }
    const sessions = num('--sessions', 20);
    const minutes = num('--minutes', 11);
    const opts = { intervalMs: 1000, callEveryMs: 8000, reportEveryMs: 5000, resultSize: PROFILES.busy };
    const list = Array.from({ length: sessions }, (_, i) => new LoadSession(i, 3, true, srv.person, srv, opts));
    for (const s of list) await s.start();
    log(`purge: ${sessions} sessions for ${minutes} minutes, rows older than 30 s are aged by 7 hours every 10 s`);
    const meter = new Meter(srv);
    meter.start();
    const series = [];
    let ageAt = 0;
    const t0 = Date.now();
    let aged = 0;
    while (Date.now() - t0 < minutes * 60_000) {
      const now = Date.now();
      for (const s of list) s.step(now);
      if (now >= ageAt) {
        ageAt = now + 10_000;
        aged += ageRows(srv, 6);
        const t = await srv.totals();
        series.push({ s: Math.round((now - t0) / 1000), storedMB: Number(fmtMB(t.totals.bytes)), fileMB: Number(fmtMB(srv.dbBytes())) });
      }
      await sleep(20);
    }
    const m = meter.stop();
    const lines = readFileSync(srv.logFile, 'utf8').split('\n').filter((l) => l.includes('purge'));
    const lat = list.flatMap((s) => s.stats.latencies);
    const peak = Math.max(...series.map((x) => x.storedMB));
    return { phase: 'purge', sessions, minutes, agedRows: aged, peakStoredMB: peak, finalStoredMB: series.at(-1)?.storedMB, series: series.filter((_, i) => i % 3 === 0), purgeLogLines: lines.map((l) => l.slice(0, 300)), requestMsP95: pct(lat, 95), requestMsMax: Math.max(0, ...lat), healthMsP95: m.healthMsP95, healthMsMax: m.healthMsMax, statuses: Object.fromEntries([...new Set(list.flatMap((s) => Object.keys(s.stats.statuses)))].map((k) => [k, list.reduce((a, s) => a + (s.stats.statuses[k] ?? 0), 0)])), stopped: list.filter((s) => s.stats.ended).length };
  } finally {
    await srv.stop();
    srv.cleanup();
  }
}
async function watchPurge(srv, base, startBytes, maxMs) {
  const probes = [];
  const stopProbe = setInterval(async () => {
    const t0 = performance.now();
    try {
      await fetch(`${srv.url}/api/health`);
      probes.push(performance.now() - t0);
    } catch {
      // left out
    }
  }, 100);
  const t0 = Date.now();
  let first = null;
  let done = null;
  const series = [];
  while (Date.now() - t0 < maxMs) {
    const t = await srv.totals();
    const b = t.totals.bytes;
    series.push([Date.now() - t0, b]);
    if (first === null && b < startBytes) first = Date.now() - t0;
    if (b <= 0 || (first !== null && b === 0)) {
      done = Date.now() - t0;
      break;
    }
    await sleep(250);
  }
  clearInterval(stopProbe);
  await sleep(500);
  srv.checkpoint();
  const lines = readFileSync(srv.logFile, 'utf8').split('\n').filter((l) => l.includes('purge'));
  return { ...base, waitedUntilPurgeStartedSec: first === null ? null : Number((first / 1000).toFixed(1)), purgeFinishedAtSec: done === null ? null : Number((done / 1000).toFixed(1)), purgeSeconds: first !== null && done !== null ? Number(((done - first) / 1000).toFixed(1)) : null, fileAfterMB: Number(fmtMB(sizeOf(srv.activity))), healthMsP50: pct(probes, 50), healthMsP95: pct(probes, 95), healthMsMax: Math.max(0, ...probes), purgeLogLines: lines.map((l) => l.slice(0, 300)) };
}

// ---- main ----------------------------------------------------------------------------------------
let result;
process.on('SIGINT', () => process.exit(130));
if (PHASE === 'load') result = await load();
else if (PHASE === 'caps') result = await caps();
else if (PHASE === 'purge') result = await purge();
else {
  console.error(HELP);
  process.exit(2);
}
const text = JSON.stringify(result, (_, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(3)) : v), 2);
console.log(text);
if (arg('--json', '')) writeFileSync(arg('--json', ''), text);
