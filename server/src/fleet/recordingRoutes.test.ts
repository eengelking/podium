// Session recording over HTTP (#353): the consent in the report's reply, the mod's batch route, the browser's routes behind the
// sign-in, the Admin log, and that a recording's text never reaches a log line.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import type { PeopleStoreApi } from '../storage/types.js';
import { createFleetRouter } from './routes.js';
import { Lockout } from './lockout.js';
import { createRespondBridge } from './respondBridge.js';
import { MAIN_LOOP, RECORDING_LIMITS, type RecordingBatch, type RecordingEntry, type Report } from './protocol.js';
import { fixtureReport } from './testing.js';
import { loggerFromLine } from '../logging/logger.js';

const closers: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) c();
});

const SECRET = 'admin-secret-0123456789abcdef';
const H = { 'X-Podium-Respond': '1' };
const T0 = 1_791_648_000_000; // the fixture's sentAt, so the clock skew is zero
const SID = 'sess-ed';
const BODY = 'UNIQUE-RECORDED-TEXT-7731';
/** What the reporter says it takes from Podium, so a message can be sent to it. */
const ACCEPTS = { level: 'everything', accepts: ['message'], limits: [] } as unknown as Report['session']['respond'];

async function setup(opts: { secret?: string | null; flag?: boolean } = {}) {
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  const storage = openSqliteStorage(':memory:');
  const db = storage.sqliteHandle;
  const clock = { now: T0 };
  const lines: string[] = [];
  const logger = loggerFromLine((l) => lines.push(l));
  const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, () => clock.now, logger, { authOn: secret !== null, secret });
  const people = storage.people;
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: secret, people, lockout: new Lockout(fleet.now), respondBridge: createRespondBridge(), logger }));
  await fleet.init();
  closers.push(() => fleet.close());
  if (opts.flag !== false) await fleet.features.setFeature('session-recording', true);
  const ed = await people.createPerson('Ed');
  const alex = await people.createPerson('Alex');
  const boss = await people.createPerson('Boss');
  await people.setGroup(boss.person.id, await people.administratorsGroupId());
  return { app, fleet, people, clock, lines, ed, alex, boss };
}

/** A report of Ed's session. `optionOn` is the reporter's sessionRecording option; null leaves it out, as an older reporter does. */
function report(optionOn: boolean | null = true, over: Partial<Report['session']> = {}): Report {
  const r = fixtureReport();
  r.session = { ...r.session, id: SID, ...(optionOn === null ? {} : { sessionRecording: optionOn }), ...over };
  r.userName = 'Ed';
  return r;
}

const send = (app: express.Express, token: string, r: Report) => request(app).post('/api/fleet/report').set('X-Podium-Token', token).send(r);

async function signedIn(app: express.Express, name: string, token: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/fleet/respond/sign-in').set(H).send({ name, token });
  expect(res.status).toBe(200);
  return agent;
}

const entry = (loop: string, seq: number, text = `${BODY} ${seq}`, extra: Partial<RecordingEntry> = {}): RecordingEntry => ({ loop, seq, at: T0 + seq, kind: 'tool', text, ...extra });
const batch = (...entries: RecordingEntry[]): RecordingBatch => ({ v: 1, sentAt: T0, entries });
const BASE = `/api/fleet/respond/sessions/${SID}/recording`;
const MOD = `/api/fleet/sessions/${SID}/recording`;
const post = (app: express.Express, token: string, b: unknown) => request(app).post(MOD).set('X-Podium-Token', token).send(b as object);

/** A live session of Ed's whose reporter allows recording, with Ed's browser signed in and the orchestrator and a1 chosen. */
async function chosen(over: Parameters<typeof setup>[0] = {}, loops = [MAIN_LOOP, 'a1']) {
  const s = await setup(over);
  expect((await send(s.app, s.ed.token, report())).status).toBe(200);
  const a = await signedIn(s.app, 'Ed', s.ed.token);
  expect((await a.put(BASE).set(H).send({ loops })).status).toBe(200);
  return { ...s, a };
}

const logRows = async (people: PeopleStoreApi) => (await people.listLog({ page: 1, pageSize: 100 })).rows;
const kinds = async (people: PeopleStoreApi) => (await logRows(people)).map((r) => r.kind);

