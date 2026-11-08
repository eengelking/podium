// An Admin reading the content of a person's session is recorded and the person is told (#1073, #1074): the thread each kind is recorded under, the record
// before the read, who is told and who is not, the callout in the person's reporter reply, the console's live readers and record, and that nothing carries text.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { createFleetRouter } from './routes.js';
import { Lockout } from './lockout.js';
import { createRespondBridge } from './respondBridge.js';
import { MAIN_LOOP, type Report } from './protocol.js';
import { fixtureReport } from './testing.js';
import { loggerFromLine } from '../logging/logger.js';
import { AdminReads, LIVE_MS, SESSION_GAP_MS } from './chatAdminReads.js';
import { isSessionReadKind, parseSessionThread, readNeedsLoop, sessionThread, sessionThreadPrefix } from './sessionReads.js';
import { ADMIN_OWNER } from '../storage/rows.js';

const closers: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) c();
});

const SECRET = 'admin-secret-0123456789abcdef';
const H = { 'X-Podium-Respond': '1' };
const T0 = 1_791_648_000_000;
const SID = 'sess-ed';
const BASE = `/api/fleet/respond/sessions/${SID}/admin-reads`;

async function setup() {
  const storage = openSqliteStorage(':memory:');
  const clock = { now: T0 };
  const logger = loggerFromLine(() => undefined);
  const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, () => clock.now, logger, { authOn: true, secret: SECRET });
  const people = storage.people;
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: SECRET, people, lockout: new Lockout(fleet.now), respondBridge: createRespondBridge(), logger }));
  await fleet.init();
  closers.push(() => fleet.close());
  // A browser signs in only while a feature that needs the sign-in is on.
  await fleet.features.setFeature('session-recording', true);
  const ed = await people.createPerson('Ed');
  const alex = await people.createPerson('Alex');
  const boss = await people.createPerson('Boss');
  await people.setGroup(boss.person.id, await people.administratorsGroupId());
  const r: Report = fixtureReport();
  r.session = { ...r.session, id: SID };
  r.userName = 'Ed';
  expect((await request(app).post('/api/fleet/report').set('X-Podium-Token', ed.token).send(r)).status).toBe(200);
  const name = (await fleet.db.getSession(SID))!.name;
  const report = async () => (await request(app).post('/api/fleet/report').set('X-Podium-Token', ed.token).send(r)).body as { adminNotices?: { id: string; text: string }[] };
  return { app, fleet, people, clock, ed, alex, boss, name, report };
}

async function signedIn(app: express.Express, name: string, token: string) {
  const agent = request.agent(app);
  expect((await agent.post('/api/fleet/respond/sign-in').set(H).send({ name, token })).status).toBe(200);
  return agent;
}

describe('the thread of a session read', () => {
  it('names an ask by its session and an activity read by its session and loop, and reads them back', () => {
    expect(sessionThread('ask', 's1')).toBe('ask:s1');
    expect(sessionThread('activity', 's1', MAIN_LOOP)).toBe(`activity:s1:${MAIN_LOOP}`);
    expect(sessionThreadPrefix('activity', 's1')).toBe('activity:s1:');
    expect(parseSessionThread('ask:s1')).toEqual({ kind: 'ask', sessionId: 's1', loop: null });
    expect(parseSessionThread('activity:s:1:a1')).toEqual({ kind: 'activity', sessionId: 's:1', loop: 'a1' });
    for (const bad of ['group:ed', 'dm:a|b', 'list:ed', 'ask:', 'activity:s1', 'activity:s1:', 'activity::a1', ':x', 'replay:s1', '']) expect(parseSessionThread(bad)).toBeNull();
    expect(readNeedsLoop('activity')).toBe(true);
    expect(readNeedsLoop('ask')).toBe(false);
    expect(isSessionReadKind('ask')).toBe(true);
    expect(isSessionReadKind('toString')).toBe(false);
    expect(isSessionReadKind(3)).toBe(false);
  });
});

