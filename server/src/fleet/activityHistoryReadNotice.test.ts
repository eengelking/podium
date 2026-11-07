// An Admin paging through a person's stored Activity is recorded and the person is told (#1074, row R3 of the #1043 audit): one record per Admin, session and
// loop, one content-free Admin log line per reading session, the callout in the owner's reporter reply, and nothing for the owner, for a refused read or for a
// session nobody owns.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { createFleetRouter } from './routes.js';
import { Lockout } from './lockout.js';
import { createRespondBridge } from './respondBridge.js';
import { MAIN_LOOP, type ActivityEntry, type Report } from './protocol.js';
import { fixtureReport } from './testing.js';

const closers: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) c();
});

const SECRET = 'admin-secret';
const H = { 'X-Podium-Respond': '1' };
const T0 = 1_791_648_000_000;
const SID = 'sess-ed';
const AGENT = 'a1';
const TEXT = 'UNIQUE-STORED-TEXT-9921';
const READ = (sid = SID) => `/api/fleet/respond/sessions/${sid}/activity-history`;

const entries = (n: number): ActivityEntry[] => Array.from({ length: n }, (_, i) => ({ at: T0 - 100_000 + i, kind: 'tool' as const, text: `${TEXT} ${i}` }));

function report(sid: string, owner: string): Report {
  const r = fixtureReport();
  r.session = { ...r.session, id: sid, activityFeed: true, activity: entries(5) };
  r.userName = owner;
  r.agents[0]!.activity = entries(2);
  return r;
}

async function setup() {
  const storage = openSqliteStorage(':memory:');
  const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, () => T0, undefined, { authOn: true });
  await fleet.init();
  const people = storage.people;
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: SECRET, people, lockout: new Lockout(fleet.now), respondBridge: createRespondBridge(), log: () => {} }));
  closers.push(() => fleet.close());
  await fleet.features.setFeature('activity-feed', true);
  await fleet.activityHistorySettings.set({ policy: 'all' });
  const ed = await people.createPerson('Ed');
  const alex = await people.createPerson('Alex');
  const boss = await people.createPerson('Boss');
  await people.setGroup(boss.person.id, await people.administratorsGroupId());
  const send = (token: string, r: Report) => request(app).post('/api/fleet/report').set('X-Podium-Token', token).send(r);
  expect((await send(ed.token, report(SID, 'Ed'))).status).toBe(200);
  const agentId = (await fleet.db.getAgents(SID))[0]!.id;
  const name = (await fleet.db.getSession(SID))!.name;
  const reads = (sid = SID, loop = MAIN_LOOP) => fleet.chat.adminReads.list(`activity:${sid}:${loop}`);
  const logRows = async () => (await people.listLog({ page: 1, pageSize: 200 })).rows.filter((r) => r.kind === 'activity_admin_read');
  const notices = async () => ((await send(ed.token, report(SID, 'Ed'))).body as { adminNotices?: { text: string }[] }).adminNotices ?? [];
  return { app, fleet, people, ed, alex, boss, send, agentId, name, reads, logRows, notices };
}

async function signedIn(app: express.Express, name: string, token: string) {
  const agent = request.agent(app);
  expect((await agent.post('/api/fleet/respond/sign-in').set(H).send({ name, token })).status).toBe(200);
  return agent;
}

describe('an Admin paging through stored Activity (#1074)', () => {
  it('is one record and one Admin log line however many pages the Admin reads of a loop', async () => {
    const s = await setup();
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    const first = await boss.get(`${READ()}?limit=2`);
    expect(first.status).toBe(200);
    expect((await boss.get(`${READ()}?limit=2&before=${first.body.olderBefore}`)).status).toBe(200);
    expect(await s.reads()).toHaveLength(1);
    const rows = await s.logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toContain('Boss');
    expect(rows[0]!.detail).toContain(SID.slice(0, 8));
    expect(JSON.stringify(rows)).not.toContain(TEXT);
  });

  it('is a second record and a second log line for a second loop of the session', async () => {
    const s = await setup();
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    expect((await boss.get(READ())).status).toBe(200);
    expect((await boss.get(`${READ()}?loop=${s.agentId}`)).status).toBe(200);
    expect(await s.reads()).toHaveLength(1);
    expect(await s.reads(SID, s.agentId)).toHaveLength(1);
    expect(await s.logRows()).toHaveLength(2);
  });

  it('tells the owner in the reporter reply, naming the Admin and the session and holding no text', async () => {
    const s = await setup();
    expect(await s.notices()).toEqual([]);
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    await boss.get(READ());
    const told = await s.notices();
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toBe(`Boss (an Admin) is paging through the stored Activity of ${s.name}.`);
    expect(JSON.stringify(told)).not.toContain(TEXT);
  });

  it('records the admin secret by the name the Admin log gives it', async () => {
    const s = await setup();
    const root = await signedIn(s.app, 'Admin', SECRET);
    expect((await root.get(READ())).status).toBe(200);
    expect(await s.reads()).toHaveLength(1);
    expect((await s.logRows())[0]!.detail).toContain('Admin secret');
  });

  it('wakes open consoles with the reads counter and nothing else', async () => {
    const s = await setup();
    const changed = vi.spyOn(s.fleet, 'sessionReadsChanged');
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    await boss.get(READ());
    expect(changed).toHaveBeenCalledTimes(1);
    await boss.get(READ());
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('records nothing for the owner reading their own stored Activity', async () => {
    const s = await setup();
    const ed = await signedIn(s.app, 'Ed', s.ed.token);
    expect((await ed.get(READ())).status).toBe(200);
    expect(await s.reads()).toHaveLength(0);
    expect(await s.logRows()).toHaveLength(0);
    expect(await s.notices()).toEqual([]);
  });

  it('records nothing for an Admin reading their own session', async () => {
    const s = await setup();
    expect((await s.send(s.boss.token, report('sess-boss', 'Boss'))).status).toBe(200);
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    expect((await boss.get(READ('sess-boss'))).status).toBe(200);
    expect(await s.reads('sess-boss')).toHaveLength(0);
    expect(await s.logRows()).toHaveLength(0);
  });

  it('records nothing for a session owned by the shared Admin name', async () => {
    const s = await setup();
    expect((await s.send(SECRET, report('sess-shared', 'Someone'))).status).toBe(200);
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    expect((await boss.get(READ('sess-shared'))).status).toBe(200);
    expect(await s.reads('sess-shared')).toHaveLength(0);
    expect(await s.logRows()).toHaveLength(0);
  });

  it('records nothing for a read that is refused', async () => {
    const s = await setup();
    expect((await request(s.app).get(READ())).status).toBe(401);
    const alex = await signedIn(s.app, 'Alex', s.alex.token);
    expect((await alex.get(READ())).status).toBe(403);
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    expect((await boss.get(READ('nope'))).status).toBe(404);
    expect((await boss.get(`${READ()}?loop=nope`)).status).toBe(404);
    expect((await boss.get(`${READ()}?limit=abc`)).status).toBe(400);
    await s.fleet.activityHistorySettings.set({ policy: 'default' });
    expect((await boss.get(READ())).status).toBe(404);
    expect(await s.reads()).toHaveLength(0);
    expect(await s.logRows()).toHaveLength(0);
  });

  it('stops the read when the record cannot be made: no entry is sent', async () => {
    const s = await setup();
    vi.spyOn(s.fleet.chat.adminReads, 'noteSession').mockRejectedValue(new Error('disk full'));
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    const res = await boss.get(READ());
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(res.body)).not.toContain(TEXT);
    expect(await s.logRows()).toHaveLength(0);
  });
});
