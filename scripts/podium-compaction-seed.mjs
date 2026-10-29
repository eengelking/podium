#!/usr/bin/env node
// Seeds a throwaway Podium server with sessions that Claude Code compacted on its own, to look at the Comp pill (#805).
// Each session is the shared sample report (docs/fixtures/report.sample.json) under a new id, with automatic `compact` events,
// and with the sample's blowouts left in or taken out. Run with --help.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const HELP = `Usage: node scripts/podium-compaction-seed.mjs --url <server> [--token <PODIUM_TOKEN>] [--keep]

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

const here = path.dirname(fileURLToPath(import.meta.url));

export const loadSample = () => JSON.parse(readFileSync(path.join(here, '..', 'docs', 'fixtures', 'report.sample.json'), 'utf8'));

const compact = (sample, sid, n, percent) => ({
  id: `${sid}:main:compact:${n}`,
  t: sample.sentAt - 600_000 + n * 1000,
  kind: 'compact',
  agentId: null,
  text: `auto-compacted at ${percent}% on the orchestrator`,
  data: { trigger: 'auto', window: 1_000_000, percent, idleMs: 312_000, tokensBefore: percent * 10_000, tokensAfter: 29_000 },
});

/** One session from the sample: `compactions` are the fill percents of its automatic compactions, `blowouts` keeps the sample's. */
export function build(sample, name, { compactions, blowouts }, now) {
  const sid = `${sample.session.id.slice(0, 24)}${name}`.slice(0, 36);
  const shift = now - sample.sentAt;
  const r = structuredClone(sample);
  r.sentAt = now;
  r.session = { ...r.session, id: sid, name, startedAt: now - 3_000_000 };
  r.events = r.events
    .filter((e) => blowouts || e.kind !== 'blow')
    .map((e) => ({ ...e, id: `${sid}:${e.id.split(':').slice(1).join(':')}`, t: e.t + shift }));
  if (!blowouts) {
    r.session.blowouts = 0;
    for (const a of r.agents) a.blowouts = 0;
  }
  r.events.push(...compactions.map((p, i) => compact(sample, sid, i + 1, p)).map((e) => ({ ...e, t: e.t + shift })));
  return r;
}

export function buildAll(sample, now) {
  return [
    build(sample, 'compacted-only', { compactions: [22, 25], blowouts: false }, now),
    build(sample, 'compacted-blown', { compactions: [22], blowouts: true }, now),
    build(sample, 'never-compacted', { compactions: [], blowouts: false }, now),
  ];
}

/** Runs the script. `io` stands in for the clock, the network, the output and the timer, so a test can drive it. */
export async function main(args, io = {}) {
  const { log = console.log, error = console.error, fetchFn = fetch, now = Date.now, every = setInterval } = io;
  if (args.includes('-h') || args.includes('--help')) {
    log(HELP);
    return 0;
  }
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : (args[i + 1] ?? null);
  };
  const url = flag('--url');
  if (!url) {
    error('--url is required (a throwaway server, never one you use). See --help.');
    return 2;
  }
  const token = flag('--token');
  const reports = buildAll(loadSample(), now());

  const post = async (r) => {
    const res = await fetchFn(new URL('/api/fleet/report', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-podium-token': token } : {}) },
      body: JSON.stringify({ ...r, sentAt: now() }),
    });
    if (!res.ok) throw new Error(`${r.session.name}: ${res.status} ${await res.text()}`);
  };
  const round = async () => {
    for (const r of reports) await post(r);
  };

  await round();
  log(`posted ${reports.length} sessions to ${url}`);
  if (args.includes('--keep')) {
    log('reporting every 8 seconds; stop with Ctrl-C');
    every(() => round().catch((e) => error(e.message)), 8000);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2));
  if (code) process.exitCode = code;
}