describe('noteSession', () => {
  it('records and tells for an Admin reading someone else\'s session, and for nobody else', async () => {
    const { fleet, name, boss, alex } = await setup();
    const reads = fleet.chat.adminReads;
    const viewer = (n: string, admin: boolean) => ({ name: n, actor: n, admin, personId: 1 });
    const s = { id: SID, name, owner: 'Ed' };
    expect(await reads.noteSession(viewer('Alex', false), 'ask', s)).toEqual({ told: false, changed: false });
    expect(await reads.noteSession(viewer('Ed', true), 'ask', s)).toEqual({ told: false, changed: false });
    expect(await reads.noteSession(viewer('Boss', true), 'ask', { ...s, owner: null })).toEqual({ told: false, changed: false });
    expect(await reads.noteSession(viewer('Boss', true), 'ask', { ...s, owner: ADMIN_OWNER })).toEqual({ told: false, changed: false });
    expect(await reads.list(`ask:${SID}`)).toEqual([]);
    expect(await reads.noteSession(viewer('Boss', true), 'ask', s)).toEqual({ told: true, changed: true });
    expect(await reads.noteSession(viewer('Boss', true), 'ask', s)).toEqual({ told: true, changed: false });
    expect(await reads.noteSession(viewer('Boss', true), 'ask', s)).toEqual({ told: true, changed: false });
    expect((await reads.list(`ask:${SID}`)).map((r) => r.admin)).toEqual(['Boss']);
    expect(boss.person.name).toBe('Boss');
    expect(alex.person.name).toBe('Alex');
  });

  it('needs a loop for an activity read and refuses a note of a chat thread', async () => {
    const { fleet, name } = await setup();
    const boss = { name: 'Boss', actor: 'Boss', admin: true, personId: 1 };
    await expect(fleet.chat.adminReads.noteSession(boss, 'activity', { id: SID, name, owner: 'Ed' })).rejects.toThrow('needs a loop id');
    await expect(fleet.chat.adminReads.noteSession(boss, 'activity', { id: SID, name, owner: 'Ed' }, 'a:b')).rejects.toThrow('needs a loop id');
    await expect(fleet.chat.adminReads.note(boss, { scope: 'session', thread: 'ask:x', owners: ['ed'], phrase: 'x' })).rejects.toThrow('noteSession');
    expect(await fleet.chat.adminReads.list(`activity:${SID}:`)).toEqual([]);
  });

  it('does not read anything when the record cannot be written', async () => {
    const { fleet, name } = await setup();
    vi.spyOn(AdminReads.prototype as unknown as { store: unknown }, 'store', 'get').mockReturnValue({ touch: () => Promise.reject(new Error('disk full')) });
    await expect(fleet.chat.adminReads.noteSession({ name: 'Boss', actor: 'Boss', admin: true, personId: 1 }, 'ask', { id: SID, name, owner: 'Ed' })).rejects.toThrow('disk full');
  });
});

