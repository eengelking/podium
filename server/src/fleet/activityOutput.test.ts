// A Bash command's output in the Activity feed (#431), through the Fleet and its router: where output goes, and where it must not.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { activityDbPath, openActivityDb } from './activityDb.js';
import { FleetDb, openDb } from './db.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { MAIN_LOOP, type ActivityEntry, type Report } from './protocol.js';
import { createFleetRouter } from './routes.js';
import { fixtureReport } from './testing.js';
import { createLogger } from '../logging/logger.js';

const SECRET = 'sk-live-OUTPUT-SECRET-9f3a';
const DAY = 86_400_000;
const T0 = 1_791_648_000_000;
const AID = fixtureReport().agents[0]!.id;

let dir: string;
let clock: number;
let lines: string[];
let open: Fleet[];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'podium-output-'));
  clock = T0;
  lines = [];
  open = [];
});
afterEach(() => {
  for (const f of open) f.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A server on two files in `dir`, as `podium.sqlite` and `activity.sqlite` sit beside each other. */
function server(flags: { output?: boolean } = { output: true }) {
  const dbPath = path.join(dir, 'podium.sqlite');
  const logger = createLogger({ level: 'debug', format: 'json', write: (l) => lines.push(l) });
  const fleet = new Fleet(new FleetDb(openDb(dbPath)), { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath }, () => clock, logger, { db: openActivityDb(activityDbPath(dbPath)), authOn: true });
  open.push(fleet);
  if (flags.output) fleet.features.setFeature('activity-output', true);
  fleet.activityHistorySettings.set({ policy: 'after', n: 1, unit: 'days' });
  const seen: string[] = [];
  fleet.hub.add({ write: (c: string) => void seen.push(c), end: () => {} });
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: null, log: (l) => lines.push(l) }));
  const live = (agent: ActivityEntry[], opt: boolean | null = true): Report => {
    const r = fixtureReport();
    r.sentAt = clock;
    r.session.activityFeed = true;
    if (opt !== null) r.session.activityOutput = opt;
    r.agents[0]!.activity = agent;
    return r;
  };
  const send = (r: Report) => request(app).post('/api/fleet/report').send(r);
  const feed = (loop = AID) => request(app).get(`/api/fleet/sessions/${encodeURIComponent(fixtureReport().session.id)}/agents/${encodeURIComponent(loop)}/activity?every=5`);
  return { fleet, app, seen, live, send, feed, logger };
}

const bash = (at: number, extra: Partial<ActivityEntry> = {}): ActivityEntry => ({ at, kind: 'tool', text: 'Bash npm test', id: 'c1', command: 'npm test -- --run', ...extra });
const withOutput = (at: number) => bash(at, { output: `line\nTOKEN=${SECRET}\n`, done: true, exitCode: 1, failed: true });

/** Every byte of both database files and their write-ahead logs. */
function raw(): string {
  return readdirSync(dir)
    .filter((f) => f.startsWith('podium.sqlite') || f.startsWith('activity.sqlite'))
    .map((f) => readFileSync(path.join(dir, f)).toString('latin1'))
    .join('\n');
}

