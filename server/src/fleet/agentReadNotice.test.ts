// An agent's whole prompt and answer (`/text`) and its live activity (`/activity`) are the person's own content (DECISIONS 62, #1082, rows R5 and R6 of the #1043
// audit): both need a sign-in as the session's owner or an Admin, and an Admin's read is recorded and the person told, with one content-free Admin log line per
// reading session. Nothing is recorded for the owner, for a refused read or for a session nobody owns.
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

const closers: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) c();
});

const SECRET = 'admin-secret';
const H = { 'X-Podium-Respond': '1' };
const T0 = 1_791_648_000_000;
const SID = 'sess-ed';
const PROMPT = 'UNIQUE-PROMPT-TEXT-7731';
const ANSWER = 'UNIQUE-ANSWER-TEXT-7732';

function report(sid: string, owner: string): Report {
  const r = fixtureReport();
  r.session = { ...r.session, id: sid, activityFeed: true };
  r.userName = owner;
  r.agents[0]!.promptText = PROMPT;
  r.agents[0]!.answerText = ANSWER;
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
  await fleet.activityHistorySettings.set({ policy: 'all' }); // a feature that needs the sign-in is on, so a browser can sign in
  const ed = await people.createPerson('Ed');
  const alex = await people.createPerson('Alex');
  const boss = await people.createPerson('Boss');
  await people.setGroup(boss.person.id, await people.administratorsGroupId());
  const send = (token: string, r: Report) => request(app).post('/api/fleet/report').set('X-Podium-Token', token).send(r);
  expect((await send(ed.token, report(SID, 'Ed'))).status).toBe(200);
  const agentId = (await fleet.db.getAgents(SID))[0]!.id;
  const name = (await fleet.db.getSession(SID))!.name;
  const text = (sid = SID, agent = agentId) => `/api/fleet/sessions/${sid}/agents/${agent}/text`;
  const live = (sid = SID, agent = agentId) => `/api/fleet/sessions/${sid}/agents/${agent}/activity`;
  const reads = (kind: 'text' | 'live', sid = SID, agent = agentId) => fleet.chat.adminReads.list(`${kind}:${sid}:${agent}`);
  const logRows = async (kind: string) => (await people.listLog({ page: 1, pageSize: 200 })).rows.filter((r) => r.kind === kind);
  const notices = async () => ((await send(ed.token, report(SID, 'Ed'))).body as { adminNotices?: { text: string }[] }).adminNotices ?? [];
  return { app, fleet, people, ed, alex, boss, send, agentId, name, text, live, reads, logRows, notices };
}

async function signedIn(app: express.Express, name: string, token: string) {
  const agent = request.agent(app);
  expect((await agent.post('/api/fleet/respond/sign-in').set(H).send({ name, token })).status).toBe(200);
  return agent;
}

