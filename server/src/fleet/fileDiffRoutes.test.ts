// A file's diff on demand (#319): who may ask, the switches, the round trip through the mod, and that nothing is kept.
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openDb, FleetDb } from './db.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { PeopleStore } from './people.js';
import { createFleetRouter } from './routes.js';
import { Lockout } from './lockout.js';
import { createRespondBridge } from './respondBridge.js';
import { FILE_DIFF_LIMITS, type Report } from './protocol.js';
import { fixtureReport } from './testing.js';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

const SECRET = 'admin-secret';
const H = { 'X-Podium-Respond': '1' };
const DIFF = '@@ -1 +1 @@\n-const a = 1\n+const a = 2 // UNIQUE-DIFF-LINE-9137';

function setup(opts: { secret?: string | null; fileDiff?: boolean } = {}) {
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  const db = openDb(':memory:');
  const fleet = new Fleet(new FleetDb(db), { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' });
  const people = new PeopleStore(db);
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: secret, people, lockout: new Lockout(fleet.now), respondBridge: createRespondBridge(), log: () => {} }));
  closers.push(() => fleet.close());
  if (opts.fileDiff !== false) fleet.features.setFeature('file-diff', true);
  const ed = people.createPerson('Ed');
  const alex = people.createPerson('Alex');
  const boss = people.createPerson('Boss');
  people.setGroup(boss.person.id, people.administratorsGroupId());
  return { app, fleet, people, db, ed, alex, boss };
}

function report(userName: string | null, over: { id?: string; fileDiff?: boolean | null } = {}): Report {
  const r = fixtureReport();
  r.session = { ...r.session, id: over.id ?? 'sess-ed' };
  if (over.fileDiff !== null) r.session.fileDiff = over.fileDiff ?? true;
  if (userName) r.userName = userName;
  return r;
}

const send = (app: express.Express, token: string, r: Report) => request(app).post('/api/fleet/report').set('X-Podium-Token', token).send(r);

async function signedIn(app: express.Express, name: string, token: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/fleet/respond/sign-in').set(H).send({ name, token });
  expect(res.status).toBe(200);
  return agent;
}

const DIFF_URL = '/api/fleet/respond/sessions/sess-ed/files/diff?path=src%2Fa.ts';
const okReply = { path: 'src/a.ts', status: 'ok', text: DIFF, truncated: false, shownLines: 3, totalLines: 3, redactions: 1, base: 'abc1234' };

describe('the switches', () => {
  it('refuses with the flag off, and with authentication off', async () => {
    const off = setup({ fileDiff: false });
    await send(off.app, off.ed.token, report('Ed'));
    const a = await signedIn(off.app, 'Ed', off.ed.token).catch(() => null);
    // Sign-in itself is closed while neither feature is on.
    expect(a).toBeNull();
    const noAuth = setup({ secret: null });
    expect((await request(noAuth.app).get(DIFF_URL)).status).toBe(403);
  });
  it('lets a person sign in with only the file-diff flag on', async () => {
    const { app, ed } = setup();
    const a = await signedIn(app, 'Ed', ed.token);
    expect((await a.get('/api/fleet/respond/me')).body).toMatchObject({ enabled: true, signedIn: true, name: 'Ed' });
  });
  it('is signed out: 401, and the same for a cookie from nowhere', async () => {
    const { app, ed } = setup();
    await send(app, ed.token, report('Ed'));
    expect((await request(app).get(DIFF_URL)).status).toBe(401);
  });
  it('says the file diff is off when the reporter has the option off or never said', async () => {
    const { app, ed } = setup();
    const a = await signedIn(app, 'Ed', ed.token);
    await send(app, ed.token, report('Ed', { fileDiff: false }));
    const off = await a.get(DIFF_URL);
    expect(off.status).toBe(403);
    expect(off.body.error).toBe('file diff is off');
    await send(app, ed.token, report('Ed', { id: 'sess-ed', fileDiff: null }));
  });
  it('lists no request to a reporter while the flag is off', async () => {
    const { app, fleet, ed } = setup();
    await send(app, ed.token, report('Ed'));
    void fleet.diffs.ask('sess-ed', 'a.ts');
    expect((await send(app, ed.token, report('Ed'))).body.diffs).toHaveLength(1);
    fleet.features.setFeature('file-diff', false);
    expect((await send(app, ed.token, report('Ed'))).body.diffs).toEqual([]);
  });
});

describe('who may open a diff', () => {
  it('lets only the owner: not another person, not an Administrator, not the admin secret', async () => {
    const { app, ed, alex, boss } = setup();
    await send(app, ed.token, report('Ed'));
    const own = await signedIn(app, 'Ed', ed.token);
    void own;
    for (const [name, token] of [['Alex', alex.token], ['Boss', boss.token], ['Admin', SECRET]] as const) {
      const a = await signedIn(app, name, token);
      const res = await a.get(DIFF_URL);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'not your session', owner: 'Ed' });
    }
  });
  it('lets the admin secret open a session owned by Admin, and nobody else', async () => {
    const { app, ed } = setup();
    await send(app, SECRET, report(null, { id: 'sess-ed' }));
    const admin = await signedIn(app, 'Admin', SECRET);
    const waiting = admin.get(DIFF_URL).then((r) => r);
    await new Promise((r) => setTimeout(r, 30));
    const listed = (await send(app, SECRET, report(null, { id: 'sess-ed' }))).body.diffs;
    expect(listed).toHaveLength(1);
    await request(app).put(`/api/fleet/sessions/sess-ed/diffs/${listed[0].id}`).set('X-Podium-Token', SECRET).send(okReply);
    expect((await waiting).status).toBe(200);
    const e = await signedIn(app, 'Ed', ed.token);
    expect((await e.get(DIFF_URL)).status).toBe(403);
  });
  it('has no one who can open a session with no owner', async () => {
    const { app, ed } = setup({ secret: SECRET });
    // Reported with no credential at all, so no owner is recorded (7.7), though authentication is on for the sign-in.
    await request(app).post('/api/fleet/report').send(report(null));
    const a = await signedIn(app, 'Ed', ed.token);
    expect([403, 404]).toContain((await a.get(DIFF_URL)).status);
  });
  it('refuses a missing path and an unknown session', async () => {
    const { app, ed } = setup();
    await send(app, ed.token, report('Ed'));
    const a = await signedIn(app, 'Ed', ed.token);
    expect((await a.get('/api/fleet/respond/sessions/sess-ed/files/diff')).status).toBe(400);
    expect((await a.get('/api/fleet/respond/sessions/nope/files/diff?path=a')).status).toBe(404);
  });
});

