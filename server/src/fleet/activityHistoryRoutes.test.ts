// The Activity history over HTTP (#432): the read route behind the sign-in, the sign-in with `respond` off, and the
// `history` note on the live activity reply.
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { createFleetRouter } from './routes.js';
import { Lockout } from './lockout.js';
import { createRespondBridge } from './respondBridge.js';
import { ACTIVITY_HISTORY_PAGE, ACTIVITY_HISTORY_PAGE_MAX } from './activityHistoryTypes.js';
import { MAIN_LOOP, type ActivityEntry, type Report } from './protocol.js';
import { fixtureReport } from './testing.js';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

const SECRET = 'admin-secret';
const H = { 'X-Podium-Respond': '1' };
const T0 = 1_791_648_000_000; // the fixture's sentAt, so the clock skew is zero
const SID = 'sess-ed';
const AGENT = 'a1';
const TEXT = 'UNIQUE-STORED-TEXT-4417';

async function setup(opts: { secret?: string | null; policy?: 'default' | 'after' | 'end' | 'all' } = {}) {
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  const storage = openSqliteStorage(':memory:');
  const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, () => T0, undefined, { authOn: secret !== null });
  await fleet.init();
  const people = storage.people;
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: secret, people, lockout: new Lockout(fleet.now), respondBridge: createRespondBridge(), log: () => {} }));
  closers.push(() => fleet.close());
  fleet.features.setFeature('activity-feed', true);
  if (opts.policy && opts.policy !== 'default') fleet.activityHistorySettings.set({ policy: opts.policy });
  const ed = await people.createPerson('Ed');
  const alex = await people.createPerson('Alex');
  const boss = await people.createPerson('Boss');
  await people.setGroup(boss.person.id, await people.administratorsGroupId());
  return { app, fleet, people, ed, alex, boss };
}

const entries = (n: number, from = 0): ActivityEntry[] => Array.from({ length: n }, (_, i) => ({ at: T0 - 100_000 + from + i, kind: 'tool' as const, text: `${TEXT} ${from + i}` }));

function report(main: ActivityEntry[], agent: ActivityEntry[] = []): Report {
  const r = fixtureReport();
  r.session = { ...r.session, id: SID, activityFeed: true, activity: main };
  r.userName = 'Ed';
  r.agents[0]!.activity = agent;
  return r;
}

const send = (app: express.Express, token: string, r: Report) => request(app).post('/api/fleet/report').set('X-Podium-Token', token).send(r);

async function signedIn(app: express.Express, name: string, token: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/fleet/respond/sign-in').set(H).send({ name, token });
  expect(res.status).toBe(200);
  return agent;
}

const READ = `/api/fleet/respond/sessions/${SID}/activity-history`;
const LIVE = `/api/fleet/sessions/${SID}/agents/${MAIN_LOOP}/activity`;

describe('signing in with respond off', () => {
  it('is refused while nothing is kept and no other feature needs it', async () => {
    const { app, ed } = await setup();
    const res = await request(app).post('/api/fleet/respond/sign-in').set(H).send({ name: 'Ed', token: ed.token });
    expect(res.status).toBe(403);
    expect((await request(app).get('/api/fleet/respond/me')).body).toMatchObject({ enabled: false });
  });

  it('works when a keep policy is on, though the respond flag is off', async () => {
    const { app, ed, fleet } = await setup({ policy: 'all' });
    expect(fleet.respondFlagsOn()).toBe(false);
    const a = await signedIn(app, 'Ed', ed.token);
    expect((await a.get('/api/fleet/respond/me')).body).toMatchObject({ enabled: true, signedIn: true, name: 'Ed' });
  });

  it('does not make the respond routes work: answering still needs the flags', async () => {
    const { app, ed } = await setup({ policy: 'all' });
    await send(app, ed.token, report([]));
    const a = await signedIn(app, 'Ed', ed.token);
    expect((await a.post(`/api/fleet/respond/sessions/${SID}/messages`).set(H).send({ text: 'hi' })).status).toBe(403);
  });

  it('stays closed without a token on the server, which cannot keep a policy', async () => {
    const { app } = await setup({ secret: null, policy: 'all' });
    expect((await request(app).get('/api/fleet/respond/me')).body).toMatchObject({ enabled: false });
  });
});

