import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openDb, FleetDb } from './db.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { PeopleStore } from './people.js';
import { ReporterStore } from './reporters.js';
import { createFleetRouter } from './routes.js';
import { createLogger } from '../logging/logger.js';
import { createAdminRouter } from '../admin/adminRouter.js';
import { Lockout } from './lockout.js';
import { createRespondBridge } from './respondBridge.js';
import { PEER_MESSAGING } from './featureFlags.js';
import type { Report } from './protocol.js';
import { fixtureReport } from './testing.js';

const SECRET = 'admin-secret-for-the-peer-tests';
const H = { 'X-Podium-Respond': '1' };
const HA = { 'X-Podium-Admin': '1' };
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

function setup(opts: { secret?: string | null; flag?: boolean } = {}) {
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  const db = openDb(':memory:');
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const fleet = new Fleet(new FleetDb(db), { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, now);
  const people = new PeopleStore(db);
  const reporters = new ReporterStore(db, now());
  const lockout = new Lockout(now);
  const respondBridge = createRespondBridge();
  const lines: string[] = [];
  const logger = createLogger({ format: 'json', level: 'debug', write: (l) => lines.push(l) });
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: secret, people, reporters, lockout, respondBridge, logger }));
  app.use('/api/admin', createAdminRouter({ secret, people, reporters, peers: fleet.peers, features: fleet.features, lockout, respondBridge, now, log: () => {} }));
  closers.push(() => fleet.close());
  if (opts.flag !== false) fleet.features.setFeature(PEER_MESSAGING, true);
  const ed = people.createPerson('Ed');
  const alex = people.createPerson('Alex');
  return { app, fleet, people, ed, alex, lines, db, tick: (ms: number) => (clock += ms) };
}

type S = ReturnType<typeof setup>;

/** One orchestrator's report: a session on a machine, with the `peers` option on unless told otherwise. */
function report(userName: string, sid: string, name: string, machine: { name: string; id: string }, over: Partial<Report['session']> = {}): Report {
  const r = fixtureReport();
  r.session = { ...r.session, id: sid, name, status: 'waiting', waitReason: 'input', peers: true, ...over };
  r.userName = userName;
  r.machine = { ...machine, os: 'macOS 27.0.1' };
  return r;
}

const MAC = { name: 'ed-mbp', id: 'macmacmac001' };
const LINUX = { name: 'ci-runner-01', id: 'lnxlnxlnx001' };
const ALEX_BOX = { name: 'alex-box', id: 'alxalxalx001' };

const post = (s: S, token: string, r: Report) => request(s.app).post('/api/fleet/report').set('X-Podium-Token', token).send(r);
const devReport = (s: S, over: Partial<Report['session']> = {}) => post(s, s.ed.token, report('Ed', 'sess-dev', 'dev', MAC, { status: 'running', waitReason: null, ...over }));
const testerReport = (s: S, over: Partial<Report['session']> = {}) => post(s, s.ed.token, report('Ed', 'sess-tester', 'Tester', LINUX, over));
const alexReport = (s: S) => post(s, s.alex.token, report('Alex', 'sess-alex', 'review', ALEX_BOX));
const send = (s: S, text: string, to = 'Tester@ci-runner-01', from = 'sess-dev', token = s.ed.token) =>
  request(s.app).post(`/api/fleet/sessions/${from}/peers/messages`).set('X-Podium-Token', token).send({ to, text });

async function signedIn(s: S, name: string, token: string) {
  const agent = request.agent(s.app);
  expect((await agent.post('/api/fleet/respond/sign-in').set(H).send({ name, token })).status).toBe(200);
  return agent;
}

async function adminAgent(s: S) {
  const agent = request.agent(s.app);
  expect((await agent.post('/api/admin/unlock').set(HA).send({ name: 'Admin', token: SECRET })).status).toBe(200);
  return agent;
}

/** Ed's two machines reporting, and Ed signed in with Mac to Linux set to `level`. */
async function linked(level: 'see' | 'ask' | 'send' = 'send', opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  expect((await devReport(s)).status).toBe(200);
  expect((await testerReport(s)).status).toBe(200);
  expect((await alexReport(s)).status).toBe(200);
  const ed = await signedIn(s, 'Ed', s.ed.token);
  const set = await ed.put('/api/fleet/respond/peers/rights').set(H).send({ from: MAC.id, to: LINUX.id, level });
  expect(set.status).toBe(200);
  return { ...s, edBrowser: ed };
}

