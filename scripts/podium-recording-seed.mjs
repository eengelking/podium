#!/usr/bin/env node
// Seeds session recording (#353) for looking at the wall's recording band, the orchestrator page's layer, the Recording cell, the
// picker, the replay, History and Admin in a browser, against a throwaway Podium server (one started with PODIUM_TOKEN, since a
// recording needs sign-in). Turns the flags on, makes a person, reports five sessions and records four of them as a reporter would:
//   api-refactor  running, an orchestrator with two agents and a fork, recording, with 300 rows (more than one replay page), a failed
//                 call, a compaction, thinking marks, a long result and a long prompt
//   flaky-tests   running, chosen for recording but the owner's reporter has not turned sessionRecording on, so nothing is captured
//   docs-sweep    running, recorded and then stopped by its owner, so the recording is only kept
//   old-run       ended, with its recording kept: it is listed in History
//   plain         running, never recorded
// Prints the person's name and token so a browser can sign in. With --keep it reports every 8 seconds so the sessions stay live.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `Usage: node scripts/podium-recording-seed.mjs --url <server> --secret <admin secret> [--name Ed] [--keep]

Seeds session recording for looking at it in a browser. Never point it at a server you use: it changes the Admin's settings,
adds a person and starts recordings.

  --url     the throwaway Podium server, such as http://127.0.0.1:4392 (started with PODIUM_TOKEN set)
  --secret  its admin secret (PODIUM_TOKEN)
  --name    the person to make (default Ed; a suffix is added if taken)
  --keep    keep reporting every 8 seconds so the live sessions stay live, until stopped
  -h        show this help`;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const URL_ARG = arg('--url', '');
const SECRET = arg('--secret', process.env.PODIUM_TOKEN);
if (!URL_ARG || !SECRET) {
  console.error(HELP);
  process.exit(2);
}
const URL_ = new URL(URL_ARG).origin;
const rid = () => randomBytes(6).toString('hex');
const MAIN = '@orchestrator';

let adminCookie = '';
async function call(method, path, headers, body) {
  const res = await fetch(new URL(path, URL_), { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (path.startsWith('/api/admin') && set.length) adminCookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const admin = (m, p, b) => call(m, `/api/admin${p}`, { 'X-Podium-Admin': '1', cookie: adminCookie }, b);
const must = (r, what) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

const person = { name: arg('--name', 'Ed'), token: '' };
const machine = { name: 'silverbolt', id: `mac${rid()}`, os: 'macOS 26.0' };
const sess = (name, over = {}) => ({ id: `rec-${name}-${rid()}`, name, status: 'running', allow: true, agents: [], ...over });
const sessions = [
  sess('api-refactor', {
    agents: [
      { id: `ag-schema-${rid()}`, parentId: null, kind: 'subagent', name: 'schema-writer', description: 'Write the v2 schema' },
      { id: `ag-port-${rid()}`, parentId: null, kind: 'subagent', name: 'endpoint-port', description: 'Port the invoice endpoints' },
    ],
  }),
  sess('flaky-tests', { status: 'waiting', allow: false }),
  sess('docs-sweep'),
  sess('old-run'),
  sess('plain', { allow: false }),
];
sessions[0].agents.push({ id: `ag-fix-${rid()}`, parentId: sessions[0].agents[1].id, kind: 'fork', name: 'test-fixer', description: 'Try the second approach' });
const [api, flaky, docs, old, plain] = sessions;

function agentReport(a) {
  const now = Date.now();
  return {
    id: a.id, parentId: a.parentId, kind: a.kind, type: 'general-purpose', name: a.name, description: a.description, model: 'claude-sonnet-5-5', effort: 'medium', effortSource: 'requested',
    status: 'running', startedAt: now - 300_000, endedAt: null, context: { tokens: 100_000, window: 1_000_000, percent: 10 }, tokens: { input: 1000, output: 500, cacheRead: 8000, cacheWrite: 500 },
    costUsdEst: 0.12, skills: [], lastTool: 'Read', toolCalls: 3, toolCounts: null, blowouts: 0, steps: { done: 2, total: null }, promptExcerpt: 'Find every call site.', answerExcerpt: null, failure: null,
  };
}
function report(s, status = s.status) {
  const now = Date.now();
  return {
    v: 1,
    sentAt: now,
    reporter: { name: 'podium-reporter', version: VERSION, engineVersion: '2.1.301', hostSurface: 'terminal' },
    userName: person.name,
    machine,
    session: {
      id: s.id, name: s.name, status, waitReason: status === 'waiting' ? 'input' : null, waitNote: null, endReason: status === 'done' ? 'prompt_input_exit' : null, resumeId: null,
      startedAt: now - 3_000_000, cwd: `/Users/dev/${s.name}`, projectRoot: `/Users/dev/${s.name}`, repoName: `eengelking/${s.name}`,
      git: { branch: 'refactor/invoice-v2', detached: false, isWorktree: false, worktreePath: null, ahead: 7, behind: 0, dirty: 3 },
      model: 'claude-opus-5-5', effort: 'xhigh', context: { tokens: 410_000, window: 1_000_000, percent: 41 }, costUsd: 12.84,
      tokens: { input: 300_000, output: 30_000, cacheRead: 0, cacheWrite: 0 }, rateLimits: [], blowouts: 0, plan: null,
      loop: { skills: [], lastTool: 'Read', toolCalls: 4, toolCounts: { Read: 4 }, steps: { done: 6, total: null } }, files: null, attached: true,
      activityFeed: true, sessionRecording: s.allow,
    },
    agents: s.agents.map(agentReport),
    events: [],
  };
}
const reportAll = () => Promise.all(sessions.filter((s) => s !== old).map((s) => call('POST', '/api/fleet/report', { 'X-Podium-Token': person.token }, report(s))));

must(await admin('POST', '/unlock', { name: 'Admin', token: SECRET }), 'unlock');
must(await admin('PUT', '/settings', { features: { 'session-recording': true, respond: true, 'activity-feed': true } }), 'flags');
let made = await admin('POST', '/people', { name: person.name });
if (made.status >= 300) {
  person.name = `${person.name}-${rid().slice(0, 4)}`;
  made = must(await admin('POST', '/people', { name: person.name }), 'person');
}
person.token = made.body.token;
const storedName = made.body.person.name;
for (const r of await Promise.all(sessions.map((s) => call('POST', '/api/fleet/report', { 'X-Podium-Token': person.token }, report(s))))) must(r, 'report');

const jar = { v: '' };
const browser = async (m, p, b) => {
  const res = await fetch(new URL(`/api/fleet/respond${p}`, URL_), { method: m, headers: { 'Content-Type': 'application/json', 'X-Podium-Respond': '1', cookie: jar.v }, body: b === undefined ? undefined : JSON.stringify(b) });
  const set = res.headers.getSetCookie?.() ?? [];
  const pairs = set.map((c) => c.split(';')[0]).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]);
  if (set.length) jar.v = [...new Map(pairs.filter(([, v]) => v)).entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
must(await browser('POST', '/sign-in', { name: person.name, token: person.token }), 'sign in');
const start = async (s, loops) => must(await browser("PUT", `/sessions/${s.id}/recording`, { loops }), `start ${s.name}`);

// ---- what a recording holds ------------------------------------------------------------------
let seq = {};
const nextSeq = (loop) => (seq[loop] = (seq[loop] ?? 0) + 1);
const t0 = Date.now() - 50 * 60_000;
let clock = t0;
const tick = (ms = 4000) => (clock += ms);
function entry(loop, kind, text, extra = {}) {
  return { loop, seq: nextSeq(loop), at: tick(), kind, text, ...extra };
}
const LONG_PROMPT = `Migrate invoices to the v2 schema. ${'Keep the old endpoints working until the flag is on, and write a test for each one. '.repeat(14)}`;
const LONG_RESULT = Array.from({ length: 60 }, (_, i) => `server/src/invoices/line${i}.ts: export const field${i} = z.string();`).join('\n');
function story(s, loops) {
  const [main, a, b, f] = [MAIN, ...s.agents.map((x) => x.id)];
  const out = [];
  out.push(entry(main, 'prompt', LONG_PROMPT));
  out.push(entry(main, 'thinking', ''));
  out.push(entry(main, 'text', 'I will read the current schema before changing anything, then hand the endpoint port to an agent.'));
  const call = (loop, name, input, result, failed = false) => {
    const c = entry(loop, 'tool', input, { name });
    out.push(c, entry(loop, 'result', result, { name, callSeq: c.seq, ...(failed ? { failed: true } : {}) }));
  };
  call(main, 'Read', 'server/src/invoices/schema.ts', LONG_RESULT);
  if (a) out.push(entry(a, 'prompt', 'Write the v2 schema for invoices. Do not touch the tests.'), entry(a, 'thinking', ''), entry(a, 'text', 'Starting from the v1 shape and adding currency.'));
  if (b) {
    out.push(entry(b, 'prompt', 'Port the invoice endpoints to the v2 schema.'));
    call(b, 'Bash', 'npm test -w server -- invoices\nsecond line of the command', 'FAIL server/src/invoices/list.test.ts\n  list invoices returns v2 shape\n    Expected currency USD, received undefined\n\nTests: 1 failed, 41 passed', true);
  }
  if (f) out.push(entry(f, 'prompt', 'Check why list.test.ts expected a currency before the change.'), entry(f, 'text', 'The handler drops currency when it maps the row.'));
  out.push(entry(main, 'compact', ''));
  for (let i = 0; i < 140 && loops > 1; i++) call(i % 3 === 0 && b ? b : main, 'Read', `server/src/invoices/file${i}.ts`, `// file ${i}\nexport const x${i} = ${i};`);
  out.push(entry(main, 'text', 'The port is done and the tests pass.'));
  return out;
}
async function send(s, entries) {
  for (let i = 0; i < entries.length; i += 150) {
    const batch = { v: 1, sentAt: Date.now(), entries: entries.slice(i, i + 150) };
    must(await call('POST', `/api/fleet/sessions/${s.id}/recording`, { 'X-Podium-Token': person.token }, batch), `batch ${s.name}`);
  }
}

await start(api, [MAIN, ...api.agents.map((x) => x.id)].slice(0, 3)); // the fork is left out, so the layer names a loop that is not recorded
await send(api, story(api, 3));
await start(flaky, [MAIN]);
await start(docs, [MAIN]);
seq = {};
await send(docs, story({ ...docs, agents: [] }, 1));
must(await browser('POST', `/sessions/${docs.id}/recording/stop`), 'stop docs-sweep');
await start(old, [MAIN]);
seq = {};
await send(old, story({ ...old, agents: [] }, 1));
// The session ends: its recording stays, and History lists it.
must(await call('POST', '/api/fleet/report', { 'X-Podium-Token': person.token }, report(old, 'done')), 'end old-run');
void plain;

const line = (v) => String(v).replaceAll(/[\r\n]+/g, ' ');
console.log(`name=${line(storedName)}`);
console.log(`token=${line(person.token)}`);
console.log(`sessions=${sessions.map((s) => `${s.name}:${s.id}`).join(' ')}`);
if (args.includes('--keep')) {
  console.log('reporting every 8 seconds; stop with Ctrl-C');
  setInterval(() => void reportAll().catch(() => undefined), 8000);
}