describe('the report reply carries the consent', () => {
  it('says off, with the Admin answer, while the flag is off', async () => {
    const { app, ed } = await setup({ flag: false });
    const res = await send(app, ed.token, report());
    expect(res.body.recording).toMatchObject({ state: 'off', consent: { admin: false, chosen: false, owner: true }, loops: [] });
  });

  it('says off when the flag is on and no one has chosen, and shows whether the owner allows it', async () => {
    const { app, ed } = await setup();
    expect((await send(app, ed.token, report(true))).body.recording.consent).toEqual({ admin: true, chosen: false, owner: true });
    expect((await send(app, ed.token, report(null))).body.recording.consent.owner).toBe(false);
  });

  it('says recording with the three answers once the owner or an Admin chose and the reporter allows it', async () => {
    const { app, ed, a } = await chosen();
    const res = await send(app, ed.token, report());
    expect(res.body.recording).toMatchObject({ state: 'recording', consent: { admin: true, chosen: true, owner: true }, loops: [MAIN_LOOP, 'a1'], startedBy: 'Ed', startedAt: T0 });
    // the reporter's option is off: chosen, but nothing is captured, and the reply says why
    expect((await send(app, ed.token, report(false))).body.recording).toMatchObject({ state: 'recording', consent: { chosen: true, owner: false } });
    expect((await a.post(`${BASE}/stop`).set(H)).status).toBe(200);
    expect((await send(app, ed.token, report())).body.recording).toMatchObject({ state: 'stopped', consent: { chosen: false }, loops: [], stoppedBy: 'Ed' });
  });

  it('says off to a server with no token, whatever the flag says', async () => {
    const { app } = await setup({ secret: null });
    const res = await request(app).post('/api/fleet/report').send(report());
    expect(res.body.recording).toMatchObject({ state: 'off', consent: { admin: false } });
  });
});