const logKinds = (s: S) => s.people.listLog({ page: 1, pageSize: 100 }).rows.map((r) => r.kind);
const storedMessages = (s: S) => (s.db.prepare('SELECT COUNT(*) AS n FROM peer_messages').get() as { n: number }).n;

describe('the report reply (#412)', () => {
  it('says peers: true only with authentication, the flag, a person token and the peers option', async () => {
    const s = setup();
    const r = await devReport(s);
    expect(r.body).toMatchObject({ peers: true, peerDeliveries: [], peerRequests: [] });
    expect((await devReport(s, { peers: false })).body.peers).toBe(false);
    s.fleet.features.setFeature(PEER_MESSAGING, false);
    expect((await devReport(s)).body.peers).toBe(false);
  });

  it('says peers: false with authentication off, and for a reporter on the admin secret', async () => {
    const open = setup({ secret: null });
    expect((await request(open.app).post('/api/fleet/report').send(report('Ed', 'sess-x', 'x', MAC))).body.peers).toBe(false);
    const s = setup();
    const r = report('Admin', 'sess-admin', 'admin-one', MAC);
    delete r.userName;
    expect((await request(s.app).post('/api/fleet/report').set('X-Podium-Token', SECRET).send(r)).body.peers).toBe(false);
  });

  it('says peers: false to an older reporter, which never sends the option, and never lists it', async () => {
    const s = await linked('send');
    const old = report('Ed', 'sess-old', 'old-one', LINUX);
    delete old.session.peers;
    expect((await post(s, s.ed.token, old)).body.peers).toBe(false);
    const list = await request(s.app).get('/api/fleet/sessions/sess-dev/peers').set('X-Podium-Token', s.ed.token);
    expect(list.body.peers.map((p: { name: string }) => p.name)).toEqual(['Tester']);
    expect((await send(s, 'hi', 'old-one@ci-runner-01')).status).toBe(404);
  });
});