describe('GET /respond/sessions/:id/activity-history', () => {
  async function stored(policy: 'default' | 'after' | 'end' | 'all' = 'all') {
    const s = await setup({ policy });
    const main = entries(5);
    const agent = entries(2, 1000);
    expect((await send(s.app, s.ed.token, report(main, agent))).status).toBe(200);
    return s;
  }

  it('is 401 with no sign-in, and for a cookie from nowhere', async () => {
    const { app } = await stored();
    expect((await request(app).get(READ)).status).toBe(401);
    expect((await request(app).get(READ).set('Cookie', 'podium_respond=nope')).status).toBe(401);
  });

  it('is 404 for a session the server does not know', async () => {
    const { app, ed } = await stored();
    const a = await signedIn(app, 'Ed', ed.token);
    const res = await a.get('/api/fleet/respond/sessions/nope/activity-history');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown session');
  });

  it('is 404 under the default policy, even for the owner', async () => {
    const s = await stored('all');
    const a = await signedIn(s.app, 'Ed', s.ed.token);
    s.fleet.activityHistorySettings.set({ policy: 'default' });
    const res = await a.get(READ);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no activity is kept');
  });

  it('gives the owner the newest entries oldest first, with the counts, no-store', async () => {
    const { app, ed } = await stored();
    const a = await signedIn(app, 'Ed', ed.token);
    const res = await a.get(READ);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.entries.map((e: { text: string }) => e.text)).toEqual([0, 1, 2, 3, 4].map((i) => `${TEXT} ${i}`));
    expect(res.body).toMatchObject({ olderBefore: null, total: 5, since: T0 - 100_000, keptUntil: null });
  });

  it('gives an Administrator who is not the owner the same, and so does the admin secret', async () => {
    const { app, boss } = await stored();
    const b = await signedIn(app, 'Boss', boss.token);
    expect((await b.get(READ)).body.total).toBe(5);
    const root = await signedIn(app, 'Admin', SECRET);
    expect((await root.get(READ)).body.total).toBe(5);
  });

  it('refuses another person with 403 and names the owner', async () => {
    const { app, alex } = await stored();
    const a = await signedIn(app, 'Alex', alex.token);
    const res = await a.get(READ);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'not your session', owner: 'Ed' });
    expect(JSON.stringify(res.body)).not.toContain(TEXT);
  });

  it('reads an agent of the session, and is 404 for a loop that is neither', async () => {
    const { app, ed } = await stored();
    const a = await signedIn(app, 'Ed', ed.token);
    const agent = await a.get(`${READ}?loop=${AGENT}`);
    expect(agent.status).toBe(200);
    expect(agent.body.entries).toHaveLength(2);
    expect((await a.get(`${READ}?loop=ghost`)).status).toBe(404);
    expect((await a.get(`${READ}?loop=${AGENT}&loop=x`)).status).toBe(404);
    expect((await a.get(`${READ}?loop=${encodeURIComponent(MAIN_LOOP)}`)).body.total).toBe(5);
  });

  it('pages backward with before and limit, and clamps limit to 1..100', async () => {
    const { app, ed } = await stored();
    const a = await signedIn(app, 'Ed', ed.token);
    const first = await a.get(`${READ}?limit=2`);
    expect(first.body.entries.map((e: { text: string }) => e.text)).toEqual([`${TEXT} 3`, `${TEXT} 4`]);
    expect(first.body.olderBefore).toEqual(expect.any(Number));
    const next = await a.get(`${READ}?limit=2&before=${first.body.olderBefore}`);
    expect(next.body.entries.map((e: { text: string }) => e.text)).toEqual([`${TEXT} 1`, `${TEXT} 2`]);
    const last = await a.get(`${READ}?limit=2&before=${next.body.olderBefore}`);
    expect(last.body.entries).toHaveLength(1);
    expect(last.body.olderBefore).toBeNull();
    expect((await a.get(`${READ}?limit=0`)).body.entries).toHaveLength(1);
    expect((await a.get(`${READ}?limit=100000`)).body.entries).toHaveLength(5);
  });

  it('defaults to one window page and never returns more than the maximum', async () => {
    const s = await setup({ policy: 'all' });
    for (let i = 0; i < 7; i++) expect((await send(s.app, s.ed.token, report(entries(20, i * 20)))).status).toBe(200);
    const a = await signedIn(s.app, 'Ed', s.ed.token);
    expect((await a.get(READ)).body.entries).toHaveLength(ACTIVITY_HISTORY_PAGE);
    expect((await a.get(`${READ}?limit=${ACTIVITY_HISTORY_PAGE_MAX + 50}`)).body.entries).toHaveLength(ACTIVITY_HISTORY_PAGE_MAX);
  });

  it.each(['before=abc', 'before=-1', 'before=1.5', 'limit=abc', 'limit=-2', 'before=1&before=2'])('is 400 for %s, never 500', async (qs) => {
    const { app, ed } = await stored();
    const a = await signedIn(app, 'Ed', ed.token);
    const res = await a.get(`${READ}?${qs}`);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('reads the entries of a session that has ended', async () => {
    const { app, ed, fleet } = await stored();
    const a = await signedIn(app, 'Ed', ed.token);
    const end = report([]);
    end.events = [];
    end.session.status = 'done';
    await send(app, ed.token, end);
    expect(await fleet.db.getSession(SID)).toBeDefined();
    expect((await a.get(READ)).body.total).toBe(5);
  });
});