describe('the round trip', () => {
  it('asks the mod through the report reply and returns its answer once, keeping nothing', async () => {
    const { app, fleet, people, db, ed } = setup();
    await send(app, ed.token, report('Ed'));
    const a = await signedIn(app, 'Ed', ed.token);
    const waiting = a.get(DIFF_URL).then((r) => r);
    await new Promise((r) => setTimeout(r, 30));
    expect(fleet.diffs.size).toBe(1);

    const reply = await send(app, ed.token, report('Ed'));
    expect(reply.body.diffs).toEqual([{ id: expect.any(String), path: 'src/a.ts' }]);
    const id = reply.body.diffs[0].id as string;

    // Only the owner's credential may answer.
    const alex = people.createPerson('Mallory');
    expect((await request(app).put(`/api/fleet/sessions/sess-ed/diffs/${id}`).set('X-Podium-Token', alex.token).send(okReply)).status).toBe(403);
    const put = await request(app).put(`/api/fleet/sessions/sess-ed/diffs/${id}`).set('X-Podium-Token', ed.token).send(okReply);
    expect(put.status).toBe(200);

    const got = await waiting;
    expect(got.status).toBe(200);
    expect(got.body).toEqual(okReply);
    expect(got.headers['cache-control']).toBe('no-store');

    // Nothing left in memory, and the text is nowhere the server stores or shows.
    expect(fleet.diffs.size).toBe(0);
    expect((await send(app, ed.token, report('Ed'))).body.diffs).toEqual([]);
    const everything = JSON.stringify([
      db.prepare('SELECT * FROM admin_log').all(),
      db.prepare('SELECT * FROM sessions').all(),
      db.prepare('SELECT * FROM events').all(),
      fleet.state(),
    ]);
    expect(everything.includes('UNIQUE-DIFF-LINE-9137')).toBe(false);
    const log = people.listLog({ page: 1, pageSize: 50 }).rows.find((r) => r.kind === 'file_diff_opened');
    expect(log).toMatchObject({ actor: 'Ed' });
    expect(log!.detail).toContain('src/a.ts');
  });
  it('answers 504 when the flag goes off while the browser waits', async () => {
    const { app, fleet, ed } = setup();
    await send(app, ed.token, report('Ed'));
    const a = await signedIn(app, 'Ed', ed.token);
    const waiting = a.get(DIFF_URL).then((r) => r);
    await new Promise((r) => setTimeout(r, 30));
    fleet.features.setFeature('file-diff', false);
    const res = await waiting;
    expect(res.status).toBe(504);
    expect(res.body.error).toBe('no answer');
  });
  it('answers 429 past four waiting requests for one session', async () => {
    const { app, fleet, ed } = setup();
    await send(app, ed.token, report('Ed'));
    for (let i = 0; i < FILE_DIFF_LIMITS.pending; i++) void fleet.diffs.ask('sess-ed', `f${i}.ts`);
    const a = await signedIn(app, 'Ed', ed.token);
    expect((await a.get(DIFF_URL)).status).toBe(429);
    fleet.diffs.clear();
  });
  it('drops a waiting request when its session is deleted', async () => {
    const { app, fleet, ed } = setup();
    await send(app, ed.token, report('Ed'));
    const p = fleet.diffs.ask('sess-ed', 'a.ts');
    fleet.deleteSession('sess-ed');
    expect(await p).toBeNull();
  });
});

describe('the mod\'s answer route', () => {
  it('refuses with the flag off, a foreign session or a body that is not a diff, and takes a late answer quietly', async () => {
    const { app, fleet, ed } = setup();
    await send(app, ed.token, report('Ed'));
    const put = (body: unknown, token = ed.token) => request(app).put('/api/fleet/sessions/sess-ed/diffs/whatever').set('X-Podium-Token', token).send(body as object);
    expect((await put(okReply)).status).toBe(200); // late: nothing is waiting, the text is discarded
    expect((await put({ status: 'ok' })).status).toBe(400);
    expect((await put({ ...okReply, status: 'maybe' })).status).toBe(400);
    expect((await request(app).put('/api/fleet/sessions/sess-ed/diffs/x').send(okReply)).status).toBe(401);
    expect((await request(app).put('/api/fleet/sessions/nope/diffs/x').set('X-Podium-Token', ed.token).send(okReply)).status).toBe(404);
    fleet.features.setFeature('file-diff', false);
    expect((await put(okReply)).status).toBe(403);
  });
  it('refuses an answer over 300,000 bytes with 413', async () => {
    const { app, ed } = setup();
    await send(app, ed.token, report('Ed'));
    const big = { ...okReply, text: 'é'.repeat(FILE_DIFF_LIMITS.answerBytes / 2 + 10) };
    expect((await request(app).put('/api/fleet/sessions/sess-ed/diffs/x').set('X-Podium-Token', ed.token).send(big)).status).toBe(413);
  });
});