describe('a message between two of one owner’s orchestrators (#412)', () => {
  it('is held while the receiver works, handed over when it reports idle, and its result recorded', async () => {
    const s = await linked('send');
    await testerReport(s, { status: 'running', waitReason: null });
    const sent = await send(s, 'Please run the systemd unit tests');
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ ok: true, state: 'turn', paused: false, to: { name: 'Tester', machine: 'ci-runner-01' } });
    expect((await testerReport(s, { status: 'running', waitReason: null })).body.peerDeliveries).toEqual([]);
    const idle = await testerReport(s);
    expect(idle.body.peerDeliveries).toEqual([
      { id: sent.body.id, kind: 'message', at: expect.any(Number), from: { name: 'dev', machine: 'ed-mbp', owner: 'Ed' }, text: 'Please run the systemd unit tests' },
    ]);
    const took = await request(s.app).post(`/api/fleet/sessions/sess-tester/peers/deliveries/${sent.body.id}/result`).set('X-Podium-Token', s.ed.token).send({ result: 'took', at: 1 });
    expect(took.status).toBe(200);
    expect((await testerReport(s)).body.peerDeliveries).toEqual([]);
    expect(logKinds(s)).toEqual(expect.arrayContaining(['peer_sent', 'peer_delivered', 'peer_right_set']));
  });

  it('never writes the text to the Admin log, the server log, the state or the stream', async () => {
    const s = await linked('send');
    const secret = 'THE-TEXT-OF-THE-MESSAGE';
    const sent = await send(s, secret);
    await testerReport(s);
    await request(s.app).post(`/api/fleet/sessions/sess-tester/peers/deliveries/${sent.body.id}/result`).set('X-Podium-Token', s.ed.token).send({ result: 'took', at: 1 });
    const log = s.people.listLog({ page: 1, pageSize: 100 }).rows;
    expect(JSON.stringify(log)).not.toContain(secret);
    expect(s.lines.join('\n')).not.toContain(secret);
    expect(JSON.stringify((await request(s.app).get('/api/fleet/state')).body)).not.toContain(secret);
    expect(JSON.stringify((await request(s.app).get('/api/fleet/peers/traffic?range=30d')).body)).not.toContain(secret);
  });

  it('waits for the owner on a link with approval, and is handed over once the owner delivers it from the browser', async () => {
    const s = await linked('ask');
    const sent = await send(s, 'Also run npm run test:mod there');
    expect(sent.body).toMatchObject({ state: 'approval', approvalWhy: 'link', requestId: expect.stringMatching(/^prq_/) });
    expect((await testerReport(s)).body.peerDeliveries).toEqual([]);
    const page = await s.edBrowser.get('/api/fleet/respond/peers');
    expect(page.body.requests).toEqual([expect.objectContaining({ id: sent.body.requestId, kind: 'message', messageId: sent.body.id, text: 'Also run npm run test:mod there' })]);
    // The owner's sessions on the machine it concerns hear of it too, for a toast and /podium deliver.
    expect((await testerReport(s)).body.peerRequests).toEqual([expect.objectContaining({ id: sent.body.requestId, kind: 'message' })]);
    const ok = await s.edBrowser.post(`/api/fleet/respond/peers/requests/${sent.body.requestId}`).set(H).send({ answer: 'deliver' });
    expect(ok.body).toEqual({ ok: true, outcome: 'delivered' });
    expect((await testerReport(s)).body.peerDeliveries.map((d: { id: string }) => d.id)).toEqual([sent.body.id]);
    // Answered in one place, it is closed in the other.
    const again = await request(s.app).post(`/api/fleet/sessions/sess-tester/peers/requests/${sent.body.requestId}`).set('X-Podium-Token', s.ed.token).send({ answer: 'decline' });
    expect(again.status).toBe(410);
    expect(logKinds(s)).toContain('peer_approved');
  });

  it('can be declined from a session, and its sender is told', async () => {
    const s = await linked('ask');
    const sent = await send(s, 'no thanks');
    const out = await request(s.app).post(`/api/fleet/sessions/sess-tester/peers/requests/${sent.body.requestId}`).set('X-Podium-Token', s.ed.token).send({ answer: 'decline' });
    expect(out.body).toEqual({ ok: true, outcome: 'declined' });
    expect((await testerReport(s)).body.peerDeliveries).toEqual([]);
    expect((await devReport(s)).body.peerDeliveries).toEqual([expect.objectContaining({ kind: 'notice', from: null })]);
    expect(logKinds(s)).toContain('peer_declined');
  });

  it('delivered from a session on a paused link, says the link is paused, so /podium deliver says it waits for Resume', async () => {
    const s = await linked('ask');
    const answer = (id: string) => request(s.app).post(`/api/fleet/sessions/sess-tester/peers/requests/${id}`).set('X-Podium-Token', s.ed.token).send({ answer: 'deliver' });
    const first = await send(s, 'on an open link');
    expect((await answer(first.body.requestId)).body).toEqual({ ok: true, outcome: 'delivered' });
    await s.edBrowser.put('/api/fleet/respond/peers/links').set(H).send({ a: MAC.id, b: LINUX.id, paused: true });
    const held = await send(s, 'on a paused link');
    expect(held.body).toMatchObject({ state: 'approval', paused: true });
    expect((await answer(held.body.requestId)).body).toEqual({ ok: true, outcome: 'delivered', paused: true });
  });

  it('is refused between two owners, and nothing is stored', async () => {
    const s = await linked('send');
    const out = await send(s, 'to Alex', 'review@alex-box');
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ ok: false, error: expect.stringContaining('You cannot see an orchestrator called') });
    expect(storedMessages(s)).toBe(0);
    const right = await s.edBrowser.put('/api/fleet/respond/peers/rights').set(H).send({ from: MAC.id, to: ALEX_BOX.id, level: 'send' });
    expect(right.status).toBe(403);
    expect((s.db.prepare("SELECT COUNT(*) AS n FROM peer_rights WHERE to_key = ?").get(ALEX_BOX.id) as { n: number }).n).toBe(0);
  });

  it('refuses the admin secret on every mod route, and another person’s token', async () => {
    const s = await linked('send');
    expect((await send(s, 'x', 'Tester@ci-runner-01', 'sess-dev', SECRET)).status).toBe(403);
    expect((await send(s, 'x', 'Tester@ci-runner-01', 'sess-dev', s.alex.token)).status).toBe(403);
    expect((await request(s.app).get('/api/fleet/sessions/sess-dev/peers').set('X-Podium-Token', 'pdm_nope')).status).toBe(401);
  });

  it('refuses a session whose peers option is off, and an unknown session', async () => {
    const s = await linked('send');
    await devReport(s, { peers: false });
    expect((await send(s, 'x')).body.error).toContain("peers option");
    expect((await send(s, 'x', 'Tester@ci-runner-01', 'sess-none')).status).toBe(404);
  });

  it('refuses a message over the limit with the reason, never cut', async () => {
    const s = await linked('send');
    const admin = await adminAgent(s);
    expect((await admin.put('/api/admin/settings').set(HA).send({ peerMessaging: { maxChars: 10 } })).status).toBe(200);
    const out = await send(s, 'x'.repeat(11));
    expect(out.status).toBe(422);
    expect(out.body.error).toContain('10');
    expect(storedMessages(s)).toBe(0);
  });

  it('checks the body: to and text are strings', async () => {
    const s = await linked('send');
    expect((await request(s.app).post('/api/fleet/sessions/sess-dev/peers/messages').set('X-Podium-Token', s.ed.token).send({ to: 7, text: 'x' })).status).toBe(400);
    expect((await request(s.app).post('/api/fleet/sessions/sess-dev/peers/messages').set('X-Podium-Token', s.ed.token).send({ to: 'Tester@ci-runner-01' })).status).toBe(400);
  });

  it('answers a delivery result for an unknown id with 404, and checks the result', async () => {
    const s = await linked('send');
    const route = '/api/fleet/sessions/sess-tester/peers/deliveries/dlv_nope/result';
    expect((await request(s.app).post(route).set('X-Podium-Token', s.ed.token).send({ result: 'took' })).status).toBe(404);
    expect((await request(s.app).post(route).set('X-Podium-Token', s.ed.token).send({ result: 'eaten' })).status).toBe(400);
  });
});