describe('the history note on the live activity reply', () => {
  it('is absent under the default policy: the reply is what it always was', async () => {
    const { app, ed } = await setup();
    await send(app, ed.token, report(entries(3)));
    const res = await request(app).get(LIVE);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['enabled', 'entries', 'live', 'serverTime', 'since']);
    expect(res.body).not.toHaveProperty('history');
  });

  it('is absent under a keep policy when the loop has nothing stored', async () => {
    const { app, ed } = await setup({ policy: 'all' });
    await send(app, ed.token, report([], entries(2)));
    const res = await request(app).get(LIVE);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('history');
    expect((await request(app).get(`/api/fleet/sessions/${SID}/agents/${AGENT}/activity`)).body.history).toMatchObject({ total: 2 });
  });

  it('carries counts, the owner and canRead false for anyone not signed in, with no entry text', async () => {
    const { app, ed } = await setup({ policy: 'all' });
    await send(app, ed.token, report(entries(3)));
    const res = await request(app).get(LIVE);
    expect(res.body.history).toEqual({ policy: 'all', total: 3, since: T0 - 100_000, keptUntil: null, canRead: false, owner: 'Ed' });
    expect(JSON.stringify(res.body.history)).not.toContain(TEXT);
  });

  it('keeps answering a request with a dead cookie, as for anyone', async () => {
    const { app, ed } = await setup({ policy: 'all' });
    await send(app, ed.token, report(entries(3)));
    const res = await request(app).get(LIVE).set('Cookie', 'podium_respond=nope');
    expect(res.status).toBe(200);
    expect(res.body.history.canRead).toBe(false);
  });

  it('says canRead for the owner and an Administrator, and not for another person', async () => {
    const { app, ed, alex, boss } = await setup({ policy: 'all' });
    await send(app, ed.token, report(entries(3)));
    expect((await (await signedIn(app, 'Ed', ed.token)).get(LIVE)).body.history.canRead).toBe(true);
    expect((await (await signedIn(app, 'Boss', boss.token)).get(LIVE)).body.history.canRead).toBe(true);
    const other = await (await signedIn(app, 'Alex', alex.token)).get(LIVE);
    expect(other.status).toBe(200);
    expect(other.body.history).toMatchObject({ canRead: false, owner: 'Ed' });
  });

  it('names when the newest entry goes under policy after', async () => {
    const { app, ed, fleet } = await setup();
    fleet.activityHistorySettings.set({ policy: 'after', n: 2, unit: 'days' });
    await send(app, ed.token, report(entries(3)));
    const h = (await request(app).get(LIVE)).body.history;
    expect(h.policy).toBe('after');
    expect(h.keptUntil).toBe(T0 - 100_000 + 2 + 2 * 86_400_000);
  });

  it('is unchanged for an unknown session', async () => {
    const { app } = await setup({ policy: 'all' });
    expect((await request(app).get(LIVE)).status).toBe(404);
  });
});
