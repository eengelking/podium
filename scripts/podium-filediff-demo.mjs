#!/usr/bin/env node
// Plays a reporter that serves file diffs, for looking at the file diff modal (#319, #630) in a browser against a throwaway
// Podium server. Turns the Admin's File diff flag on, makes a person, reports one running session that person owns with
// many changed files (one of them binary) and the fileDiff option on, keeps it alive, and answers each diff the browser
// asks for with a short made-up one. Never point it at a server you use: it changes the Admin's settings and adds a person.
import { readFileSync } from 'node:fs';

const HELP = `Usage: node scripts/podium-filediff-demo.mjs --url <server> --secret <admin secret> [--files 45] [--name Ed] [--seconds 600]

  --url      the throwaway Podium server, such as http://127.0.0.1:4391 (required)
  --secret   its admin secret, PODIUM_TOKEN (required)
  --files    changed files to report, at most 200 (default 45; the list is paged at 20)
  --name     the person who owns the session (default Ed)
  --seconds  how long to keep the session alive and answer diffs (default 600)
  -h         show this help

Prints the person's name and token, so a browser can sign in (POST /api/fleet/respond/sign-in).`;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const URL_ = arg('--url');
const SECRET = arg('--secret');
const FILES = Math.min(200, Number(arg('--files', '45')));
const NAME = arg('--name', 'Ed');
const SECONDS = Number(arg('--seconds', '600'));
if (!URL_ || !SECRET) {
  console.error(HELP);
  process.exit(2);
}

let cookie = '';
async function admin(method, path, body) {
  const res = await fetch(`${URL_}/api/admin${path}`, {
    method,
    headers: { 'X-Podium-Admin': '1', 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return res.json();
}
async function mod(token, method, path, body) {
  const res = await fetch(`${URL_}/api/fleet${path}`, { method, headers: { 'X-Podium-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const sample = JSON.parse(readFileSync(new URL('../docs/fixtures/report.sample.json', import.meta.url), 'utf8'));
const files = Array.from({ length: FILES }, (_, i) => {
  const n = i + 1;
  if (n % 9 === 0) return { path: `assets/image-${n}.png`, status: 'modified', from: null, added: null, removed: null };
  return { path: `src/module-${String(n).padStart(2, '0')}/file-${n}.ts`, status: n % 5 === 0 ? 'added' : 'modified', from: null, added: n + 3, removed: n % 5 === 0 ? 0 : n % 7 };
});
const counted = files.filter((f) => f.added !== null);
const filesReport = { files, total: FILES, added: counted.reduce((a, f) => a + f.added, 0), removed: counted.reduce((a, f) => a + f.removed, 0), since: 'start' };

const report = () => ({
  ...sample,
  sentAt: Date.now(),
  userName: NAME,
  session: { ...sample.session, id: 'demo-filediff', name: 'diff-stepper', status: 'running', waitReason: null, waitNote: null, fileDiff: true, files: filesReport, asks: [] },
  agents: [],
  events: [],
});

const diffFor = (path) => {
  if (path.endsWith('.png')) return { path, status: 'binary', text: null, truncated: false, shownLines: 0, totalLines: 0, redactions: 0, base: '7eb90e8' };
  const long = `  const veryLongLineInThisFile = buildSomething(first, second, third, fourth, fifth, sixth, seventh, eighth, ninth, tenth, ${path});`;
  const text = [`@@ -1,4 +1,5 @@ export function run() {`, ' const a = 1;', `-return a; // ${path}`, `+return a + 1; // ${path}`, `-${long}`, `+${long} // changed`, ...Array.from({ length: 60 }, (_, i) => ` line ${i + 1} of context`)].join('\n');
  return { path, status: 'ok', text, truncated: false, shownLines: 66, totalLines: 66, redactions: 0, base: '7eb90e8' };
};

const unlocked = await admin('POST', '/unlock', { name: 'Admin', token: SECRET });
if (!unlocked.ok) throw new Error(`could not unlock Admin: ${JSON.stringify(unlocked)}`);
await admin('PUT', '/settings', { features: { 'file-diff': true, respond: true } });
const made = await admin('POST', '/people', { name: NAME });
if (!made.token) throw new Error(`could not make ${NAME}: ${JSON.stringify(made)}. Use a fresh database.`);
console.log(`Sign in with:\n  ${NAME}  ${made.token}`);

const until = Date.now() + SECONDS * 1000;
while (Date.now() < until) {
  const r = await mod(made.token, 'POST', '/report', report());
  for (const d of r.body?.diffs ?? []) {
    console.log(`diff asked: ${d.path}`);
    await mod(made.token, 'PUT', `/sessions/demo-filediff/diffs/${d.id}`, diffFor(d.path));
  }
  await new Promise((ok) => setTimeout(ok, 700));
}