describe('POST /sessions/:id/recording (the mod)', () => {
  it('stores a batch, answers with the count and the grant, and drops a resend', async () => {
    const { app, ed, fleet } = await chosen();
    const b = batch(entry(MAIN_LOOP, 1), entry(MAIN_LOOP, 2), entry('a1', 1), entry('a2', 1, 'a loop nobody chose'));
    const res = await post(app, ed.token, b);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, stored: 3, recording: { state: 'recording', loops: [MAIN_LOOP, 'a1'] } });
    expect(res.body.recording.bytes).toBeGreaterThan(0);
    expect((await post(app, ed.token, b)).body.stored).toBe(0);
    expect(fleet.recordings.page(SID, null, 10, null).total).toBe(3);
  });

  it('is 401 without a credential, 400 for a body that fails validation, 413 above the body limit', async () => {
    const { app, ed } = await chosen();
    expect((await request(app).post(MOD).send(batch(entry(MAIN_LOOP, 1)))).status).toBe(401);
    const bad = await post(app, ed.token, { v: 1, sentAt: T0, entries: [{ loop: MAIN_LOOP, seq: 0, at: 1, kind: 'tool', text: 'x' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.path).toBe('$.entries[0].seq');
    expect((await post(app, ed.token, batch(entry(MAIN_LOOP, 1, 'x', { kind: 'stopped' })))).status).toBe(400);
    const big = 'y'.repeat(RECORDING_LIMITS.text);
    expect((await post(app, ed.token, batch(...Array.from({ length: 6 }, (_, i) => entry(MAIN_LOOP, i + 1, big))))).status).toBe(413);
  });

  it('is 403 "recording is off" while the flag is off, with nothing stored', async () => {
    const { app, ed, fleet } = await chosen();
    await fleet.features.setFeature('session-recording', false);
    const res = await post(app, ed.token, batch(entry(MAIN_LOOP, 1)));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'recording is off' });
    await fleet.features.setFeature('session-recording', true);
    expect(fleet.recordings.page(SID, null, 10, null).total).toBe(1); // only the stop mark the flag going off wrote
  });

  it('is 403 when the session was never chosen, when the reporter does not allow it, and once it is stopped', async () => {
    const s = await setup();
    await send(s.app, s.ed.token, report());
    expect((await post(s.app, s.ed.token, batch(entry(MAIN_LOOP, 1)))).status).toBe(403);
    const a = await signedIn(s.app, 'Ed', s.ed.token);
    await a.put(BASE).set(H).send({ loops: [MAIN_LOOP] });
    await send(s.app, s.ed.token, report(false));
    expect((await post(s.app, s.ed.token, batch(entry(MAIN_LOOP, 1)))).status).toBe(403);
    await send(s.app, s.ed.token, report(true));
    expect((await post(s.app, s.ed.token, batch(entry(MAIN_LOOP, 1)))).status).toBe(200);
    await a.post(`${BASE}/stop`).set(H);
    expect((await post(s.app, s.ed.token, batch(entry(MAIN_LOOP, 2, 'at the stop', { at: T0 })))).status).toBe(200);
    expect(s.fleet.recordings.page(SID, null, 10, null).entries.map((e) => e.kind)).toEqual(['tool', 'stopped', 'tool']);
  });

  it('takes the last interval after a stop: late entries are stored, later ones are not, and the reply says stopped', async () => {
    const { app, ed, a, fleet } = await chosen();
    expect((await post(app, ed.token, batch(entry(MAIN_LOOP, 1)))).status).toBe(200);
    expect((await a.post(`${BASE}/stop`).set(H)).status).toBe(200);
    const res = await post(app, ed.token, batch(entry(MAIN_LOOP, 2, 'late', { at: T0 }), entry(MAIN_LOOP, 3, 'too late', { at: T0 + 1 })));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, stored: 1, recording: { state: 'stopped' } });
    expect(fleet.recordings.page(SID, null, 10, null).entries.map((e) => e.text)).toEqual([`${BODY} 1`, '', 'late']);
  });

  it('still refuses a late batch for a recording stopped by a limit, a deleted one, and one whose flag is off', async () => {
    const lim = await chosen();
    vi.spyOn(lim.fleet.recordingSettings, 'get').mockReturnValue({ keepHours: 6, budgetMb: 2048, sessionMb: 100 / (1024 * 1024) });
    await post(lim.app, lim.ed.token, batch(entry(MAIN_LOOP, 1, 'x'.repeat(200))));
    expect((await post(lim.app, lim.ed.token, batch(entry(MAIN_LOOP, 2, 'late', { at: T0 })))).status).toBe(403);
    const del = await chosen();
    await del.a.post(`${BASE}/stop`).set(H);
    expect((await del.a.delete(BASE).set(H)).status).toBe(200);
    expect((await post(del.app, del.ed.token, batch(entry(MAIN_LOOP, 1, 'late', { at: T0 })))).status).toBe(403);
    const off = await chosen();
    await off.a.post(`${BASE}/stop`).set(H);
    await off.fleet.features.setFeature('session-recording', false);
    expect((await post(off.app, off.ed.token, batch(entry(MAIN_LOOP, 1, 'late', { at: T0 })))).status).toBe(403);
  });

  it('is 404 for a session it does not know, and 409 for one that belongs to someone else', async () => {
    const { app, ed, alex } = await chosen();
    const gone = await request(app).post('/api/fleet/sessions/nope/recording').set('X-Podium-Token', ed.token).send(batch(entry(MAIN_LOOP, 1)));
    expect(gone.status).toBe(404);
    const other = await post(app, alex.token, batch(entry(MAIN_LOOP, 1)));
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('that session belongs to someone else');
  });

  it('does not take a batch for a session that has ended: 409 while its recording is kept, 404 when it has none', async () => {
    const { app, ed, fleet } = await chosen();
    await post(app, ed.token, batch(entry(MAIN_LOOP, 1)));
    (fleet as unknown as { live: Map<string, unknown> }).live.delete(SID);
    const kept = await post(app, ed.token, batch(entry(MAIN_LOOP, 2)));
    expect(kept.status).toBe(409);
    expect(kept.body.error).toBe('the session has ended');
    const s = await setup();
    await send(s.app, s.ed.token, report());
    (s.fleet as unknown as { live: Map<string, unknown> }).live.delete(SID);
    expect((await post(s.app, s.ed.token, batch(entry(MAIN_LOOP, 1)))).status).toBe(404);
  });

  it('stops at the limit: stores what fits, answers state limit, and the next batch is refused', async () => {
    const { app, ed, fleet, people } = await chosen();
    vi.spyOn(fleet.recordingSettings, 'get').mockReturnValue({ keepHours: 6, budgetMb: 2048, sessionMb: 400 / (1024 * 1024) });
    const hundred = 'x'.repeat(100);
    const res = await post(app, ed.token, batch(entry(MAIN_LOOP, 1, hundred), entry(MAIN_LOOP, 2, hundred), entry(MAIN_LOOP, 3, hundred)));
    expect(res.body).toMatchObject({ ok: true, stored: 2, recording: { state: 'limit', limit: 'session', loops: [] } });
    expect((await fleet.view(SID))?.recording).toMatchObject({ state: 'limit', limit: 'session' });
    expect((await post(app, ed.token, batch(entry(MAIN_LOOP, 4)))).status).toBe(403);
    expect((await logRows(people)).find((r) => r.kind === 'recording_limit')?.detail).toMatch(/stopped: the session reached its limit/);
  });

  it('keeps no text in a log line or the Admin log', async () => {
    const { app, ed, a, lines, people } = await chosen();
    await post(app, ed.token, batch(entry(MAIN_LOOP, 1)));
    await a.get(BASE);
    await post(app, ed.token, batch(entry(MAIN_LOOP, 2, 'x', { kind: 'stopped' })));
    expect(lines.join('\n')).not.toContain(BODY);
    expect(JSON.stringify(await logRows(people))).not.toContain(BODY);
  });
});