describe('the person is told', () => {
  it('in the reporter reply and on the console while an Admin reads, then by a record line', async () => {
    const { app, fleet, clock, ed, boss, name, report } = await setup();
    const changed = vi.spyOn(fleet, 'sessionReadsChanged');
    const b = await signedIn(app, 'Boss', boss.token);
    const e = await signedIn(app, 'Ed', ed.token);
    expect((await report()).adminNotices).toBeUndefined();
    expect((await b.post(`${BASE}/ask/reading`).set(H).send({})).body).toEqual({ ok: true });
    expect(changed).toHaveBeenCalledTimes(1);
    // the reporter callout names the Admin and the session, and nothing else
    const told = (await report()).adminNotices ?? [];
    expect(told.map((n) => n.text)).toEqual([`Boss (an Admin) is reading your waiting plan, question or tool request on ${name}.`]);
    // the console's live readers: the owner sees the Admin, the Admin sees nothing of Ed's
    const live = await e.get('/api/fleet/respond/session-reads').set(H);
    expect(live.body.readers.ask[SID]).toEqual([{ admin: 'Boss', since: T0, until: T0 + LIVE_MS }]);
    expect((await b.get('/api/fleet/respond/session-reads')).body.readers).toEqual({});
    // a ping keeps it live and wakes no console (the owner's re-reads when its end passes); a quiet interval ends it
    clock.now += 20_000;
    await b.post(`${BASE}/ask/reading`).set(H).send({});
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await e.get('/api/fleet/respond/session-reads')).body.readers.ask[SID]).toEqual([{ admin: 'Boss', since: T0, until: T0 + 20_000 + LIVE_MS }]);
    clock.now += 40_000;
    expect((await e.get('/api/fleet/respond/session-reads')).body.readers).toEqual({});
    // the record stays for the owner, with who and when, and loading it is seeing it
    const rec = await e.get(`${BASE}/ask`);
    expect(rec.body.adminReads).toEqual([{ admin: 'Boss', startedAt: T0, lastSeenAt: T0 + 20_000, kind: 'read' }]);
    expect(rec.body.adminReading).toEqual([]);
    expect(JSON.stringify(rec.body)).not.toMatch(/text|plan/i);
    expect(await fleet.chat.adminReads.unseenFor('Ed')).toEqual([]);
  });

  it('is still told after the server forgot what it knew, from the stored session', async () => {
    const { app, fleet, boss, name, report } = await setup();
    const b = await signedIn(app, 'Boss', boss.token);
    await b.post(`${BASE}/ask/reading`).set(H).send({});
    (fleet.chat.adminReads as unknown as { known: Map<string, unknown> }).known.clear();
    expect(((await report()).adminNotices ?? []).map((n) => n.text)).toEqual([`Boss (an Admin) is reading your waiting plan, question or tool request on ${name}.`]);
  });

  it('keeps a read less than 30 minutes after the last as one record and starts another after', async () => {
    const { app, clock, ed, boss } = await setup();
    const b = await signedIn(app, 'Boss', boss.token);
    const e = await signedIn(app, 'Ed', ed.token);
    await b.post(`${BASE}/ask/reading`).set(H).send({});
    clock.now += SESSION_GAP_MS - 1000;
    await b.post(`${BASE}/ask/reading`).set(H).send({});
    expect((await e.get(`${BASE}/ask`)).body.adminReads).toHaveLength(1);
    clock.now += SESSION_GAP_MS + 1000;
    await b.post(`${BASE}/ask/reading`).set(H).send({});
    expect((await e.get(`${BASE}/ask`)).body.adminReads).toHaveLength(2);
  });

  it('takes any loop id the protocol allows (up to 200 characters, no colon or space), and refuses the rest', async () => {
    const { app, fleet, ed, boss } = await setup();
    const b = await signedIn(app, 'Boss', boss.token);
    const odd = `toolu_01/a+b${'x'.repeat(150)}`;
    const r: Report = fixtureReport();
    r.session = { ...r.session, id: SID };
    r.userName = 'Ed';
    r.agents = [...r.agents, { ...r.agents[0]!, id: odd }];
    expect((await request(app).post('/api/fleet/report').set('X-Podium-Token', ed.token).send(r)).status).toBe(200);
    expect((await b.post(`${BASE}/activity/reading`).set(H).send({ loop: odd })).status).toBe(200);
    expect((await fleet.chat.adminReads.list(`activity:${SID}:${odd}`)).map((r) => r.admin)).toEqual(['Boss']);
    expect((await b.post(`${BASE}/activity/reading`).set(H).send({ loop: 'x'.repeat(201) })).status).toBe(400);
    expect((await b.post(`${BASE}/activity/reading`).set(H).send({ loop: 'a b' })).status).toBe(400);
  });

  it('tells for each loop of the Activity read, as one reader of the session, with every loop in the record', async () => {
    const { app, fleet, ed, boss, name, report } = await setup();
    const b = await signedIn(app, 'Boss', boss.token);
    const e = await signedIn(app, 'Ed', ed.token);
    expect((await b.post(`${BASE}/activity/reading`).set(H).send({})).status).toBe(400);
    expect((await b.post(`${BASE}/activity/reading`).set(H).send({ loop: 'a:b' })).status).toBe(400);
    expect((await b.post(`${BASE}/ask/reading`).set(H).send({ loop: 'a1' })).status).toBe(400);
    expect((await b.post(`${BASE}/activity/reading`).set(H).send({ loop: MAIN_LOOP })).status).toBe(200);
    expect((await b.post(`${BASE}/activity/reading`).set(H).send({ loop: 'a1' })).status).toBe(200);
    // a loop the session does not have is refused and leaves no record and no notice
    expect((await b.post(`${BASE}/activity/reading`).set(H).send({ loop: 'ghost' })).status).toBe(404);
    expect(await fleet.chat.adminReads.list(`activity:${SID}:ghost`)).toEqual([]);
    expect((await fleet.chat.adminReads.list(`activity:${SID}:a1`)).map((r) => r.admin)).toEqual(['Boss']);
    const texts = ((await report()).adminNotices ?? []).map((n) => n.text);
    expect(texts).toEqual([`Boss (an Admin) is paging through the stored Activity of ${name}.`, `Boss (an Admin) is paging through the stored Activity of ${name}.`]);
    expect(new Set(((await report()).adminNotices ?? []).map((n) => n.id)).size).toBe(2);
    expect((await e.get('/api/fleet/respond/session-reads')).body.readers.activity[SID]).toHaveLength(1);
    expect((await e.get(`${BASE}/activity`)).body.adminReads).toHaveLength(2);
    expect((await e.get(`${BASE}/ask`)).body.adminReads).toEqual([]);
  });
});

