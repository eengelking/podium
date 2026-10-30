// Issue #42: Claude Code's daemon runs sessions nobody asked for (a parked twin of an interactive window,
// a pre-warmed spare). Each loads the reporter and reports as a session that has done nothing. They stay
// off the wall until the session has tokens, cost, an agent or a plan.
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage, type SqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet, type FleetConfig } from './fleet.js';
import { createFleetRouter } from './routes.js';
import type { Report } from './protocol.js';
import { fixtureReport } from './testing.js';

const CFG: FleetConfig = { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' };
const T0 = 1_791_648_000_000;

let clock = T0;
let db: SqliteStorage;
beforeEach(() => {
  clock = T0;
  db = openSqliteStorage(':memory:');
});

/** What the reporter sends for a session that was started and never prompted. */
function untouched(id: string): Report {
  const r = structuredClone(fixtureReport());
  r.session = {
    ...r.session,
    id,
    name: 'skills',
    status: 'waiting',
    waitReason: 'input',
    costUsd: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    context: { tokens: null, window: null, percent: null },
    blowouts: 0,
    plan: null,
  };
  r.agents = [];
  r.events = [];
  return r;
}

const ids = async (fleet: Fleet) => (await fleet.state()).sessions.map((s) => s.id);

/** A fleet over the shared storage, with what the database holds loaded. */
async function makeFleet(): Promise<Fleet> {
  const fleet = new Fleet(db, CFG, () => clock);
  await fleet.init();
  return fleet;
}

describe('sessions that have done nothing', () => {
  it('are not on the wall', async () => {
    const fleet = await makeFleet();
    for (const id of ['front-end', 'parked-job', 'spare']) await fleet.ingest(untouched(id));
    expect(await ids(fleet)).toEqual([]);
    expect((await fleet.state()).kpis.live).toBe(0);
  });

  it('appear as soon as the session has tokens', async () => {
    const fleet = await makeFleet();
    await fleet.ingest(untouched('parked-job'));
    await fleet.ingest(untouched('spare'));
    const used = untouched('parked-job');
    used.session.tokens = { input: 12, output: 36, cacheRead: 0, cacheWrite: 0 };
    used.session.costUsd = 0.1;
    await fleet.ingest(used);
    expect(await ids(fleet)).toEqual(['parked-job']);
  });

  it('appear while running, before the first token is counted', async () => {
    const fleet = await makeFleet();
    const r = untouched('first-prompt');
    r.session.status = 'running';
    r.session.waitReason = null;
    await fleet.ingest(r);
    expect(await ids(fleet)).toEqual(['first-prompt']);
  });

  it('stay off the wall after a server restart', async () => {
    const first = await makeFleet();
    await first.ingest(untouched('spare'));
    clock += 5_000;
    const restarted = await makeFleet();
    expect(await ids(restarted)).toEqual([]);
  });

  it('are not announced to a connected client', async () => {
    const fleet = await makeFleet();
    const sent: string[] = [];
    fleet.hub.add({ write: (chunk: string) => void sent.push(chunk) });
    await fleet.ingest(untouched('spare'));
    await fleet.flush();
    expect(sent.join('')).not.toContain('spare');
  });

  it('do not count as cleared when they end', async () => {
    const fleet = await makeFleet();
    await fleet.ingest(untouched('spare'));
    const end = untouched('spare');
    end.session.status = 'done';
    end.session.waitReason = null;
    end.session.endReason = 'other';
    await fleet.ingest(end);
    clock += CFG.lingerMs + 1000;
    await fleet.sweep();
    expect((await fleet.state()).clearedToday).toBe(0);
    expect(await fleet.history(T0 - 1000, T0 + 3_600_000)).toEqual([]);
  });

  it('leave a session known only from settings hooks alone, since hooks carry no usage', async () => {
    const fleet = await makeFleet();
    const res = await fleet.ingestHook({ hook_event_name: 'SessionStart', session_id: 'hook-only', cwd: '/Users/dev/skills' });
    expect(res.ok).toBe(true);
    expect(await ids(fleet)).toEqual(['hook-only']);
  });

  it('are not counted in the live number the reporter shows in its status line', async () => {
    const fleet = await makeFleet();
    const app = express();
    app.use('/api/fleet', createFleetRouter(fleet, { token: null, log: () => undefined }));
    await request(app).post('/api/fleet/report').send(untouched('spare'));
    await request(app).post('/api/fleet/report').send(untouched('parked-job'));
    const used = untouched('real');
    used.session.costUsd = 0.1;
    used.session.tokens = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
    const ack = await request(app).post('/api/fleet/report').send(used);
    expect(ack.body.liveSessions).toBe(1);
    expect((await request(app).get('/api/fleet/health')).body.liveSessions).toBe(1);
    fleet.close();
  });

  it('a card shown while the session ran is still removed when it ends with no usage', async () => {
    const fleet = await makeFleet();
    const sent: string[] = [];
    fleet.hub.add({ write: (chunk: string) => void sent.push(chunk) });
    const running = untouched('aborted');
    running.session.status = 'running';
    running.session.waitReason = null;
    await fleet.ingest(running);
    const end = untouched('aborted');
    end.session.status = 'done';
    end.session.waitReason = null;
    end.session.endReason = 'other';
    await fleet.ingest(end);
    clock += CFG.lingerMs + 1000;
    await fleet.sweep();
    await fleet.flush();
    expect(sent.join('')).toContain('event: removed');
  });
});