describe('the browser routes: who may use them', () => {
  it('are 404 while the flag is off, even for the owner signed in', async () => {
    const { app, ed, a, fleet } = await chosen();
    await fleet.features.setFeature('session-recording', false);
    for (const res of [await a.get(BASE), await a.put(BASE).set(H).send({ loops: [MAIN_LOOP] }), await a.post(`${BASE}/stop`).set(H), await a.delete(BASE).set(H)]) {
      expect(res.status).toBe(404);
    }
    expect((await request(app).get(BASE)).status).toBe(404);
    void ed;
  });

  it('are 404 on a server with no token', async () => {
    const { app } = await setup({ secret: null });
    expect((await request(app).get(BASE)).status).toBe(404);
  });

  it('need a sign-in: 401 with none, and for a cookie from nowhere', async () => {
    const { app } = await chosen();
    expect((await request(app).get(BASE)).status).toBe(401);
    expect((await request(app).get(BASE).set('Cookie', 'podium_respond=nope')).status).toBe(401);
    expect((await request(app).put(BASE).set(H).send({ loops: [MAIN_LOOP] })).status).toBe(401);
  });

  it('are 404 for a session the server does not know', async () => {
    const { a } = await chosen();
    const res = await a.get('/api/fleet/respond/sessions/nope/recording');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown session');
  });

  it('refuse another person with 403 and name the owner, for every route', async () => {
    const { app, alex } = await chosen();
    const x = await signedIn(app, 'Alex', alex.token);
    for (const res of [await x.get(BASE), await x.put(BASE).set(H).send({ loops: [MAIN_LOOP] }), await x.post(`${BASE}/stop`).set(H), await x.delete(BASE).set(H)]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ ok: false, error: 'not your session', owner: 'Ed' });
    }
  });

  it('let an Administrator who is not the owner and the admin secret do the same as the owner', async () => {
    const { app, boss } = await chosen();
    const b = await signedIn(app, 'Boss', boss.token);
    expect((await b.get(BASE)).status).toBe(200);
    expect((await b.put(BASE).set(H).send({ loops: [MAIN_LOOP] })).body.grant).toMatchObject({ startedBy: 'Ed' }); // a running recording keeps its starter
    const root = await signedIn(app, 'Admin', SECRET);
    expect((await root.get(BASE)).status).toBe(200);
  });

  it('refuse a change that is not marked as from this page', async () => {
    const { a } = await chosen();
    expect((await a.put(BASE).send({ loops: [MAIN_LOOP] })).status).toBe(403);
    expect((await a.post(`${BASE}/stop`)).status).toBe(403);
    expect((await a.delete(BASE)).status).toBe(403);
  });

  it('lets a browser sign in when only recording is on', async () => {
    const { app } = await setup();
    expect((await request(app).get('/api/fleet/respond/me')).body).toMatchObject({ enabled: true });
  });
});