describe('who may use the routes', () => {
  it('refuses a person who is not an Admin to ping, and an Admin to read the record of another person\'s session', async () => {
    const { app, ed, alex, boss, fleet } = await setup();
    const a = await signedIn(app, 'Alex', alex.token);
    const e = await signedIn(app, 'Ed', ed.token);
    const b = await signedIn(app, 'Boss', boss.token);
    expect((await a.post(`${BASE}/ask/reading`).set(H).send({})).status).toBe(403);
    expect((await e.post(`${BASE}/ask/reading`).set(H).send({})).status).toBe(403);
    expect((await a.get(`${BASE}/ask`)).status).toBe(403);
    expect((await b.get(`${BASE}/ask`)).status).toBe(403);
    expect(await fleet.chat.adminReads.list(`ask:${SID}`)).toEqual([]);
  });

  it('answers 401 without a sign-in, 400 for an unknown kind and 404 for an unknown session', async () => {
    const { app, boss, ed } = await setup();
    expect((await request(app).get('/api/fleet/respond/session-reads')).status).toBe(401);
    expect((await request(app).get(`${BASE}/ask`)).status).toBe(401);
    expect((await request(app).post(`${BASE}/ask/reading`).set(H).send({})).status).toBe(401);
    const b = await signedIn(app, 'Boss', boss.token);
    const e = await signedIn(app, 'Ed', ed.token);
    expect((await b.post(`${BASE}/replay/reading`).set(H).send({})).status).toBe(400);
    expect((await e.get(`${BASE}/replay`)).status).toBe(400);
    expect((await b.post('/api/fleet/respond/sessions/nope/admin-reads/ask/reading').set(H).send({})).status).toBe(404);
    expect((await e.get('/api/fleet/respond/sessions/nope/admin-reads/ask')).status).toBe(404);
  });

  it('answers 404 when authentication is off', async () => {
    const storage = openSqliteStorage(':memory:');
    const logger = loggerFromLine(() => undefined);
    const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, () => T0, logger, { authOn: false, secret: null });
    const app = express();
    app.use('/api/fleet', createFleetRouter(fleet, { token: null, people: storage.people, lockout: new Lockout(fleet.now), respondBridge: createRespondBridge(), logger }));
    await fleet.init();
    closers.push(() => fleet.close());
    expect((await request(app).get('/api/fleet/respond/session-reads').set(H)).status).toBe(404);
    expect((await request(app).get(`${BASE}/ask`).set(H)).status).toBe(404);
    expect((await request(app).post(`${BASE}/ask/reading`).set(H).send({})).status).toBe(404);
  });
});
