#!/usr/bin/env node
// Seeds a throwaway Podium server with sessions that Claude Code compacted on its own, to look at the Comp pill (#805).
// Each session is the shared sample report (docs/fixtures/report.sample.json) under a new id, with automatic `compact` events,
// and with the sample's blowouts left in or taken out. Run with --help.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HELP = `Usage: node scripts/podium-compaction-seed.mjs --url <server> [--token <PODIUM_TOKEN>] [--keep]

Posts three sessions to a throwaway Podium server, built from docs/fixtures/report.sample.json:
  compacted-only   two automatic compactions at 22% and 25% fill, no blowout
  compacted-blown  one automatic compaction and the sample's blowouts, for the pill beside the blowout badge
  never-compacted  the sample's agents with no compaction and no blowout

Never point it at a server you use: it adds sessions.

  --url     the throwaway server, such as http://127.0.0.1:4391
  --token   its PODIUM_TOKEN, sent as X-Podium-Token
  --keep    keep reporting every 8 seconds so the sessions stay live
  -h        show this help
`;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
if (args.includes('-h') || args.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}
const url = flag('--url');
if (!url) {
  console.error('--url is required (a throwaway server, never one you use). See --help.');
  process.exit(2);
}
const token = flag('--token');
const keep = args.includes('--keep');

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(readFileSync(path.join(here, '..', 'docs', 'fixtures', 'report.sample.json'), 'utf8'));

const compact = (sid, n, percent) => ({
  id: `${sid}:main:compact:${n}`,
  t: sample.sentAt - 600_000 + n * 1000,
  kind: 'compact',
  agentId: null,
  text: `auto-compacted at ${percent}% on the orchestrator`,
  data: { trigger: 'auto', window: 1_000_000, percent, idleMs: 312_000, tokensBefore: percent * 10_000, tokensAfter: 29_000 },
});

function build(name, { compactions, blowouts }) {
  const sid = `${sample.session.id.slice(0, 24)}${name}`.slice(0, 36);
  const r = structuredClone(sample);
  r.sentAt = Date.now();
  r.session = { ...r.session, id: sid, name, startedAt: Date.now() - 3_000_000 };
  r.events = r.events
    .filter((e) => blowouts || e.kind !== 'blow')
    .map((e) => ({ ...e, id: `${sid}:${e.id.split(':').slice(1).join(':')}`, t: e.t + (r.sentAt - sample.sentAt) }));
  if (!blowouts) {
    r.session.blowouts = 0;
    for (const a of r.agents) a.blowouts = 0;
  }
  r.events.push(...compactions.map((p, i) => compact(sid, i + 1, p)).map((e) => ({ ...e, t: e.t + (r.sentAt - sample.sentAt) })));
  return r;
}

const reports = [
  build('compacted-only', { compactions: [22, 25], blowouts: false }),
  build('compacted-blown', { compactions: [22], blowouts: true }),
  build('never-compacted', { compactions: [], blowouts: false }),
];

async function post(r) {
  const res = await fetch(new URL('/api/fleet/report', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-podium-token': token } : {}) },
    body: JSON.stringify({ ...r, sentAt: Date.now() }),
  });
  if (!res.ok) throw new Error(`${r.session.name}: ${res.status} ${await res.text()}`);
}

async function round() {
  for (const r of reports) await post(r);
}

await round();
console.log(`posted ${reports.length} sessions to ${url}`);
if (keep) {
  console.log('reporting every 8 seconds; stop with Ctrl-C');
  setInterval(() => round().catch((e) => console.error(e.message)), 8000);
}
