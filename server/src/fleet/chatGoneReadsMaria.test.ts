// The Chat routes over MariaDB (#823, as #1051 checks them on PostgreSQL): an Admin's unseen read of a conversation that has since been deleted still reaches the person's overview.
// `chatRoutes.test.ts` runs on SQLite only; this runs the same sequence over the MariaDB store. Skipped without `PODIUM_TEST_MARIADB`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openMariaDbStorage } from '../storage/mariadb/index.js';
import { TEST_MARIADB, createTestDatabase, type TestDatabase } from '../storage/mariadb/testing.js';
import type { Storage } from '../storage/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { createFleetRouter } from './routes.js';
import { createLogger } from '../logging/logger.js';
import { Lockout } from './lockout.js';
import { createRespondBridge } from './respondBridge.js';
import type { Report } from './protocol.js';
import { fixtureReport } from './testing.js';
import { ACTIVITY_FEED, PEER_MESSAGING, RESPOND } from '../storage/features.js';

const SECRET = 'admin-secret-for-the-chat-tests';
const H = { 'X-Podium-Respond': '1' };
const CH = '/api/fleet/respond/chat';
const AB = `${CH}/dm/sess-dev/sess-tester`;
const ACCEPTS = ['message', 'command', 'question', 'plan-approve', 'plan-feedback', 'permission'] as const;
const MAC = { name: 'ed-mbp', id: 'macmacmac001' };
const LINUX = { name: 'ci-runner-01', id: 'lnxlnxlnx001' };

function report(sid: string, name: string, machine: { name: string; id: string }): Report {
  const r = fixtureReport();
  r.session = { ...r.session, id: sid, name, status: 'waiting', waitReason: 'input', peers: true, respond: { level: 'everything', accepts: [...ACCEPTS], limits: [] } };
  r.userName = 'Ed';
  r.machine = { ...machine, os: 'macOS 27.0.1' };
  r.adminNotices = true;
  return r;
}

describe.skipIf(!TEST_MARIADB)('Chat over MariaDB', () => {
  let td: TestDatabase;
  let storage: Storage;
  let fleet: Fleet;
  beforeAll(async () => {
    td = await createTestDatabase();
    const now = () => 1_800_000_000_000;
    storage = await openMariaDbStorage(td.url.replace(/^mariadb:\/\//, ''), now());
    fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, now);
    await fleet.init();
  });
  afterAll(async () => {
    await fleet?.close();
    await td?.drop();
  });

  it('shows a person, on their overview, the unseen record of a conversation an Admin read and that has since been deleted (#1051)', async () => {
    const app = express();
    const logger = createLogger({ format: 'json', level: 'debug', write: () => {} });
    app.use('/api/fleet', createFleetRouter(fleet, { token: SECRET, people: storage.people, reporters: storage.reporters, lockout: new Lockout(() => 1_800_000_000_000), respondBridge: createRespondBridge(), logger }));
    await fleet.features.setFeature(PEER_MESSAGING, true);
    await fleet.features.setFeature(RESPOND, true);
    await fleet.features.setFeature(ACTIVITY_FEED, true);
    const ed = await storage.people.createPerson('Ed');
    expect((await request(app).post('/api/fleet/report').set('X-Podium-Token', ed.token).send(report('sess-dev', 'dev', MAC))).status).toBe(200);
    expect((await request(app).post('/api/fleet/report').set('X-Podium-Token', ed.token).send(report('sess-tester', 'Tester', LINUX))).status).toBe(200);
    const edB = request.agent(app);
    expect((await edB.post('/api/fleet/respond/sign-in').set(H).send({ name: 'Ed', token: ed.token })).status).toBe(200);
    expect((await edB.put('/api/fleet/respond/peers/rights').set(H).send({ from: MAC.id, to: LINUX.id, level: 'send' })).status).toBe(200);
    expect((await request(app).post('/api/fleet/sessions/sess-dev/peers/messages').set('X-Podium-Token', ed.token).send({ to: 'Tester@ci-runner-01', text: 'agent hello' })).status).toBe(202);
    const admin = request.agent(app);
    expect((await admin.post('/api/fleet/respond/sign-in').set(H).send({ name: 'Admin', token: SECRET })).status).toBe(200);
    expect((await admin.get(`${AB}/messages`)).status).toBe(200);
    expect((await edB.delete(AB).set(H)).status).toBe(200);
    const sees = (await edB.get(CH)).body;
    expect(sees.goneReads).toMatchObject([{ admin: 'Admin secret', kind: 'read', with: 'dev and Tester' }]);
    expect((await edB.get(CH)).body.goneReads).toEqual([]);
  });
});