describe.each([
  { kind: 'text' as const, log: 'text_admin_read', words: (n: string) => `is reading the whole prompt and answer of an agent in ${n}` },
  { kind: 'live' as const, log: 'live_admin_read', words: (n: string) => `is watching the live activity of an agent in ${n}` },
])('an agent\'s $kind read (#1082)', ({ kind, log, words }) => {
  const url = (s: Awaited<ReturnType<typeof setup>>, sid = SID, agent = s.agentId) => (kind === 'text' ? s.text(sid, agent) : s.live(sid, agent));

  it('refuses a read with no sign-in, and a person who is not the owner', async () => {
    const s = await setup();
    const none = await request(s.app).get(url(s));
    expect(none.status).toBe(401);
    expect(JSON.stringify(none.body)).not.toContain(PROMPT);
    const alex = await signedIn(s.app, 'Alex', s.alex.token);
    const other = await alex.get(url(s));
    expect(other.status).toBe(403);
    expect(JSON.stringify(other.body)).not.toContain(PROMPT);
    expect(await s.reads(kind)).toHaveLength(0);
    expect(await s.logRows(log)).toHaveLength(0);
  });

  it('serves the owner and records nothing', async () => {
    const s = await setup();
    const ed = await signedIn(s.app, 'Ed', s.ed.token);
    expect((await ed.get(url(s))).status).toBe(200);
    expect(await s.reads(kind)).toHaveLength(0);
    expect(await s.logRows(log)).toHaveLength(0);
    expect(await s.notices()).toEqual([]);
  });

  it('serves an Admin, records one read and one Admin log line however many fetches, and tells the owner without any text', async () => {
    const s = await setup();
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    expect((await boss.get(url(s))).status).toBe(200);
    expect((await boss.get(url(s))).status).toBe(200);
    expect(await s.reads(kind)).toHaveLength(1);
    const rows = await s.logRows(log);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toContain('Boss');
    expect(rows[0]!.detail).toContain(SID.slice(0, 8));
    expect(JSON.stringify(rows)).not.toContain(PROMPT);
    const told = await s.notices();
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toBe(`Boss (an Admin) ${words(s.name)}.`);
    expect(JSON.stringify(told)).not.toContain(PROMPT);
  });

  it('writes the one Admin log line when a ping began the reading first (#1166), and not again for a second read or a second ping', async () => {
    const s = await setup();
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    const ping = () => boss.post(`/api/fleet/respond/sessions/${SID}/admin-reads/${kind}/reading`).set(H).send({ loop: s.agentId });
    expect((await ping()).status).toBe(200);
    expect(await s.logRows(log)).toHaveLength(0); // a ping reads nothing, so it writes no line
    expect((await boss.get(url(s))).status).toBe(200);
    expect((await boss.get(url(s))).status).toBe(200);
    expect((await ping()).status).toBe(200);
    expect((await boss.get(url(s))).status).toBe(200);
    expect(await s.reads(kind)).toHaveLength(1);
    const rows = await s.logRows(log);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toContain('Boss');
    expect(JSON.stringify(rows)).not.toContain(PROMPT);
  });

  it('names the admin secret by the name the Admin log gives it', async () => {
    const s = await setup();
    const root = await signedIn(s.app, 'Admin', SECRET);
    expect((await root.get(url(s))).status).toBe(200);
    expect(await s.reads(kind)).toHaveLength(1);
    expect((await s.logRows(log))[0]!.detail).toContain('Admin secret');
  });

  it('wakes open consoles with the reads counter once', async () => {
    const s = await setup();
    const changed = vi.spyOn(s.fleet, 'sessionReadsChanged');
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    await boss.get(url(s));
    await boss.get(url(s));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('records nothing for an Admin reading their own session or a session nobody owns', async () => {
    const s = await setup();
    expect((await s.send(s.boss.token, report('sess-boss', 'Boss'))).status).toBe(200);
    expect((await s.send(SECRET, report('sess-shared', 'Someone'))).status).toBe(200);
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    const own = (await s.fleet.db.getAgents('sess-boss'))[0]!.id;
    const shared = (await s.fleet.db.getAgents('sess-shared'))[0]!.id;
    expect((await boss.get(url(s, 'sess-boss', own))).status).toBe(200);
    expect((await boss.get(url(s, 'sess-shared', shared))).status).toBe(200);
    expect(await s.reads(kind, 'sess-boss', own)).toHaveLength(0);
    expect(await s.reads(kind, 'sess-shared', shared)).toHaveLength(0);
    expect(await s.logRows(log)).toHaveLength(0);
  });

  it('answers 404 for an unknown session or agent and records nothing', async () => {
    const s = await setup();
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    expect((await boss.get(url(s, 'nope', 'x'))).status).toBe(404);
    expect((await boss.get(url(s, SID, 'nope'))).status).toBe(404);
    expect(await s.logRows(log)).toHaveLength(0);
  });

  it('stops the read when the record cannot be made: nothing is sent', async () => {
    const s = await setup();
    vi.spyOn(s.fleet.chat.adminReads, 'noteSession').mockRejectedValue(new Error('disk full'));
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    const res = await boss.get(url(s));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(res.body)).not.toContain(PROMPT);
    expect(await s.logRows(log)).toHaveLength(0);
  });
});

describe('an Admin\'s open read pinging (#1082)', () => {
  it.each(['text', 'live'] as const)('keeps a %s read live for the owner, and 404s a loop the session lacks', async (kind) => {
    const s = await setup();
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    const ping = (loop: string) => boss.post(`/api/fleet/respond/sessions/${SID}/admin-reads/${kind}/reading`).set(H).send({ loop });
    expect((await ping('nope')).status).toBe(404);
    expect(await s.reads(kind)).toHaveLength(0);
    expect((await ping(s.agentId)).status).toBe(200);
    expect(await s.reads(kind)).toHaveLength(1);
    const alex = await signedIn(s.app, 'Alex', s.alex.token);
    expect((await alex.post(`/api/fleet/respond/sessions/${SID}/admin-reads/${kind}/reading`).set(H).send({ loop: s.agentId })).status).toBe(403);
  });
});

describe('a text read of the orchestrator loop (#1082)', () => {
  it('cannot be recorded by a ping, because the text route has no such loop', async () => {
    const s = await setup();
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    const ping = (kind: string, loop: string) => boss.post(`/api/fleet/respond/sessions/${SID}/admin-reads/${kind}/reading`).set(H).send({ loop });
    expect((await ping('text', MAIN_LOOP)).status).toBe(404);
    expect(await s.reads('text', SID, MAIN_LOOP)).toHaveLength(0);
    expect((await ping('live', MAIN_LOOP)).status).toBe(200);
  });
});

describe('the live feed of the orchestrator loop (#1082)', () => {
  it('is gated and recorded under its own loop', async () => {
    const s = await setup();
    expect((await request(s.app).get(s.live(SID, MAIN_LOOP))).status).toBe(401);
    const boss = await signedIn(s.app, 'Boss', s.boss.token);
    expect((await boss.get(s.live(SID, MAIN_LOOP))).status).toBe(200);
    expect(await s.reads('live', SID, MAIN_LOOP)).toHaveLength(1);
  });

  it('takes no viewer lease for a refused read', async () => {
    const s = await setup();
    const watch = vi.spyOn(s.fleet.activity, 'watch');
    await request(s.app).get(s.live());
    const alex = await signedIn(s.app, 'Alex', s.alex.token);
    await alex.get(s.live());
    expect(watch).not.toHaveBeenCalled();
  });
});