describe('PUT /respond/sessions/:id/recording (start)', () => {
  it('starts, answers the grant, writes the Admin log with who did it, and the card shows it to everyone', async () => {
    const s = await setup();
    await send(s.app, s.ed.token, report(false)); // the reporter does not allow it: the choice is still recorded
    const a = await signedIn(s.app, 'Ed', s.ed.token);
    const res = await a.put(BASE).set(H).send({ loops: [MAIN_LOOP, 'a1', 'a1'] });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.grant).toMatchObject({ state: 'recording', consent: { admin: true, chosen: true, owner: false }, loops: [MAIN_LOOP, 'a1'], startedBy: 'Ed' });
    const row = (await logRows(s.people)).find((r) => r.kind === 'recording_started');
    expect(row).toMatchObject({ actor: 'Ed' });
    expect(row?.detail).toContain('Ed chose to record 2 loops');
    const view = (await request(s.app).get(`/api/fleet/sessions/${SID}`)).body.recording;
    expect(view).toMatchObject({ state: 'recording', startedBy: 'Ed', ownerAllows: false });
    expect(view.loops.filter((l: { recorded: boolean }) => l.recorded).map((l: { loop: string }) => l.loop)).toEqual([MAIN_LOOP, 'a1']);
    expect((await a.put(BASE).set(H).send({ loops: [MAIN_LOOP] })).body.grant.loops).toEqual([MAIN_LOOP]);
    expect((await logRows(s.people)).find((r) => r.kind === 'recording_started' && r.detail.includes('1 loop'))).toBeTruthy();
  });

  it('refuses a body that is not 1 or more loop ids, and a loop the session does not have', async () => {
    const { a } = await chosen();
    expect((await a.put(BASE).set(H).send({ loops: [] })).status).toBe(400);
    expect((await a.put(BASE).set(H).send({})).status).toBe(400);
    const res = await a.put(BASE).set(H).send({ loops: ['zzz'] });
    expect(res.status).toBe(400);
    expect(res.body.path).toBe('$.loops');
  });

  it('is 409 for a session that is not running', async () => {
    const { a, fleet } = await chosen();
    (fleet as unknown as { live: Map<string, unknown> }).live.delete(SID);
    const res = await a.put(BASE).set(H).send({ loops: [MAIN_LOOP] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('the session is not running');
  });

  it('is 409 when the budget is reached, and when the recording stopped for its limit until it is deleted', async () => {
    const { a, ed, app, fleet } = await chosen();
    vi.spyOn(fleet.recordingSettings, 'get').mockReturnValue({ keepHours: 6, budgetMb: 100 / (1024 * 1024), sessionMb: 50 / (1024 * 1024) });
    await post(app, ed.token, batch(entry(MAIN_LOOP, 1, 'z'.repeat(200))));
    const limit = await a.put(BASE).set(H).send({ loops: [MAIN_LOOP] });
    expect(limit.status).toBe(409);
    expect(limit.body.error).toContain('delete it to start again');
    expect((await a.delete(BASE).set(H)).status).toBe(200);
    // the budget: the stored total is still above it
    vi.spyOn(fleet.recordings, 'totalBytes').mockReturnValue(100);
    const budget = await a.put(BASE).set(H).send({ loops: [MAIN_LOOP] });
    expect(budget.status).toBe(409);
    expect(budget.body.error).toBe('the disk budget has no room for a new recording');
  });

  it('is 409 while the last recording of the session is still being deleted', async () => {
    const { a, fleet } = await chosen();
    // hold the delete's turn in the file, so its rows are still going when the browser asks
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(fleet.activityHistory, 'runExclusive').mockImplementation(async (fn) => {
      await gate;
      return fn();
    });
    const pending = fleet.recordings.removeMany([SID]);
    const res = await a.put(BASE).set(H).send({ loops: [MAIN_LOOP] });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('still being deleted');
    release();
    await pending;
  });
});

describe('GET /respond/sessions/:id/recording (the replay)', () => {
  async function recorded() {
    const s = await chosen();
    const entries: RecordingEntry[] = [];
    for (let i = 1; i <= 5; i++) entries.push(entry(MAIN_LOOP, i, `${BODY} main ${i}`));
    entries.push(entry('a1', 1, `${BODY} agent 1`));
    expect((await post(s.app, s.ed.token, batch(...entries))).body.stored).toBe(6);
    return s;
  }

  it('gives the owner the newest rows oldest first with the grant, the loops and the owner, no-store', async () => {
    const { a } = await recorded();
    const res = await a.get(BASE);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.entries.map((e: { text: string }) => e.text)).toEqual([...[1, 2, 3, 4, 5].map((i) => `${BODY} main ${i}`), `${BODY} agent 1`]);
    expect(res.body).toMatchObject({ olderBefore: null, total: 6, owner: 'Ed', grant: { state: 'recording' } });
    expect(res.body.loops).toEqual(expect.arrayContaining([{ loop: MAIN_LOOP, name: 'Orchestrator', recorded: true }]));
  });

  it('pages back with before and limit, and limits a page to one loop', async () => {
    const { a } = await recorded();
    const first = (await a.get(`${BASE}?limit=2`)).body;
    expect(first.entries).toHaveLength(2);
    expect(first.olderBefore).toBe(5);
    const next = (await a.get(`${BASE}?limit=2&before=${first.olderBefore}`)).body;
    expect(next.entries.map((e: { text: string }) => e.text)).toEqual([`${BODY} main 3`, `${BODY} main 4`]);
    const agent = (await a.get(`${BASE}?loop=a1`)).body;
    expect(agent.entries).toHaveLength(1);
    expect(agent.total).toBe(1);
    expect((await a.get(`${BASE}?limit=9999`)).body.entries).toHaveLength(6);
  });

  it('is 400 for a bad before, limit or loop, and 404 when the session has no recording', async () => {
    const { a, app, ed } = await recorded();
    for (const q of ['before=x', 'before=-1', 'limit=0', 'limit=abc', 'loop=zzz', 'loop=a1&loop=a2']) expect((await a.get(`${BASE}?${q}`)).status).toBe(400);
    expect((await a.delete(BASE).set(H)).status).toBe(200);
    const none = await a.get(BASE);
    expect(none.status).toBe(404);
    expect(none.body.error).toBe('this session has no recording');
    void app;
    void ed;
  });

  it('writes recording_read to the Admin log for a replay opened, the owner included, and not for paging back', async () => {
    const { a, people, boss, app } = await recorded();
    await a.get(BASE);
    await a.get(`${BASE}?before=3`);
    await a.get(`${BASE}?before=3&limit=1`);
    const reads = async () => (await logRows(people)).filter((r) => r.kind === 'recording_read');
    expect(await reads()).toHaveLength(1);
    expect((await reads())[0]).toMatchObject({ actor: 'Ed' });
    expect((await reads())[0]!.detail).toContain('Ed opened the replay');
    const b = await signedIn(app, 'Boss', boss.token);
    await b.get(`${BASE}?loop=${MAIN_LOOP}`);
    await b.get(`${BASE}?loop=a1`);
    expect(await reads()).toHaveLength(3);
    expect((await reads())[0]!.detail).toContain('Boss opened the replay of one agent'); // newest first
    expect((await reads())[1]!.detail).toContain('of the orchestrator');
    expect(JSON.stringify(await logRows(people))).not.toContain(BODY);
  });

  it('works for a session that has ended and after the flag went off for the owner of nothing else', async () => {
    const { a, fleet } = await recorded();
    (fleet as unknown as { live: Map<string, unknown> }).live.delete(SID);
    const res = await a.get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.grant.state).toBe('stopped');
  });
});