describe('the flag going off (#412)', () => {
  it('drops what is held, makes every reply say peers: false, and refuses a send', async () => {
    const s = await linked('ask');
    await send(s, 'waiting for approval');
    s.fleet.features.setFeature(PEER_MESSAGING, false);
    const r = await testerReport(s);
    expect(r.body).toMatchObject({ peers: false, peerDeliveries: [], peerRequests: [] });
    expect((await send(s, 'later')).status).toBe(403);
    expect(logKinds(s)).toContain('peer_dropped');
    s.fleet.features.setFeature(PEER_MESSAGING, true);
    expect((await testerReport(s)).body.peerDeliveries).toEqual([]);
  });
});

describe('sessions ending and being deleted (#412)', () => {
  it('drops a held message when its receiver ends, and tells the sender', async () => {
    const s = await linked('ask');
    await send(s, 'held');
    await testerReport(s, { status: 'done', endReason: 'exit' });
    expect((await devReport(s)).body.peerDeliveries).toEqual([expect.objectContaining({ kind: 'notice' })]);
    expect(logKinds(s)).toContain('peer_dropped');
  });

  it('deletes a session’s messages with the session', async () => {
    const s = await linked('send');
    await send(s, 'kept until deleted');
    expect(storedMessages(s)).toBe(1);
    s.fleet.deleteSession('sess-tester');
    expect(storedMessages(s)).toBe(0);
  });
});

describe('access requests (#412)', () => {
  it('asks the owner, and the answer reaches the orchestrator that asked as a notice', async () => {
    const s = await linked('see');
    const route = '/api/fleet/sessions/sess-dev/peers/access';
    const asked = await request(s.app).post(route).set('X-Podium-Token', s.ed.token).send({ to: 'ci-runner-01', right: 'send', reason: 'I need the Linux tests run.' });
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ ok: true, state: 'asked', to: 'ci-runner-01' });
    const answer = await s.edBrowser.post(`/api/fleet/respond/peers/requests/${asked.body.requestId}`).set(H).send({ answer: 'allow' });
    expect(answer.body).toEqual({ ok: true, outcome: 'allowed' });
    expect((await devReport(s)).body.peerDeliveries).toEqual([expect.objectContaining({ kind: 'notice', text: expect.stringContaining('allowed') })]);
    expect(logKinds(s)).toEqual(expect.arrayContaining(['peer_access_requested', 'peer_right_accepted']));
  });

  it('answered from a session, says the level it applied, which can be higher than the request’s (#414)', async () => {
    const s = await linked('ask');
    const route = '/api/fleet/sessions/sess-dev/peers/access';
    const ask = (right: string) => request(s.app).post(route).set('X-Podium-Token', s.ed.token).send({ to: 'ci-runner-01', right, reason: 'Linux tests.' });
    const answer = (id: string, a: string) => request(s.app).post(`/api/fleet/sessions/sess-tester/peers/requests/${id}`).set('X-Podium-Token', s.ed.token).send({ answer: a });
    // Mac can already send to Linux with approval: allowing a request to see never lowers that.
    const see = await ask('see');
    expect((await answer(see.body.requestId, 'allow')).body).toEqual({ ok: true, outcome: 'allowed', level: 'ask' });
    // Nothing applied, no level.
    const declined = await ask('send');
    expect((await answer(declined.body.requestId, 'decline')).body).toEqual({ ok: true, outcome: 'declined' });
  });

  it('tells the orchestrator that asked the level it now has, not the one it asked for (#414)', async () => {
    const s = await linked('ask');
    const asked = await request(s.app).post('/api/fleet/sessions/sess-dev/peers/access').set('X-Podium-Token', s.ed.token).send({ to: 'ci-runner-01', right: 'see', reason: 'Linux tests.' });
    await s.edBrowser.post(`/api/fleet/respond/peers/requests/${asked.body.requestId}`).set(H).send({ answer: 'allow' });
    const [notice] = (await devReport(s)).body.peerDeliveries;
    expect(notice.text).toContain('can send, with approval');
    expect(notice.text).not.toContain('can see');
  });

  it('checks the right and the target, and refuses a machine it does not know', async () => {
    const s = await linked('see');
    const route = '/api/fleet/sessions/sess-dev/peers/access';
    const go = (body: object) => request(s.app).post(route).set('X-Podium-Token', s.ed.token).send(body);
    expect((await go({ to: 'ci-runner-01', right: 'admin' })).status).toBe(400);
    expect((await go({ right: 'see' })).status).toBe(400);
    expect((await go({ to: 'alex-box', right: 'see' })).status).toBe(404);
  });
});