describe('the reply and the feed', () => {
  it('lists watchOutput as the loops under a live viewer lease, never one the history lists alone', async () => {
    const s = server();
    const r1 = await s.send(s.live([]));
    // the keep policy lists the loops for the history, with no viewer
    expect(r1.body.watch.length).toBeGreaterThan(0);
    expect(r1.body.watchOutput).toEqual([]);
    await s.feed();
    const r2 = await s.send(s.live([]));
    expect(r2.body.watchOutput).toEqual([AID]);
    expect(r2.body.watch).toEqual(expect.arrayContaining([AID, MAIN_LOOP]));
  });

  it('lists nothing while the activity-output flag is off, takes no output and serves none', async () => {
    const s = server({ output: false });
    await s.send(s.live([]));
    await s.feed();
    clock += 10;
    const r = await s.send(s.live([withOutput(clock + 1)]));
    expect(r.body.watchOutput).toEqual([]);
    const got = (await s.feed()).body;
    expect(got.entries).toHaveLength(1);
    expect(got.entries[0]).toMatchObject({ command: 'npm test -- --run' });
    expect(JSON.stringify(got)).not.toContain(SECRET);
  });

  it('serves a call as the entry it is: the command first, then its output and status on the same entry', async () => {
    const s = server();
    await s.send(s.live([]));
    await s.feed();
    clock += 10;
    await s.send(s.live([bash(clock + 1)]));
    expect((await s.feed()).body.entries).toEqual([{ seq: 1, at: clock + 1, kind: 'tool', text: 'Bash npm test', id: 'c1', command: 'npm test -- --run' }]);
    await s.send(s.live([withOutput(clock + 1)]));
    const e = (await s.feed()).body.entries;
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ seq: 1, output: `line\nTOKEN=${SECRET}\n`, done: true, exitCode: 1, failed: true });
  });

  it('an older mod (no new fields, no option) behaves exactly as before', async () => {
    const s = server();
    await s.send(s.live([], null));
    await s.feed();
    clock += 10;
    await s.send(s.live([{ at: clock + 1, kind: 'tool', text: 'Read a' }], null));
    expect((await s.feed()).body.entries).toEqual([{ seq: 1, at: clock + 1, kind: 'tool', text: 'Read a' }]);
  });

  it('drops output sent for a session whose option is off, and keeps nothing for a loop no viewer has open', async () => {
    const s = server();
    await s.send(s.live([withOutput(T0 + 1)], true));
    expect((await s.feed()).body.entries).toEqual([]);
    await s.send(s.live([withOutput(clock + 20)], false));
    expect(JSON.stringify((await s.feed()).body)).not.toContain(SECRET);
  });
});

describe('where output goes', () => {
  async function withSecret() {
    const s = server();
    await s.send(s.live([]));
    await s.feed();
    clock += 10;
    await s.send(s.live([bash(clock + 1)]));
    await s.send(s.live([withOutput(clock + 1)]));
    expect(JSON.stringify((await s.feed()).body)).toContain(SECRET);
    return s;
  }

  it('is never in the state, the stream, a log line, or either database, while the lease is live', async () => {
    const s = await withSecret();
    expect(JSON.stringify(s.fleet.state())).not.toContain(SECRET);
    expect(s.seen.join('')).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(raw()).not.toContain(SECRET);
    // the command is stored, which is why the history read has it
    expect(raw()).toContain('npm test -- --run');
    const page = s.fleet.activityHistory.page(fixtureReport().session.id, AID, null, 20).entries;
    expect(page).toEqual([expect.objectContaining({ command: 'npm test -- --run' })]);
    expect(JSON.stringify(page)).not.toContain(SECRET);
  });

  it('is gone after the lease lapses, and found in neither database after it nor after a retention purge', async () => {
    const s = await withSecret();
    clock += 60_000;
    s.fleet.activity.expire();
    expect(s.fleet.activity.watchedOutput(fixtureReport().session.id)).toEqual([]);
    expect((await s.feed()).body.entries).toEqual([]);
    expect(raw()).not.toContain(SECRET);
    clock += 2 * DAY;
    const purged = await s.fleet.activityHistory.purge(clock);
    expect(purged.entries).toBe(1);
    expect(raw()).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it('is gone when the flag goes off, with the lease still live', async () => {
    const s = await withSecret();
    s.fleet.features.setFeature('activity-output', false);
    const got = (await s.feed()).body;
    expect(got.entries).toHaveLength(1);
    expect(JSON.stringify(got)).not.toContain(SECRET);
    s.fleet.features.setFeature('activity-output', true);
    expect(JSON.stringify((await s.feed()).body)).not.toContain(SECRET);
    expect(s.seen.join('')).not.toContain(SECRET);
  });

  it('is gone when the activity-feed flag goes off, and when the session leaves the live set', async () => {
    const s = await withSecret();
    s.fleet.features.setFeature('activity-feed', false);
    expect(JSON.stringify((await s.feed()).body)).not.toContain(SECRET);
    s.fleet.features.setFeature('activity-feed', true);
    expect((await s.feed()).body.entries).toEqual([]);
    expect(s.fleet.deleteSession(fixtureReport().session.id)).toBe(true);
    expect(raw()).not.toContain(SECRET);
  });

  it('is gone in a new server instance on the same files', async () => {
    const s = await withSecret();
    s.fleet.close();
    open.length = 0;
    const again = server({});
    const got = (await again.feed()).body;
    expect(JSON.stringify(got)).not.toContain(SECRET);
    expect(got.entries).toEqual([]);
    expect(raw()).not.toContain(SECRET);
  });
});