describe('POST …/stop and DELETE …', () => {
  it('stop keeps what was recorded, writes a mark and a log row once, and answers 200 again for a recording already stopped', async () => {
    const { a, app, ed, people } = await chosen();
    await post(app, ed.token, batch(entry(MAIN_LOOP, 1)));
    const res = await a.post(`${BASE}/stop`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.grant).toMatchObject({ state: 'stopped', stoppedBy: 'Ed' });
    expect((await a.post(`${BASE}/stop`).set(H)).body.grant.state).toBe('stopped');
    expect((await logRows(people)).filter((r) => r.kind === 'recording_stopped')).toHaveLength(1);
    const page = (await a.get(BASE)).body;
    expect(page.entries.map((e: { kind: string }) => e.kind)).toEqual(['tool', 'stopped']);
    expect(page.entries[1].by).toBe('Ed');
  });

  it('stop is 404 when there is no recording', async () => {
    const s = await setup();
    await send(s.app, s.ed.token, report());
    const a = await signedIn(s.app, 'Ed', s.ed.token);
    expect((await a.post(`${BASE}/stop`).set(H)).status).toBe(404);
    expect((await a.delete(BASE).set(H)).status).toBe(404);
  });

  it('delete removes the whole recording for good, stops capture, and writes the counts to the Admin log', async () => {
    const { a, app, ed, people, fleet } = await chosen();
    await post(app, ed.token, batch(entry(MAIN_LOOP, 1), entry(MAIN_LOOP, 2)));
    const res = await a.delete(BASE).set(H);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, entries: 2 });
    expect(res.body.bytes).toBeGreaterThan(0);
    expect((await logRows(people)).find((r) => r.kind === 'recording_deleted')?.detail).toContain('Ed deleted the recording (2 entries');
    expect((await post(app, ed.token, batch(entry(MAIN_LOOP, 3)))).status).toBe(403);
    expect((await fleet.view(SID))?.recording).toBeUndefined();
    expect((await a.get(BASE)).status).toBe(404);
  });

  it('reports a failed delete as 500 without a detail', async () => {
    const { a, fleet } = await chosen();
    vi.spyOn(fleet.recordings, 'removeMany').mockRejectedValue(new Error('disk is gone'));
    const res = await a.delete(BASE).set(H);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('disk is gone');
  });
});