describe('the owner’s routes (#412)', () => {
  it('need the flag and a person signed in, not the admin secret', async () => {
    const s = await linked('send');
    expect((await request(s.app).get('/api/fleet/respond/peers')).status).toBe(403);
    const admin = await signedIn(s, 'Admin', SECRET);
    expect((await admin.get('/api/fleet/respond/peers')).status).toBe(403);
    s.fleet.features.setFeature(PEER_MESSAGING, false);
    expect((await s.edBrowser.get('/api/fleet/respond/peers')).status).toBe(403);
  });

  it('let a browser sign in while only messaging needs it', async () => {
    const s = setup();
    expect((await request(s.app).get('/api/fleet/respond/me')).body.enabled).toBe(true);
  });

  it('list the owner’s reporters, rights, defaults, limits and requests', async () => {
    const s = await linked('send');
    const page = await s.edBrowser.get('/api/fleet/respond/peers');
    expect(page.body).toMatchObject({ enabled: true, owner: 'Ed', defaults: { trust: false, onRequest: 'ask', newSend: 'ask' }, limits: { server: { roundTrips: 10, perMinute: 6, maxChars: 20_000 } } });
    expect(page.body.reporters.map((r: { key: string }) => r.key).sort()).toEqual([LINUX.id, MAC.id].sort());
    expect(page.body.reporters.find((r: { key: string }) => r.key === MAC.id).live).toEqual([{ sessionId: 'sess-dev', name: 'dev', status: 'running', peers: true }]);
    expect(page.body.rights).toEqual([expect.objectContaining({ from: MAC.id, to: LINUX.id, level: 'send', paused: false })]);
  });

  it('give each reporter its state and last report, the same as Admin > Reporters (#415)', async () => {
    const s = await linked('send');
    const started = s.tick(0);
    s.tick(5 * 60_000);
    expect((await testerReport(s)).status).toBe(200);
    const page = (await s.edBrowser.get('/api/fleet/respond/peers')).body;
    expect(page).toMatchObject({ serverTime: started + 5 * 60_000, serverStartedAt: started });
    const of = (key: string) => page.reporters.find((r: { key: string }) => r.key === key);
    expect(of(MAC.id)).toMatchObject({ state: 'idle', lastSeenAt: started });
    expect(of(LINUX.id)).toMatchObject({ state: 'reporting', lastSeenAt: started + 5 * 60_000 });
    const admin = await adminAgent(s);
    const rows = (await admin.get('/api/admin/reporters').set(HA)).body.rows as { key: string; state: string; lastSeenAt: number; compat: string }[];
    for (const key of [MAC.id, LINUX.id]) {
      const row = rows.find((r) => r.key === key)!;
      expect([of(key).state, of(key).lastSeenAt, of(key).compat]).toEqual([row.state, row.lastSeenAt, row.compat]);
    }
  });

  it('name both reporters of a request by key as well as by machine, so two machines with one name stay apart (#415)', async () => {
    const s = await linked('see');
    const twin = { name: MAC.name, id: 'macmacmac002' };
    expect((await post(s, s.ed.token, report('Ed', 'sess-twin', 'twin', twin))).status).toBe(200);
    const admin = await adminAgent(s);
    const p = await admin.post(`/api/admin/reporters/${twin.id}/peers/propose`).set(HA).send({ to: LINUX.id, level: 'send' });
    expect(p.status).toBe(202);
    const page = await s.edBrowser.get('/api/fleet/respond/peers');
    expect(page.body.requests).toEqual([
      expect.objectContaining({ id: p.body.requestId, kind: 'proposal', fromKey: twin.id, toKey: LINUX.id, from: { machine: 'ed-mbp', name: null }, to: { machine: 'ci-runner-01', name: null }, messageId: null }),
    ]);
    // The mod's copy keeps the protocol's shape: machines only.
    const mod = (await testerReport(s)).body.peerRequests;
    expect(mod).toEqual([expect.objectContaining({ id: p.body.requestId })]);
    expect(mod[0]).not.toHaveProperty('fromKey');
  });

  it('pause a link, which holds a message, and resume it, which lets it go', async () => {
    const s = await linked('send');
    expect((await s.edBrowser.put('/api/fleet/respond/peers/links').set(H).send({ a: MAC.id, b: LINUX.id, paused: true })).status).toBe(200);
    const sent = await send(s, 'held by the pause');
    expect(sent.body.paused).toBe(true);
    expect((await testerReport(s)).body.peerDeliveries).toEqual([]);
    await s.edBrowser.put('/api/fleet/respond/peers/links').set(H).send({ a: MAC.id, b: LINUX.id, paused: false });
    expect((await testerReport(s)).body.peerDeliveries.map((d: { id: string }) => d.id)).toEqual([sent.body.id]);
    expect(logKinds(s)).toEqual(expect.arrayContaining(['peer_right_paused', 'peer_right_resumed']));
  });

  it('remove a link, which drops what waits on it', async () => {
    const s = await linked('ask');
    await send(s, 'waiting');
    expect((await s.edBrowser.delete('/api/fleet/respond/peers/links').set(H).send({ a: MAC.id, b: LINUX.id })).status).toBe(200);
    expect(logKinds(s)).toEqual(expect.arrayContaining(['peer_right_removed', 'peer_dropped']));
    expect((await send(s, 'again')).status).toBe(404);
  });

  it('set the defaults, with limits no looser than the Admin’s', async () => {
    const s = await linked('send');
    const ok = await s.edBrowser.put('/api/fleet/respond/peers/defaults').set(H).send({ trust: true, limits: { roundTrips: 3 } });
    expect(ok.status).toBe(200);
    expect(ok.body.defaults).toMatchObject({ trust: true, limits: { roundTrips: 3 } });
    expect((await s.edBrowser.put('/api/fleet/respond/peers/defaults').set(H).send({ limits: { roundTrips: 11 } })).status).toBe(400);
    expect(logKinds(s)).toContain('peer_defaults_changed');
  });

  it('check their bodies', async () => {
    const s = await linked('send');
    const b = s.edBrowser;
    expect((await b.put('/api/fleet/respond/peers/rights').set(H).send({ from: MAC.id, to: LINUX.id, level: 'all' })).status).toBe(400);
    expect((await b.put('/api/fleet/respond/peers/rights').set(H).send({ from: 1, to: LINUX.id, level: 'see' })).status).toBe(400);
    expect((await b.put('/api/fleet/respond/peers/links').set(H).send({ a: MAC.id, b: LINUX.id })).status).toBe(400);
    expect((await b.delete('/api/fleet/respond/peers/links').set(H).send({ a: MAC.id })).status).toBe(400);
    expect((await b.post('/api/fleet/respond/peers/requests/prq_x').set(H).send({ answer: 'maybe' })).status).toBe(400);
    expect((await b.post('/api/fleet/respond/peers/requests/prq_x').set(H).send({ answer: 'allow' })).status).toBe(404);
    expect((await b.get('/api/fleet/respond/peers/conversations?range=1y')).status).toBe(400);
    // A change without the cross-site header is refused, as every respond route is.
    expect((await b.put('/api/fleet/respond/peers/rights').send({ from: MAC.id, to: LINUX.id, level: 'see' })).status).toBe(403);
  });

  it('read conversations: counts for the owner, the text only for its owner or an Admin', async () => {
    const s = await linked('send');
    await send(s, 'readable by Ed');
    const list = await s.edBrowser.get('/api/fleet/respond/peers/conversations?range=24h');
    expect(list.body.conversations).toEqual([expect.objectContaining({ messages: 1, owner: 'Ed' })]);
    expect(JSON.stringify(list.body)).not.toContain('readable by Ed');
    const [a, b] = ['sess-dev', 'sess-tester'];
    const mine = await s.edBrowser.get(`/api/fleet/respond/peers/conversations/${a}/${b}`);
    expect(mine.body.messages).toEqual([expect.objectContaining({ text: 'readable by Ed', state: 'ready', from: expect.objectContaining({ name: 'dev' }) })]);
    const alex = await signedIn(s, 'Alex', s.alex.token);
    expect((await alex.get(`/api/fleet/respond/peers/conversations/${a}/${b}`)).status).toBe(403);
    expect((await request(s.app).get(`/api/fleet/respond/peers/conversations/${a}/${b}`)).status).toBe(403);
    expect((await s.edBrowser.get(`/api/fleet/respond/peers/conversations/${a}/sess-none`)).status).toBe(404);
    const admin = await signedIn(s, 'Admin', SECRET);
    expect((await admin.get(`/api/fleet/respond/peers/conversations/${a}/${b}`)).status).toBe(200);
  });
});

