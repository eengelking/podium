// Defects the audits of the async storage branch found (#313): a report's peer-directory note after its turn, the event stream over the
// client limit, and a recording delete whose audit write fails.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { createFleetRouter } from './routes.js';
import { Lockout } from './lockout.js';
import { createRespondBridge } from './respondBridge.js';
import { createLogger } from '../logging/logger.js';
import { PEER_MESSAGING } from '../storage/sqlite/featureFlags.js';
import { MAIN_LOOP, type Report } from './protocol.js';
import { fixtureReport } from './testing.js';

const closers: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) c();
});

const SECRET = 'admin-secret-0123456789abcdef';
const H = { 'X-Podium-Respond': '1' };
const T0 = 1_791_648_000_000; // the fixture's sentAt

async function setup(maxClients?: number) {
  const storage = openSqliteStorage(':memory:', T0);
  const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, () => T0);
  if (maxClients !== undefined) (fleet.hub as unknown as { maxClients: number }).maxClients = maxClients;
  const logger = createLogger({ format: 'json', level: 'error', write: () => {} });
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: SECRET, people: storage.people, reporters: storage.reporters, lockout: new Lockout(() => T0), respondBridge: createRespondBridge(), logger }));
  await fleet.init();
  closers.push(() => fleet.close());
  await fleet.features.setFeature(PEER_MESSAGING, true);
  await fleet.features.setFeature('session-recording', true);
  const ed = await storage.people.createPerson('Ed');
  return { storage, fleet, app, ed };
}

/** An orchestrator's report of session `sid` with the `peers` option on. */
function report(sid: string, status: Report['session']['status'] = 'running'): Report {
  const r = fixtureReport();
  r.session = { ...r.session, id: sid, name: 'dev', status, waitReason: null, peers: true };
  r.userName = 'Ed';
  r.machine = { name: 'ed-mbp', id: 'macmacmac001', os: 'macOS' };
  return r;
}

describe('a report cannot put a removed or ended session back in the peer directory', () => {
  it('not when the session is deleted while the handler is writing the reporter and person rows', async () => {
    const { storage, fleet, app, ed } = await setup();
    const touch = storage.people.touch.bind(storage.people);
    let del: Promise<boolean> | null = null;
    vi.spyOn(storage.people, 'touch').mockImplementation((...a) => {
      del ??= fleet.deleteSession('s1');
      return touch(...a);
    });
    expect((await request(app).post('/api/fleet/report').set('X-Podium-Token', ed.token).send(report('s1'))).status).toBe(200);
    await del;
    await fleet.flush();
    expect(fleet.isLive('s1')).toBe(false);
    expect(fleet.peers.messages.live('s1')).toBeNull();
  });

  it('not when a later done report ended it before an earlier running report finished', async () => {
    const { storage, fleet, app, ed } = await setup();
    const touch = storage.people.touch.bind(storage.people);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    vi.spyOn(storage.people, 'touch').mockImplementation(async (...a) => {
      if (first) {
        first = false;
        await gate; // the earlier report is held after its row was stored
      }
      return touch(...a);
    });
    const running = request(app).post('/api/fleet/report').set('X-Podium-Token', ed.token).send(report('s1')).then((r) => r);
    await vi.waitFor(async () => expect(await storage.fleet.getSession('s1')).toBeDefined());
    expect((await request(app).post('/api/fleet/report').set('X-Podium-Token', ed.token).send(report('s1', 'done'))).status).toBe(200);
    release();
    expect((await running).status).toBe(200);
    expect(fleet.peers.messages.live('s1')).toBeNull();
  });

  it('still lists a live session that reported', async () => {
    const { fleet, app, ed } = await setup();
    expect((await request(app).post('/api/fleet/report').set('X-Podium-Token', ed.token).send(report('s1'))).status).toBe(200);
    expect(fleet.peers.messages.live('s1')?.sessionId).toBe('s1');
  });
});

describe('GET /api/fleet/stream over the client limit while the lock is held', () => {
  it('answers every client past the limit with the error event and ends it', async () => {
    const { storage, app } = await setup(2);
    const srv = app.listen(0);
    closers.push(() => srv.close());
    const port = (srv.address() as AddressInfo).port;
    void storage.tx(() => new Promise<void>((r) => setTimeout(r, 150))); // a long transaction: every connect passes the full check first
    const open = () =>
      new Promise<{ body: string; ended: boolean }>((resolve) => {
        const req = http.get({ port, path: '/api/fleet/stream', agent: false }, (res) => {
          let body = '';
          let ended = false;
          res.on('data', (c) => (body += c));
          res.on('end', () => (ended = true));
          setTimeout(() => {
            req.destroy();
            resolve({ body, ended });
          }, 700);
        });
      });
    const all = await Promise.all([1, 2, 3, 4, 5].map(open));
    const refused = all.filter((c) => c.body.includes('too many clients'));
    expect(refused).toHaveLength(3);
    expect(refused.every((c) => c.ended)).toBe(true);
    expect(all.filter((c) => c.body.includes('event: snapshot'))).toHaveLength(2);
  });
});

describe('DELETE a recording when the audit write fails', () => {
  it('answers an error and leaves no unhandled rejection', async () => {
    const { storage, fleet, app, ed } = await setup();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const a = request.agent(app);
      expect((await a.post('/api/fleet/respond/sign-in').set(H).send({ name: 'Ed', token: ed.token })).status).toBe(200);
      const r = report('s1');
      r.session.sessionRecording = true;
      expect((await request(app).post('/api/fleet/report').set('X-Podium-Token', ed.token).send(r)).status).toBe(200);
      const base = '/api/fleet/respond/sessions/s1/recording';
      expect((await a.put(base).set(H).send({ loops: [MAIN_LOOP] })).status).toBe(200);
      await a.post(`${base}/stop`).set(H);
      vi.spyOn(storage.people, 'log').mockRejectedValue(new Error('log write failed'));
      const res = await a.delete(base).set(H).timeout({ deadline: 3000 });
      expect(res.status).toBe(500);
      await new Promise((r2) => setTimeout(r2, 50));
      expect(unhandled).toEqual([]);
      expect(await fleet.recordings.has('s1')).toBe(false); // the delete itself went through
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