describe('what the server does on its own is logged', () => {
  it('turning the flag off stops the recording, keeps what it holds, and tells the log', async () => {
    const { app, ed, fleet, people } = await chosen();
    await post(app, ed.token, batch(entry(MAIN_LOOP, 1)));
    await fleet.features.setFeature('session-recording', false);
    expect(fleet.recordings.stateFor(SID)).toBe('stopped');
    expect((await fleet.view(SID))?.recording).toMatchObject({ state: 'stopped', stoppedBy: 'Admin' });
    expect((await logRows(people)).find((r) => r.kind === 'recording_stopped')?.detail).toContain('the Admin turned session recording off');
    await fleet.features.setFeature('session-recording', true);
    expect(fleet.recordings.page(SID, null, 10, null).entries.map((e) => e.kind)).toEqual(['tool', 'stopped']);
  });

  it('a /clear carries a running recording to the new session, and says so in the log', async () => {
    const { app, ed, fleet, people } = await chosen();
    const next = report(true, { id: 'sess-new', clearedFrom: SID });
    expect((await send(app, ed.token, next)).body.recording).toMatchObject({ state: 'recording', loops: [MAIN_LOOP], startedBy: 'Ed', consent: { chosen: true, owner: true } });
    expect(fleet.recordings.stateFor(SID)).toBe('stopped');
    expect((await logRows(people)).find((r) => r.kind === 'recording_started' && r.detail.includes('continues after /clear'))).toBeTruthy();
  });

  it('a failing carry-over is logged and does not refuse the report', async () => {
    const { app, ed, fleet, lines } = await chosen();
    vi.spyOn(fleet.recordings, 'carryOver').mockImplementation(() => {
      throw new Error('file is locked');
    });
    expect((await send(app, ed.token, report(true, { id: 'sess-new2', clearedFrom: SID }))).status).toBe(200);
    expect(lines.join('\n')).toContain('could not carry a recording over');
  });

  it('a message Podium delivers to a recorded loop is marked on the mod entry that carries it, and not stored twice', async () => {
    const { fleet, app, ed } = await chosen();
    await fleet.features.setFeature('respond', true);
    await send(app, ed.token, report(true, { respond: ACCEPTS }));
    expect(fleet.respond.message(SID, 'Boss', { text: `${BODY} please also update the guide` }).ok).toBe(true);
    expect(fleet.recordings.page(SID, null, 10, null).entries).toEqual([]);
    const res = await post(app, ed.token, batch(entry(MAIN_LOOP, 1, `${BODY} please also update the guide`, { kind: 'prompt', at: T0 + 1 })));
    expect(res.body.stored).toBe(1);
    const rows = fleet.recordings.page(SID, null, 10, null).entries;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'prompt', by: 'Boss', loop: MAIN_LOOP });
  });

  it('only a message is remembered for marking: a command, and a message taken back before the mod got it, leave no mark behind', async () => {
    const { fleet, app, ed } = await chosen();
    await fleet.features.setFeature('respond', true);
    await send(app, ed.token, report(true, { respond: { level: 'everything', accepts: ['message', 'command'], limits: [] } as unknown as Report['session']['respond'] }));
    expect(fleet.respond.message(SID, 'Boss', { text: '/clear' }).ok).toBe(true);
    const taken = fleet.respond.message(SID, 'Boss', { text: 'never mind this one' });
    expect(taken.ok && fleet.respond.discard(taken.delivery.id, 'Boss', false)).toBe('ok');
    // a person typed prompts that hold the same words
    await post(app, ed.token, batch(entry(MAIN_LOOP, 1, `${BODY} how do I /clear the cache`, { kind: 'prompt', at: T0 + 1 }), entry(MAIN_LOOP, 2, 'never mind this one', { kind: 'prompt', at: T0 + 2 })));
    expect(fleet.recordings.page(SID, null, 10, null).entries.map((r) => [r.kind, r.by])).toEqual([
      ['prompt', undefined],
      ['prompt', undefined],
    ]);
  });

  it('keeps a decision the mod recorded, with who decided it from Podium, and a compact it marked', async () => {
    const { fleet, app, ed } = await chosen();
    const res = await post(
      app,
      ed.token,
      batch(
        entry(MAIN_LOOP, 1, '{"command":"git push"}', { name: 'Bash' }),
        entry(MAIN_LOOP, 2, 'Denied: not on main', { kind: 'decision', name: 'permission', callSeq: 1, failed: true, by: 'Boss' }),
        entry(MAIN_LOOP, 3, '', { kind: 'compact', by: 'Boss' }),
      ),
    );
    expect(res.body.stored).toBe(3);
    expect(fleet.recordings.page(SID, null, 10, null).entries.map((r) => [r.kind, r.name, r.callSeq, r.failed, r.by])).toEqual([
      ['tool', 'Bash', undefined, undefined, undefined],
      ['decision', 'permission', 1, true, 'Boss'],
      ['compact', undefined, undefined, undefined, 'Boss'],
    ]);
  });

  it('a failing write of such a prompt is logged and does not refuse the message', async () => {
    const { fleet, lines, app, ed } = await chosen();
    await fleet.features.setFeature('respond', true);
    await send(app, ed.token, report(true, { respond: ACCEPTS }));
    vi.spyOn(fleet.recordings, 'notePodiumPrompt').mockImplementation(() => {
      throw new Error('file is locked');
    });
    expect(fleet.respond.message(SID, 'Boss', { text: 'hello' }).ok).toBe(true);
    expect(lines.join('\n')).toContain('could not add a Podium entry');
  });
});