describe('Traffic’s open read (#412)', () => {
  it('shows who talks and the counts to anyone, and nothing with the flag off', async () => {
    const s = await linked('send');
    await send(s, 'counted');
    const t = await request(s.app).get('/api/fleet/peers/traffic');
    expect(t.body.enabled).toBe(true);
    expect(t.body.conversations).toEqual([expect.objectContaining({ messages: 1, state: 'active' })]);
    // How long a conversation is kept, so Traffic can name the days, and the server's clock to time them by (#417).
    expect(t.body.retainDays).toBe(30);
    expect(t.body.serverTime).toEqual(expect.any(Number));
    expect((await request(s.app).get('/api/fleet/peers/traffic?range=forever')).status).toBe(400);
    s.fleet.features.setFeature(PEER_MESSAGING, false);
    expect((await request(s.app).get('/api/fleet/peers/traffic')).body).toEqual({ enabled: false, conversations: [] });
  });
});

describe('the Admin’s side (#412)', () => {
  it('reads and sets the limits and the retention, validated and logged', async () => {
    const s = setup();
    const admin = await adminAgent(s);
    expect((await admin.get('/api/admin/settings')).body.peerMessaging).toEqual({ roundTrips: 10, perMinute: 6, maxChars: 20_000, retainDays: 30 });
    const ok = await admin.put('/api/admin/settings').set(HA).send({ peerMessaging: { roundTrips: 4, retainDays: 7 } });
    expect(ok.body).toEqual({ ok: true, peerMessaging: { roundTrips: 4, perMinute: 6, maxChars: 20_000, retainDays: 7 } });
    expect((await admin.put('/api/admin/settings').set(HA).send({ peerMessaging: { roundTrips: 0 } })).body.error).toBe('Round trips must be a whole number from 1 to 100');
    expect((await admin.put('/api/admin/settings').set(HA).send({ peerMessaging: 3 })).status).toBe(400);
    expect(logKinds(s)).toContain('peer_limits_changed');
  });

  it('proposes a right, which applies only when the owner accepts it', async () => {
    const s = await linked('see');
    const admin = await adminAgent(s);
    const p = await admin.post(`/api/admin/reporters/${LINUX.id}/peers/propose`).set(HA).send({ to: MAC.id, level: 'send' });
    expect(p.status).toBe(202);
    const view = await admin.get(`/api/admin/reporters/${LINUX.id}/peers`);
    expect(view.body.requests).toEqual([expect.objectContaining({ id: p.body.requestId, kind: 'proposal', level: 'send' })]);
    expect(view.body.effective).toEqual(expect.arrayContaining([{ from: LINUX.id, to: MAC.id, level: 'none', paused: false }]));
    // Admin > Reporters' Grid matches a proposal to its cell by reporter key, as My reporters does (#416).
    expect(view.body.requests[0]).toMatchObject({ fromKey: LINUX.id, toKey: MAC.id, messageId: null });
    const ok = await s.edBrowser.post(`/api/fleet/respond/peers/requests/${p.body.requestId}`).set(H).send({ answer: 'allow' });
    expect(ok.body.outcome).toBe('allowed');
    expect((await admin.get(`/api/admin/reporters/${LINUX.id}/peers`)).body.effective).toEqual(expect.arrayContaining([{ from: LINUX.id, to: MAC.id, level: 'send', paused: false }]));
    expect(logKinds(s)).toEqual(expect.arrayContaining(['peer_right_proposed', 'peer_right_accepted']));
    expect((await admin.post(`/api/admin/reporters/${LINUX.id}/peers/propose`).set(HA).send({ to: MAC.id, level: 'all' })).status).toBe(400);
    expect((await admin.post(`/api/admin/reporters/${LINUX.id}/peers/propose`).set(HA).send({ from: MAC.id, to: MAC.id, level: 'see' })).status).toBe(400);
    expect((await admin.post(`/api/admin/reporters/${LINUX.id}/peers/propose`).set(HA).send({ to: ALEX_BOX.id, level: 'see' })).status).toBe(403);
    expect((await admin.get('/api/admin/reporters/nope/peers')).status).toBe(404);
  });

  it('reads every pair of the owner’s reporters in one read, with the owner’s Trust my own reporters (#416)', async () => {
    const s = await linked('see');
    const twin = { name: 'build-pi', id: 'pi0pi0pi0001' };
    expect((await post(s, s.ed.token, report('Ed', 'sess-pi', 'arm', twin))).status).toBe(200);
    const admin = await adminAgent(s);
    // A proposal between two other reporters of Ed's shows on this reporter's read too: the Grid draws every pair.
    const p = await admin.post(`/api/admin/reporters/${twin.id}/peers/propose`).set(HA).send({ to: LINUX.id, level: 'see' });
    expect(p.status).toBe(202);
    const view = (await admin.get(`/api/admin/reporters/${MAC.id}/peers`)).body;
    expect(view.trust).toBe(false);
    expect(view.rights).toEqual(expect.arrayContaining([expect.objectContaining({ from: MAC.id, to: LINUX.id, level: 'see' })]));
    // The effective levels stay this reporter's pairs, for Pause all links: the Grid reads levels from the rights.
    const pairs = (view.effective as { from: string; to: string }[]).map((e) => `${e.from}>${e.to}`);
    expect(pairs.sort()).toEqual([`${LINUX.id}>${MAC.id}`, `${MAC.id}>${LINUX.id}`, `${MAC.id}>${MAC.id}`, `${MAC.id}>${twin.id}`, `${twin.id}>${MAC.id}`].sort());
    expect(view.requests).toEqual([expect.objectContaining({ id: p.body.requestId, fromKey: twin.id, toKey: LINUX.id })]);
    expect((await s.edBrowser.put('/api/fleet/respond/peers/defaults').set(H).send({ trust: true })).status).toBe(200);
    expect((await admin.get(`/api/admin/reporters/${MAC.id}/peers`)).body.trust).toBe(true);
  });

  it('pauses all of a reporter’s links at once, and removes a link at once', async () => {
    const s = await linked('send');
    const admin = await adminAgent(s);
    expect((await admin.put(`/api/admin/reporters/${MAC.id}/peers/pause`).set(HA).send({ paused: true })).status).toBe(200);
    expect((await send(s, 'paused by the Admin')).body.paused).toBe(true);
    expect((await admin.put(`/api/admin/reporters/${MAC.id}/peers/pause`).set(HA).send({ paused: 'yes' })).status).toBe(400);
    expect((await admin.delete(`/api/admin/reporters/${MAC.id}/peers/${LINUX.id}`).set(HA)).status).toBe(200);
    expect((await send(s, 'after the removal')).status).toBe(404);
  });

  it('reads the conversations and their text', async () => {
    const s = await linked('send');
    await send(s, 'read by the Admin');
    const admin = await adminAgent(s);
    expect((await admin.get('/api/admin/peers/conversations')).body.conversations).toEqual([expect.objectContaining({ messages: 1 })]);
    expect((await admin.get('/api/admin/peers/conversations?range=live')).body.conversations).toHaveLength(1);
    expect((await admin.get('/api/admin/peers/conversations?range=24h')).body.conversations).toHaveLength(1);
    expect((await admin.get('/api/admin/peers/conversations?range=1y')).status).toBe(400);
    expect((await admin.get('/api/admin/peers/conversations/sess-dev/sess-tester')).body.messages).toEqual([expect.objectContaining({ text: 'read by the Admin' })]);
    expect((await admin.get('/api/admin/peers/conversations/sess-dev/sess-none')).status).toBe(404);
    // As the browser's read, `live` is the default: once both ends have ended, only a time range lists it.
    await devReport(s, { status: 'done', endReason: 'exit' });
    await testerReport(s, { status: 'done', endReason: 'exit' });
    expect((await admin.get('/api/admin/peers/conversations')).body.conversations).toEqual([]);
    expect((await admin.get('/api/admin/peers/conversations?range=24h')).body.conversations).toHaveLength(1);
  });
});

describe('retention (#412)', () => {
  it('deletes a conversation quiet for longer than the Admin keeps it', async () => {
    const s = await linked('send');
    await send(s, 'old news');
    s.tick(31 * 86_400_000);
    expect(s.fleet.retain().peerMessages).toBe(1);
    expect(storedMessages(s)).toBe(0);
  });
});
