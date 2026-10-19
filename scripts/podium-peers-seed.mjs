#!/usr/bin/env node
// Seeds one person's reporters for looking at My reporters (#415) in a browser, against a throwaway Podium server.
// Turns the messaging flags on, makes a person, reports four machines (one with messaging off), sets some rights, and
// opens one of each request: an Admin's proposal, an orchestrator's request for access, and a message waiting for
// approval. Prints the person's name and token so a browser can sign in. With --keep it reports every 8 seconds so the
// sessions stay live, until stopped.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `Usage: node scripts/podium-peers-seed.mjs --url <server> --secret <admin secret> [--name Ed] [--long] [--keep]

Seeds one person's reporters with orchestrator messaging on, for looking at My reporters in a browser.
Never point it at a server you use: it changes the Admin's settings and adds a person.

  --url     the throwaway Podium server, such as http://127.0.0.1:4391
  --secret  its admin secret (PODIUM_TOKEN)
  --name    the person to make (default Ed; a suffix is added if taken)
  --long    give two machines very long names
  --keep    keep reporting every 8 seconds so the sessions stay live
  -h        show this help`;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const URL_ARG = arg('--url', '');
const SECRET = arg('--secret', process.env.PODIUM_TOKEN);
const long = args.includes('--long');
if (!URL_ARG || !SECRET) {
  console.error(HELP);
  process.exit(2);
}
const URL_ = new URL(URL_ARG).origin;

let adminCookie = '';
async function call(method, path, headers, body) {
  const res = await fetch(new URL(path, URL_), { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (path.startsWith('/api/admin') && set.length) adminCookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const admin = (m, p, b) => call(m, `/api/admin${p}`, { 'X-Podium-Admin': '1', cookie: adminCookie }, b);
const rid = () => randomBytes(6).toString('hex');

const person = { name: arg('--name', 'Ed'), token: '' };
const machines = {
  mbp: { name: long ? 'ed-macbook-pro-16-inch-2026-home-office' : 'ed-mbp', id: `mac${rid()}`, os: 'macOS 26.1' },
  ci: { name: long ? 'ci-runner-01.lab.internal.example' : 'ci-runner-01', id: `lnx${rid()}`, os: 'Ubuntu 24.04' },
  pi: { name: 'build-pi', id: `pi0${rid()}`, os: 'Debian 12, arm64' },
  win: { name: 'win-lab', id: `win${rid()}`, os: 'Windows 11' },
};
const sessions = [
  { m: machines.mbp, id: `seed-dev-${rid()}`, name: 'claude-dashboard', status: 'running', peers: true },
  { m: machines.mbp, id: `seed-notes-${rid()}`, name: 'infra-notes', status: 'waiting', peers: true },
  { m: machines.ci, id: `seed-tester-${rid()}`, name: 'Tester', status: 'waiting', peers: true },
  { m: machines.pi, id: `seed-arm-${rid()}`, name: 'arm64-check', status: 'running', peers: true },
  { m: machines.win, id: `seed-win-${rid()}`, name: 'win-build', status: 'waiting', peers: false },
];

function report(s) {
  const now = Date.now();
  return {
    v: 1,
    sentAt: now,
    reporter: { name: 'podium-reporter', version: VERSION, engineVersion: '2.1.301', hostSurface: 'terminal' },
    userName: person.name,
    machine: s.m,
    session: {
      id: s.id, name: s.name, status: s.status, waitReason: s.status === 'waiting' ? 'input' : null, waitNote: null, endReason: null, resumeId: null, peers: s.peers,
      startedAt: now - 600_000, cwd: `/Users/dev/${s.name}`, projectRoot: `/Users/dev/${s.name}`, repoName: `eengelking/${s.name}`,
      git: { branch: 'development', detached: false, isWorktree: false, worktreePath: null, ahead: 0, behind: 0, dirty: 0 },
      model: 'claude-opus-5-5', effort: 'high', context: { tokens: 120_000, window: 1_000_000, percent: 12 }, costUsd: 1.2,
      tokens: { input: 300_000, output: 30_000, cacheRead: 0, cacheWrite: 0 }, rateLimits: [], blowouts: 0, plan: null,
      loop: { skills: [], lastTool: 'Read', toolCalls: 4, toolCounts: { Read: 4 }, steps: { done: 6, total: null } },
      files: null, attached: true,
    },
    agents: [],
    events: [],
  };
}
const reportAll = () => Promise.all(sessions.map((s) => call('POST', '/api/fleet/report', { 'X-Podium-Token': person.token }, report(s))));
const must = (r, what) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

must(await admin('POST', '/unlock', { name: 'Admin', token: SECRET }), 'unlock');
must(await admin('PUT', '/settings', { features: { 'peer-messaging': true, respond: true, 'activity-feed': true } }), 'flags');
let made = await admin('POST', '/people', { name: person.name });
if (made.status >= 300) {
  person.name = `${person.name}-${rid().slice(0, 4)}`;
  made = must(await admin('POST', '/people', { name: person.name }), 'person');
}
person.token = made.body.token;
// The name as the server stored it: what the browser signs in with, and never the raw --name text in the output.
const storedName = made.body.person.name;
for (const r of await reportAll()) must(r, 'report');

// Rights set by the owner directly in the database would need a browser sign-in; the mod-side and admin routes do the rest.
const jarCookie = { v: '' };
const browser = async (m, p, b) => {
  const res = await fetch(new URL(`/api/fleet/respond${p}`, URL_), { method: m, headers: { 'Content-Type': 'application/json', 'X-Podium-Respond': '1', cookie: jarCookie.v }, body: b === undefined ? undefined : JSON.stringify(b) });
  const set = res.headers.getSetCookie?.() ?? [];
  // Sign-in clears an old cookie path and then sets the new one under the same name: keep the last value per name.
  // Split on the first '=' only: a value can hold '=' (base64 padding).
  const pairs = set.map((c) => c.split(';')[0]).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]);
  if (set.length) jarCookie.v = [...new Map(pairs.filter(([, v]) => v)).entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const signed = must(await browser('POST', '/sign-in', { name: person.name, token: person.token }), 'sign in');
if (!jarCookie.v) throw new Error(`sign in set no cookie: ${JSON.stringify(signed.body)}`);
const { mbp, ci, pi } = machines;
for (const [from, to, level] of [[mbp, mbp, 'send'], [mbp, ci, 'send'], [ci, mbp, 'send'], [mbp, pi, 'ask'], [pi, mbp, 'see']]) {
  must(await browser('PUT', '/peers/rights', { from: from.id, to: to.id, level }), `right ${from.name} to ${to.name}`);
}
must(await browser('PUT', '/peers/links', { a: mbp.id, b: mbp.id, paused: true }), 'pause');
must(await admin('POST', `/reporters/${pi.id}/peers/propose`, { to: mbp.id, level: 'ask' }), 'proposal');
const tester = sessions[2];
must(await call('POST', `/api/fleet/sessions/${tester.id}/peers/access`, { 'X-Podium-Token': person.token }, { to: pi.name, right: 'send', reason: 'I need the arm64 build of podium-reporter tested on a Raspberry Pi before the release. <b>not bold</b>' }), 'access');
const dev = sessions[0];
must(await call('POST', `/api/fleet/sessions/${dev.id}/peers/messages`, { 'X-Podium-Token': person.token }, { to: `arm64-check@${pi.name}`, text: 'Also run npm run test:mod there. The registry token is [redacted].' }), 'message');

console.log(`name=${storedName}`);
console.log(`token=${person.token}`);
if (args.includes('--keep')) {
  console.log('reporting every 8 seconds; stop with Ctrl-C');
  setInterval(() => void reportAll().catch(() => undefined), 8000);
}
