#!/usr/bin/env node
// How many bytes a busy session's reporter posts in a minute (#752, finding 8 of docs/PERFORMANCE.md). It plays one Claude Code session
// with many agents through the real report builder and the real Transport (the one both reporters share), with the clock moved by hand and a
// fetch that only counts, so a minute takes a moment and nothing touches a server.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAG = '--experimental-transform-types';
const HELP = `Usage: node scripts/podium-perf-report-rate.mjs [--agents 200] [--minutes 1] [--calls-per-second 20] [--flush-ms 1000] [--json] [-h]

Counts the POSTs and bytes one session's reporter sends in simulated time, with a busy session: every second --calls-per-second
agents finish a tool call and a model step, which moves the token counters and marks the session changed, as a live session does.
Claude Code reporter's state and report builder over plugin/core's Transport; the OpenCode reporter shares that Transport.

  --agents <n>            agents in the session (default 200)
  --minutes <n>           simulated minutes (default 1)
  --calls-per-second <n>  tool calls (and steps) each second (default 20)
  --flush-ms <n>          the flush timer's period (default 1000, the reporter's own)
  --json                  print JSON instead of a line
  -h, --help              show this help`;
const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}
const relaunch = () => spawnSync(process.execPath, [FLAG, '--no-warnings', fileURLToPath(import.meta.url), ...args], { stdio: 'inherit' }).status ?? 1;
if (!process.execArgv.includes(FLAG)) process.exit(relaunch());
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const AGENTS = Number(arg('--agents', '200'));
const MINUTES = Number(arg('--minutes', '1'));
const CPS = Number(arg('--calls-per-second', '20'));
const FLUSH = Number(arg('--flush-ms', '1000'));
if ([AGENTS, MINUTES, CPS, FLUSH].some((n) => !Number.isInteger(n) || n < 1)) throw new Error('every option must be a whole number of at least 1');

const mod = (base, f) => import(pathToFileURL(path.join(ROOT, base, f)).href);
const { newSession, agentSpawned, toolResult, step, drainEvents, turnStart } = await mod('plugin/claudecode/hooks', 'state.ts');
const { buildReport } = await mod('plugin/claudecode/hooks', 'report.ts');
const { Transport } = await mod('plugin/core', 'transport.ts');

const T0 = 1_800_000_000_000;
let s = turnStart(newSession({ id: 'rate-1', cwd: '/work/app', startedAt: T0, model: 'claude-opus-5-5' }));
for (let i = 0; i < AGENTS; i++) {
  s = agentSpawned(s, { toolUseId: `tu-${i}`, agentId: `a${i}`, model: 'claude-haiku-5-5', subagentType: 'general-purpose', description: `agent ${i}`, prompt: 'do the thing', fork: false }, T0 + i);
  s = step(s, { agentId: `a${i}`, model: 'claude-haiku-5-5', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 }, stopReason: 'tool_use' }, T0 + i);
}

let posts = 0;
let bytes = 0;
const fetch = async (_url, init) => {
  posts++;
  bytes += Buffer.byteLength(init.body ?? '');
  return { status: 200, ok: true, text: '{}' };
};
const transport = new Transport(fetch, { serverUrl: 'https://podium.test', token: '', heartbeatMs: 5000, version: '0.0.0' });
const meta = (now) => ({ version: '0.0.0', engineVersion: '2.1.296', hostSurface: 'terminal', now, storedName: null, claudeName: null, optionName: null });

let dirty = true;
let call = 0;
const seconds = MINUTES * 60;
for (let t = 1; t <= seconds * (1000 / FLUSH); t++) {
  const now = T0 + 60_000 + t * FLUSH;
  for (let k = 0; k < Math.max(1, Math.round((CPS * FLUSH) / 1000)); k++, call++) {
    const agentId = `a${call % AGENTS}`;
    s = step(s, { agentId, model: 'claude-haiku-5-5', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 }, stopReason: 'tool_use' }, now);
    s = toolResult(s, { agentId, tool: 'Bash', input: { command: `echo ${call}` }, result: { text: 'x'.repeat(200) } }, now);
    dirty = true;
  }
  const [st, events] = drainEvents(s);
  s = st;
  transport.enqueue(events);
  if (!transport.due(now, dirty)) continue;
  dirty = false;
  // eslint-disable-next-line no-await-in-loop
  await transport.send((evs) => buildReport(s, evs, meta(now)), now);
}

const row = { agents: AGENTS, minutes: MINUTES, callsPerSecond: CPS, flushMs: FLUSH, postsPerMinute: Math.round(posts / MINUTES), kbPerMinute: Math.round(bytes / 1024 / MINUTES), kbPerPost: posts ? Math.round(bytes / 1024 / posts) : 0 };
if (args.includes('--json')) console.log(JSON.stringify(row));
else console.log(`agents ${row.agents}, ${row.callsPerSecond} calls/s, flush ${row.flushMs} ms: ${row.postsPerMinute} POSTs/min, ${row.kbPerMinute} KB/min, ${row.kbPerPost} KB per POST`);