describe('deleting the session', () => {
  it('removes its recording with it, and the session list no longer shows one', async () => {
    const { app, ed, fleet } = await chosen();
    await post(app, ed.token, batch(entry(MAIN_LOOP, 1)));
    expect(await fleet.deleteSession(SID)).toBe(true);
    await fleet.recordings.removeMany([]); // let the chunked delete finish
    await new Promise((r) => setImmediate(r));
    expect(fleet.recordings.has(SID)).toBe(false);
    expect(fleet.recordings.page(SID, null, 10, null).entries).toEqual([]);
  });

  it('logs a recording that could not be removed, and goes on', async () => {
    const { fleet, lines } = await chosen();
    vi.spyOn(fleet.recordings, 'removeSession').mockRejectedValue(new Error('disk is gone'));
    expect(await fleet.deleteSession(SID)).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(lines.join('\n')).toContain('could not remove the recording of session');
  });

  it('retention removes the recordings of sessions the main database dropped, and logs a failure', async () => {
    const { fleet, lines } = await chosen();
    await fleet.db.deleteSession(SID);
    await fleet.retain();
    await new Promise((r) => setTimeout(r, 20));
    expect(fleet.recordings.has(SID)).toBe(false);
    vi.spyOn(fleet.recordings, 'dropMissingSessions').mockRejectedValue(new Error('disk is gone'));
    await fleet.retain();
    await new Promise((r) => setImmediate(r));
    expect(lines.join('\n')).toContain('could not remove the recordings of expired sessions');
  });
});

describe('what History and the picker learn (#353)', () => {
  const dayOf = (t: number) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const ended = async (s: Awaited<ReturnType<typeof chosen>>) => {
    expect((await post(s.app, s.ed.token, batch(entry(MAIN_LOOP, 1)))).status).toBe(200);
    expect((await send(s.app, s.ed.token, report(true, { status: 'done', endReason: 'clear' }))).status).toBe(200);
    return `/api/fleet/history?day=${dayOf(T0)}`;
  };

  it('marks an ended session whose recording is kept for its owner and for an Admin, and for no one else', async () => {
    const s = await chosen();
    const url = await ended(s);
    const keptUntil = T0 + 6 * 3_600_000;
    expect((await s.a.get(url)).body.sessions[0].recording).toEqual({ keptUntil });
    expect((await s.a.get(`${url}&page=1&pageSize=25`)).body.sessions[0].recording).toEqual({ keptUntil });
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    expect((await boss.get(url)).body.sessions[0].recording).toEqual({ keptUntil });
    const alex = await signedIn(s.app, 'Alex', s.alex.token);
    expect((await alex.get(url)).body.sessions[0]).not.toHaveProperty('recording');
    expect((await request(s.app).get(url)).body.sessions[0]).not.toHaveProperty('recording');
  });

  it('leaves the mark out while the session-recording flag is off, since the replay routes answer 404 then', async () => {
    const s = await chosen();
    const url = await ended(s);
    await s.fleet.features.setFeature('session-recording', false);
    expect((await s.a.get(url)).body.sessions[0]).not.toHaveProperty('recording');
    await s.fleet.features.setFeature('session-recording', true);
    expect((await s.a.get(url)).body.sessions[0].recording).toBeDefined();
  });

  it('marks nothing for a session with no recording', async () => {
    const s = await setup();
    await send(s.app, s.ed.token, report(true, { status: 'done', endReason: 'clear' }));
    const a = await signedIn(s.app, 'Ed', s.ed.token);
    expect((await a.get(`/api/fleet/history?day=${dayOf(T0)}`)).body.sessions[0]).not.toHaveProperty('recording');
  });

  it("tells the owner and an Admin, before Start, whether the session's reporter allows recording", async () => {
    const s = await setup();
    await send(s.app, s.ed.token, report(false));
    const a = await signedIn(s.app, 'Ed', s.ed.token);
    const no = await a.get(`${BASE}/consent`);
    expect(no.status).toBe(200);
    expect(no.body).toMatchObject({ ok: true, grant: { state: 'off', consent: { admin: true, chosen: false, owner: false } } });
    expect(no.headers['cache-control']).toContain('no-store');
    await send(s.app, s.ed.token, report(true));
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    expect((await boss.get(`${BASE}/consent`)).body.grant.consent.owner).toBe(true);
  });

  it("carries the Admin's keep time, so the picker can state it", async () => {
    const s = await setup();
    await send(s.app, s.ed.token, report());
    const a = await signedIn(s.app, 'Ed', s.ed.token);
    expect((await a.get(`${BASE}/consent`)).body.keepHours).toBe(6);
    vi.spyOn(s.fleet.recordingSettings, 'get').mockReturnValue({ keepHours: 48, budgetMb: 4096, sessionMb: 512 });
    expect((await a.get(`${BASE}/consent`)).body.keepHours).toBe(48);
  });

  it('refuses the consent to anyone else, to a signed-out browser, and while the flag is off', async () => {
    const s = await setup();
    await send(s.app, s.ed.token, report());
    expect((await request(s.app).get(`${BASE}/consent`)).status).toBe(401);
    const alex = await signedIn(s.app, 'Alex', s.alex.token);
    expect((await alex.get(`${BASE}/consent`)).status).toBe(403);
    const a = await signedIn(s.app, 'Ed', s.ed.token);
    await s.fleet.features.setFeature('session-recording', false);
    expect((await a.get(`${BASE}/consent`)).status).toBe(404);
  });
});
