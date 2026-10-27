#!/usr/bin/env node
// In-process cost of the reporter mod's pure code (#682): what one tool call adds to a session's state, and what building and
// serializing one report costs, as the number of agents in the session grows. This is the part of a hook's overhead that is
// arithmetic; the git and title child processes, the network and the engine's own hook plumbing are not measured here.
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAG = '--experimental-transform-types';
const HELP = `Usage: node scripts/podium-perf-mod.mjs [--agents 0,20,200] [--calls N] [--json] [-h]

Times the reporter mod's reducers and report builder in this process (no server, no network, no Claude Code).

  --agents <list>  agent counts to measure, comma separated (default 0,20,200)
  --calls <n>      tool calls per agent count after the agents exist (default 400)
  --json           print JSON instead of a table
  -h, --help       show this help

Per agent count it prints the microseconds one tool-call reducer takes (median and 99th percentile over the calls), the milliseconds
buildReport takes (median of 30), and the report's size as JSON in KB with the time JSON.stringify takes.`;
const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}
// The mod is TypeScript with parameter properties, which plain Node cannot strip; run again with the transform flag on.
if (!process.execArgv.includes(FLAG)) {
  const r = spawnSync(process.execPath, [FLAG, '--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const AGENTS = arg('--agents', '0,20,200').split(',').map(Number);
const CALLS = Number(arg('--calls', '400'));
if (AGENTS.some((n) => !Number.isInteger(n) || n < 0) || !Number.isInteger(CALLS) || CALLS < 1) throw new Error('--agents and --calls must be whole numbers');

const mod = (f) => import(pathToFileURL(path.join(ROOT, 'mod/podium-reporter/hooks', f)).href);
const { newSession, agentSpawned, toolResult, step, drainEvents, turnStart } = await mod('state.ts');
const { buildReport } = await mod('report.ts');

const T0 = 1_800_000_000_000;
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * p) / 100))];
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

function sessionWith(agents) {
  let s = newSession({ id: 'perf-1', cwd: '/work/app', startedAt: T0, model: 'claude-opus-5-5' });
  s = turnStart(s);
  for (let i = 0; i < agents; i++) {
    s = agentSpawned(s, { toolUseId: `tu-${i}`, agentId: `a${i}`, model: 'claude-haiku-5-5', subagentType: 'general-purpose', description: `agent ${i}`, prompt: 'do the thing', fork: false }, T0 + i);
    s = step(s, { agentId: `a${i}`, model: 'claude-haiku-5-5', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 }, stopReason: 'tool_use' }, T0 + i);
  }
  return s;
}

const rows = [];
for (const n of AGENTS) {
  let s = sessionWith(n);
  const times = [];
  for (let i = 0; i < CALLS; i++) {
    const agentId = n > 0 ? `a${i % n}` : undefined;
    const t = performance.now();
    s = toolResult(s, { ...(agentId ? { agentId } : {}), tool: 'Bash', input: { command: `echo ${i}` }, result: { text: 'x'.repeat(200) } }, T0 + 10_000 + i);
    times.push((performance.now() - t) * 1000);
  }
  const meta = { version: '0.0.0', engineVersion: '2.1.296', hostSurface: 'terminal', now: T0 + 20_000, storedName: null, claudeName: null, optionName: null };
  const builds = [];
  let json = '';
  let stringify = 0;
  for (let i = 0; i < 30; i++) {
    const [s2, events] = drainEvents(s);
    const t = performance.now();
    const report = buildReport(s2, events, meta);
    builds.push(performance.now() - t);
    const t2 = performance.now();
    json = JSON.stringify(report);
    stringify = performance.now() - t2;
  }
  rows.push({ agents: n, toolCallUsMedian: round(pct(times, 50), 2), toolCallUsP99: round(pct(times, 99), 2), buildReportMsMedian: round(pct(builds, 50), 2), reportKb: round(Buffer.byteLength(json) / 1024), stringifyMs: round(stringify, 2) });
}

if (args.includes('--json')) console.log(JSON.stringify({ tool: 'podium-perf-mod', node: process.version, calls: CALLS, rows }, null, 2));
else {
  console.log('agents  tool call us (p50 / p99)  buildReport ms  report KB  stringify ms');
  for (const r of rows) console.log(`${String(r.agents).padEnd(7)} ${`${r.toolCallUsMedian} / ${r.toolCallUsP99}`.padEnd(23)} ${String(r.buildReportMsMedian).padEnd(15)} ${String(r.reportKb).padEnd(10)} ${r.stringifyMs}`);
}
