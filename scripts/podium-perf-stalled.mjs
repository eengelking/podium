#!/usr/bin/env node
// Measures what a stream client that stops reading costs the server (#748): resident memory over time and the moment the server
// ends the client. Starts a throwaway server and the simulator at the large fleet (50 sessions x 20 agents), opens one healthy
// stream client and N stalled ones (a raw socket that sends the request and never reads), samples the server's resident memory,
// and stops everything it started. It never touches a server, port or data folder you use.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`Usage: node scripts/podium-perf-stalled.mjs [--stalled <n>] [--seconds <s>] [--warmup <s>] [--sessions <n>] [--agents <n>]

Starts a throwaway server and the simulator, opens one healthy stream client and <n> clients that never read (default 3), and for
<s> seconds (default 60) prints the server's resident memory every 2 s plus the server log lines that end a client. Build the
server first (npm run build -w server). Everything it starts is stopped at the end.

  --stalled <n>    clients that send the request and never read (default 3)
  --seconds <s>    seconds measured after the warm-up (default 60)
  --warmup <s>     seconds the simulator runs before the stalled clients connect (default 10)
  --sessions <n>   simulated sessions (default 50)
  --agents <n>     agents per session (default 20)`);
  process.exit(0);
}
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? d : Number(args[i + 1]);
};
const STALLED = opt('stalled', 3);
const SECONDS = opt('seconds', 60);
const WARMUP = opt('warmup', 10);
const SESSIONS = opt('sessions', 50);
const AGENTS = opt('agents', 20);
/** The stream clients the server holds, read from the fleet health route (`sseClients` of `/api/fleet/health`). */
const clientCount = async (url) => {
  try {
    return (await (await fetch(`${url}/api/fleet/health`)).json()).sseClients;
  } catch {
    return '?';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

const rssMb = (pid) => Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

if (!existsSync(path.join(ROOT, 'server/dist/index.js'))) throw new Error('server/dist is missing: run npm run build -w server first');
const dir = mkdtempSync(path.join(tmpdir(), 'podium-stalled-'));
const token = randomBytes(24).toString('hex');
const port = await freePort();
const logFile = path.join(dir, 'server.log');
const out = openSync(logFile, 'w');
const server = spawn(process.execPath, [path.join(ROOT, 'server/dist/index.js')], {
  cwd: ROOT,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), HOST: '127.0.0.1', PODIUM_DB: path.join(dir, 'podium.sqlite'), PODIUM_DATA_DIR: dir, PODIUM_TOKEN: token, PODIUM_LOG_LEVEL: 'info' },
  stdio: ['ignore', out, out],
});
let sim = null;
const sockets = [];
const stop = async () => {
  for (const s of sockets) s.destroy();
  if (sim) try { process.kill(-sim.pid, 'SIGTERM'); } catch { /* gone */ }
  server.kill('SIGTERM');
  await sleep(500);
  if (server.exitCode === null) server.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
};
process.on('SIGINT', () => stop().then(() => process.exit(130)));
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  sim = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'scripts/podium-sim.ts'), '--url', `http://127.0.0.1:${port}`, '--token', token, '--sessions', String(SESSIONS), '--agents', String(AGENTS), '--seed', '682', '--duration', String(WARMUP + SECONDS + 30)], { stdio: 'ignore', detached: true });
  log(`server pid ${server.pid}, large fleet ${SESSIONS}x${AGENTS}, warm-up ${WARMUP}s`);
  await sleep(WARMUP * 1000);

  // One healthy client: counts ticks, to show it is never ended.
  let ticks = 0;
  let bytes = 0;
  let healthyEnded = false;
  const ctl = new AbortController();
  fetch(`http://127.0.0.1:${port}/api/fleet/stream`, { signal: ctl.signal })
    .then(async (res) => {
      const dec = new TextDecoder();
      for await (const c of res.body) bytes += c.length, ticks += (dec.decode(c).match(/event: tick/g) ?? []).length;
      healthyEnded = true;
    })
    .catch(() => {});

  const baseline = rssMb(server.pid);
  log(`t=0s rss=${baseline.toFixed(0)} MB (before the stalled clients connect)`);
  const closedAt = [];
  const t0 = Date.now();
  for (let i = 0; i < STALLED; i++) {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET /api/fleet/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`));
    s.pause(); // never reads
    s.on('error', () => {});
    s.on('close', () => closedAt.push(((Date.now() - t0) / 1000).toFixed(1)));
    sockets.push(s);
  }
  let peak = baseline;
  let droppedAt = null;
  const poll = setInterval(async () => {
    if (droppedAt === null && STALLED > 0 && (await clientCount(`http://127.0.0.1:${port}`)) === 1) droppedAt = ((Date.now() - t0) / 1000).toFixed(1);
  }, 250);
  for (let t = 2; t <= SECONDS; t += 2) {
    await sleep(2000);
    const r = rssMb(server.pid);
    peak = Math.max(peak, r);
    log(`t=${t}s rss=${r.toFixed(0)} MB healthy-ticks=${ticks} healthy-MB=${(bytes / 1048576).toFixed(0)} stalled-closed=${closedAt.length}/${STALLED} hub-clients=${await clientCount(`http://127.0.0.1:${port}`)}`);
  }
  await sleep(3000);
  const end = rssMb(server.pid);
  log(`peak ${peak.toFixed(0)} MB, end ${end.toFixed(0)} MB, baseline ${baseline.toFixed(0)} MB`);
  log(`stalled clients closed at (s): ${closedAt.join(', ') || 'none'}; healthy client ended: ${healthyEnded}, ticks ${ticks}`);
  const lines = readFileSync(logFile, 'utf8').split('\n').filter((l) => /slow_client_ended|not reading/.test(l));
  log(`server log tail: ${readFileSync(logFile, 'utf8').split('\n').slice(-6).join(' | ').slice(0, 600)}`);
  log(`server log, ${lines.length} slow_client_ended line(s)${lines[0] ? `, first: ${lines[0].slice(0, 200)}` : ''}`);
  clearInterval(poll);
  log(`stalled clients gone from the hub after ${droppedAt ?? 'never (within the run)'} s`);
  ctl.abort();
} finally {
  await stop();
}
