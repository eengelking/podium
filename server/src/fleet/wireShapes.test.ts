// The JSON an installed reporter or an open console parses, pinned by its exact keys and the type of each value, never by a volatile value (#1296). A reporter of an older
// release keeps running against a newer server (SPEC 6.8, DECISIONS 18 and 55), so a key that is renamed, dropped or retyped in a refactor of the Direct Message storage breaks it
// with no test to say so. Covers the report reply (`peers`, `peerDeliveries`, `peerRequests`, `adminNotices`, `deliveries`), the peer routes a reporter calls, the browser's
// conversation routes, and the body limit of the reporter's message routes.
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { createFleetRouter } from './routes.js';
import { createLogger } from '../logging/logger.js';
import { createAdminRouter } from '../admin/adminRouter.js';
import { Lockout } from './lockout.js';
import { createRespondBridge } from './respondBridge.js';
import type { Report } from './protocol.js';
import { fixtureReport } from './testing.js';
import { ACTIVITY_FEED, PEER_MESSAGING, RESPOND } from '../storage/features.js';

const SECRET = 'admin-secret-for-the-wire-tests';
const H = { 'X-Podium-Respond': '1' };
const CH = '/api/fleet/respond/chat';
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

/** A JSON value as its shape: an object by its keys, each value by its type (`null` is its own type), an array by the shape of each item. */
function shape(v: unknown): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.map(shape);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, shape(x)]));
  return typeof v;
}
const S = 'string';
const N = 'number';
const B = 'boolean';
const NIL = 'null';

async function setup() {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const storage = openSqliteStorage(':memory:', now());
  const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, now);
  const people = storage.people;
  const lockout = new Lockout(now);
  const respondBridge = createRespondBridge();
  const logger = createLogger({ format: 'json', level: 'debug', write: () => {} });
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: SECRET, people, reporters: storage.reporters, lockout, respondBridge, logger }));
  app.use('/api/admin', createAdminRouter({ secret: SECRET, storage, people, reporters: storage.reporters, peers: fleet.peers, chat: fleet.chat.settings, features: fleet.features, lockout, respondBridge, now, log: () => {} }));
  await fleet.init();
  closers.push(() => fleet.close());
  await fleet.features.setFeature(PEER_MESSAGING, true);
  await fleet.features.setFeature(RESPOND, true);
  await fleet.features.setFeature(ACTIVITY_FEED, true);
  const ed = await people.createPerson('Ed');
  const alex = await people.createPerson('Alex');
  return { app, people, ed, alex };
}
type S0 = Awaited<ReturnType<typeof setup>>;

const ACCEPTS = ['message', 'command', 'question', 'plan-approve', 'plan-feedback', 'permission'] as const;
const MAC = { name: 'ed-mbp', id: 'macmacmac001' };
const LINUX = { name: 'ci-runner-01', id: 'lnxlnxlnx001' };
const BOX = { name: 'alex-box', id: 'alxalxalx001' };

function report(userName: string, sid: string, name: string, machine: { name: string; id: string }): Report {
  const r = fixtureReport();
  r.session = { ...r.session, id: sid, name, status: 'waiting', waitReason: 'input', peers: true, respond: { level: 'everything', accepts: [...ACCEPTS], limits: [] } };
  r.userName = userName;
  r.machine = { ...machine, os: 'macOS 27.0.1' };
  r.adminNotices = true;
  return r;
}
const post = (s: S0, token: string, r: Report) => request(s.app).post('/api/fleet/report').set('X-Podium-Token', token).send(r);
const dev = (s: S0) => post(s, s.ed.token, report('Ed', 'sess-dev', 'dev', MAC));
const tester = (s: S0) => post(s, s.ed.token, report('Ed', 'sess-tester', 'Tester', LINUX));
const alexOne = (s: S0) => post(s, s.alex.token, report('Alex', 'sess-alex', 'review', BOX));
const asEd = (s: S0) => ({ 'X-Podium-Token': s.ed.token });

async function signedIn(s: S0, name: string, token: string) {
  const agent = request.agent(s.app);
  expect((await agent.post('/api/fleet/respond/sign-in').set(H).send({ name, token })).status).toBe(200);
  return agent;
}
async function world() {
  const s = await setup();
  for (const r of [dev, tester, alexOne]) expect((await r(s)).status).toBe(200);
  return { ...s, edB: await signedIn(s, 'Ed', s.ed.token), alexB: await signedIn(s, 'Alex', s.alex.token) };
}

/** The reply to a report, as a reporter sees it: every key, with the arrays a test fills in. `serverBuild` is the build the server was started with, a string or null. */
const REPLY = {
  ok: B, serverTime: N, ackedEvents: N, sessionId: S, liveSessions: N, serverVersion: S, reporterSupport: { min: S, max: S }, reporterCompat: S,
  watch: [], watchOutput: [], watchBackground: [], respond: B, deliveries: [], diffs: [], peers: B, peerDeliveries: [], peerRequests: [],
  recording: { state: S, consent: { admin: B, chosen: B, owner: B }, loops: [], limit: NIL, startedBy: NIL, startedAt: NIL, stoppedBy: NIL, stoppedAt: NIL, keptUntil: NIL, bytes: N },
};
const replyShape = (body: Record<string, unknown>): unknown => {
  const { serverBuild, ...rest } = body;
  expect(serverBuild === null || typeof serverBuild === 'string', 'serverBuild is a string or null').toBe(true);
  return shape(rest);
};
const reply = (over: Record<string, unknown>) => ({ ...REPLY, ...over });

describe('the report reply an installed reporter parses (#1296)', () => {
  it('says peers, and carries no delivery, request or notice when there is none', async () => {
    const w = await world();
    const r = await dev(w);
    expect(replyShape(r.body)).toEqual(REPLY);
    expect(r.body.peers).toBe(true);
    expect(r.body).not.toHaveProperty('adminNotices');
  });

  it('hands a message from another orchestrator, and a notice, as peerDeliveries of these shapes', async () => {
    const w = await world();
    expect((await w.edB.put('/api/fleet/respond/peers/rights').set(H).send({ from: MAC.id, to: LINUX.id, level: 'send' })).status).toBe(200);
    expect((await request(w.app).post('/api/fleet/sessions/sess-dev/peers/messages').set(asEd(w)).send({ to: 'Tester@ci-runner-01', text: 'hi there' })).status).toBe(202);
    const withMessage = await tester(w);
    expect(replyShape(withMessage.body)).toEqual(reply({ peerDeliveries: [{ id: S, kind: S, at: N, from: { name: S, machine: S, owner: S, id: S }, text: S }] }));
    expect(withMessage.body.peerDeliveries[0].kind).toBe('message');
    const took = await request(w.app).post(`/api/fleet/sessions/sess-tester/peers/deliveries/${withMessage.body.peerDeliveries[0].id}/result`).set(asEd(w)).send({ result: 'took' });
    expect(took.status).toBe(200);
    // A notice has no sender: the answer to an access request the agent made.
    expect((await request(w.app).post('/api/fleet/sessions/sess-tester/peers/access').set(asEd(w)).send({ to: 'ed-mbp', right: 'send', reason: 'Need to answer.' })).status).toBe(202);
    const asked = await dev(w);
    const open = (asked.body.peerRequests as { id: string }[])[0]!;
    expect((await request(w.app).post(`/api/fleet/sessions/sess-dev/peers/requests/${open.id}`).set(asEd(w)).send({ answer: 'allow' })).status).toBe(200);
    const withNotice = await tester(w);
    expect(replyShape(withNotice.body)).toEqual(reply({ peerDeliveries: [{ id: S, kind: S, at: N, from: NIL, text: S }] }));
    expect(withNotice.body.peerDeliveries[0].kind).toBe('notice');
  });

  it('lists an access request and a person\'s message waiting for the owner as peerRequests of these shapes', async () => {
    const w = await world();
    expect((await request(w.app).post('/api/fleet/sessions/sess-tester/peers/access').set(asEd(w)).send({ to: 'ed-mbp', right: 'send', reason: 'Need to answer.' })).status).toBe(202);
    const access = await dev(w);
    expect(replyShape(access.body)).toEqual(reply({ peerRequests: [{ id: S, kind: S, at: N, from: { machine: S, name: S }, to: { machine: S, name: NIL }, level: S, by: S, reason: S, text: NIL }] }));
    expect(access.body.peerRequests[0].kind).toBe('access');
    expect((await w.edB.post(`${CH}/dm/me/sess-alex/messages`).set(H).send({ text: 'may I ask' })).status).toBe(202);
    const message = await alexOne(w);
    expect(replyShape(message.body)).toEqual(reply({ peerRequests: [{ id: S, kind: S, at: N, from: { machine: S, name: S }, to: { machine: S, name: S }, level: NIL, by: S, reason: NIL, text: S }] }));
    expect(message.body.peerRequests[0].kind).toBe('message');
  });

  it('hands a console message, a channel mention and a conversation message as deliveries, with chat, channel and convo where each has them', async () => {
    const w = await world();
    const fresh = async () => (await tester(w)).body.deliveries as Record<string, unknown>[];
    expect((await w.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: 'own agent' })).status).toBe(202);
    const own = await fresh();
    expect(own.map(shape)).toEqual([{ id: S, askId: NIL, by: S, at: N, kind: S, text: S, chat: B, via: S }]);
    // The reporter branches on these values (plugin/core/peers.ts): where a message was written decides its frame and where the agent answers.
    expect(own[0]).toMatchObject({ kind: 'message', via: 'chat', chat: true, text: 'own agent' });
    expect((await w.edB.post(`${CH}/channels/general/messages`).set(H).send({ text: '@Tester@ci-runner-01 look' })).status).toBe(201);
    const mention = (await fresh()).find((d) => 'channel' in d)!;
    expect(shape(mention)).toEqual({ id: S, askId: NIL, by: S, at: N, kind: S, text: S, channel: S, via: S });
    expect(mention).toMatchObject({ kind: 'message', via: 'channel', channel: 'General' });
    expect(mention).not.toHaveProperty('chat');
    const open = await w.edB.post(`${CH}/conversations`).set(H).send({ members: [{ kind: 'person', name: 'Alex' }, { kind: 'agent', sessionId: 'sess-tester' }], text: 'first' });
    expect(open.status).toBe(201);
    const convo = (await fresh()).find((d) => 'convo' in d)!;
    expect(shape(convo)).toEqual({ id: S, askId: NIL, by: S, at: N, kind: S, text: S, chat: B, convo: S, via: S });
    expect(convo).toMatchObject({ kind: 'message', via: 'chat', chat: true, convo: open.body.conversation.id });
  });

  it('tells a person\'s sessions an Admin read their group, as adminNotices of id, at and text', async () => {
    const w = await world();
    const admin = await signedIn(w, 'Admin', SECRET);
    expect((await admin.get(`${CH}/channels/group/messages?owner=Ed`)).status).toBe(200);
    const r = await dev(w);
    expect(replyShape(r.body)).toEqual(reply({ adminNotices: [{ id: S, at: N, text: S }] }));
  });
});

describe('the peer routes a reporter calls (#1296)', () => {
  it('answers a send, the list, a result, an access request and an answer in these shapes', async () => {
    const w = await world();
    expect((await w.edB.put('/api/fleet/respond/peers/rights').set(H).send({ from: MAC.id, to: LINUX.id, level: 'send' })).status).toBe(200);
    const sent = await request(w.app).post('/api/fleet/sessions/sess-dev/peers/messages').set(asEd(w)).send({ to: 'Tester@ci-runner-01', text: 'hi there' });
    expect(sent.status).toBe(202);
    expect(shape(sent.body)).toEqual({ ok: B, id: S, state: S, paused: B, approvalWhy: NIL, requestId: NIL, to: { name: S, machine: S }, roundTrips: { used: N, cap: N } });
    const list = await request(w.app).get('/api/fleet/sessions/sess-dev/peers').set(asEd(w));
    expect(shape(list.body)).toEqual({ ok: B, peers: [{ address: S, id: S, name: S, machine: S, os: S, project: S, status: S, level: S, paused: B }], leftOut: [], people: [] });
    const handed = (await tester(w)).body.peerDeliveries[0] as { id: string };
    const result = await request(w.app).post(`/api/fleet/sessions/sess-tester/peers/deliveries/${handed.id}/result`).set(asEd(w)).send({ result: 'took' });
    expect([result.status, shape(result.body)]).toEqual([200, { ok: B }]);
    const access = await request(w.app).post('/api/fleet/sessions/sess-tester/peers/access').set(asEd(w)).send({ to: 'ed-mbp', right: 'send', reason: 'Need to answer.' });
    expect([access.status, shape(access.body)]).toEqual([202, { ok: B, state: S, requestId: S, to: S }]);
    const open = (await dev(w)).body.peerRequests[0] as { id: string };
    const answer = await request(w.app).post(`/api/fleet/sessions/sess-dev/peers/requests/${open.id}`).set(asEd(w)).send({ answer: 'allow' });
    expect([answer.status, shape(answer.body)]).toEqual([200, { ok: B, outcome: S, level: S }]);
  });

  it('answers a refusal as ok false and an error, with the path of the field when a field is the fault', async () => {
    const w = await world();
    const bad = await request(w.app).post('/api/fleet/sessions/sess-dev/peers/messages').set(asEd(w)).send({ to: 7, text: 'x' });
    expect([bad.status, shape(bad.body)]).toEqual([400, { ok: B, error: S, path: S }]);
    const none = await request(w.app).post('/api/fleet/sessions/sess-dev/peers/messages').set(asEd(w)).send({ to: 'Nobody@nowhere', text: 'x' });
    expect([none.status, shape(none.body)]).toEqual([404, { ok: B, error: S }]);
  });

  it('answers an agent\'s post in a channel and in a conversation with its id and time', async () => {
    const w = await world();
    const open = await w.edB.post(`${CH}/conversations`).set(H).send({ members: [{ kind: 'person', name: 'Alex' }, { kind: 'agent', sessionId: 'sess-tester' }], text: 'first' });
    await tester(w);
    const answer = await request(w.app).post(`/api/fleet/sessions/sess-tester/chat/conversations/${open.body.conversation.id}/messages`).set(asEd(w)).send({ text: 'agent answer' });
    expect([answer.status, shape(answer.body)]).toEqual([201, { ok: B, id: S, createdAt: N }]);
    // An agent posts in a channel only where a person called it in.
    expect((await w.edB.post(`${CH}/channels/general/messages`).set(H).send({ text: '@Tester@ci-runner-01 look' })).status).toBe(201);
    const channel = await request(w.app).post('/api/fleet/sessions/sess-tester/chat/channels/general/messages').set(asEd(w)).send({ text: 'agent post' });
    expect([channel.status, shape(channel.body)]).toEqual([201, { ok: B, id: S, createdAt: N }]);
  });
});

describe('the browser\'s conversation routes (#1296)', () => {
  const AGENT = { kind: S, name: S, you: B, addedBy: S, address: S, sessionId: S };
  const ME = { kind: S, name: S, you: B, addedBy: NIL, address: S, sessionId: NIL };
  const OTHER = { kind: S, name: S, you: B, addedBy: S, address: S, sessionId: NIL };
  const info = (members: unknown[]) => ({ id: S, thread: S, members, hasAgent: B, unread: N, mentions: N, messages: N, lastAt: N, adminReading: [] });
  const message = (over: Record<string, unknown> = {}) => ({ id: S, author: { kind: S, name: S, you: B }, text: S, createdAt: N, editedAt: NIL, deletedAt: NIL, replyTo: NIL, canChange: B, changeWhy: NIL, deliveries: [], ...over });
  const toAgent = { kind: S, name: S, named: B, state: S };

  it('answers the list of people, an open, a page, a send, an add, a ping and a leave in these shapes', async () => {
    const w = await world();
    const people = await w.edB.get(`${CH}/people`);
    expect([people.status, shape(people.body)]).toEqual([200, { ok: B, people: [{ name: S, conversation: NIL }] }]);
    const open = await w.edB.post(`${CH}/conversations`).set(H).send({ members: [{ kind: 'person', name: 'Alex' }, { kind: 'agent', sessionId: 'sess-tester' }], text: 'first' });
    expect([open.status, shape(open.body)]).toEqual([201, { ok: B, created: B, conversation: info([AGENT, ME, OTHER]), message: message({ canChange: B, changeWhy: S, deliveries: [toAgent] }), skipped: [] }]);
    const id = open.body.conversation.id as string;
    const page = await w.edB.get(`${CH}/conversations/${id}/messages`);
    expect([page.status, shape(page.body)]).toEqual([200, { ok: B, conversation: info([AGENT, ME, OTHER]), messages: [message({ changeWhy: S, deliveries: [toAgent] })], older: NIL, total: N, adminReads: [] }]);
    const sent = await w.edB.post(`${CH}/conversations/${id}/messages`).set(H).send({ text: 'second' });
    expect([sent.status, shape(sent.body)]).toEqual([201, { ok: B, message: message({ changeWhy: S, deliveries: [toAgent] }), skipped: [] }]);
    await w.people.createPerson('Sam');
    const added = await w.edB.post(`${CH}/conversations/${id}/members`).set(H).send({ members: [{ kind: 'person', name: 'Sam' }] });
    expect([added.status, shape(added.body)]).toEqual([200, { ok: B, conversation: info([AGENT, ME, OTHER, OTHER]) }]);
    const admins = (await w.people.allGroups()).find((g) => g.name === 'Administrators')!;
    const root = await signedIn(w, 'Root', (await w.people.createPerson('Root', admins.id)).token);
    const ping = await root.post(`${CH}/conversations/${id}/reading`).set(H);
    expect([ping.status, shape(ping.body)]).toEqual([200, { ok: B }]);
    const left = await w.edB.delete(`${CH}/conversations/${id}/members/me`).set(H);
    expect([left.status, shape(left.body)]).toEqual([200, { ok: B, deleted: B }]);
  });

  it('answers an edit and a delete of a person\'s own message, and the refusal of a change, in these shapes', async () => {
    const w = await world();
    const open = await w.edB.post(`${CH}/conversations`).set(H).send({ members: [{ kind: 'person', name: 'Alex' }], text: 'first' });
    const id = open.body.conversation.id as string;
    const mid = open.body.message.id as string;
    const edited = await w.edB.patch(`${CH}/conversations/${id}/messages/${mid}`).set(H).send({ text: 'first, edited' });
    expect([edited.status, shape(edited.body)]).toEqual([200, { ok: B, message: message({ editedAt: N }) }]);
    const gone = await w.edB.delete(`${CH}/conversations/${id}/messages/${mid}`).set(H);
    expect([gone.status, shape(gone.body)]).toEqual([200, { ok: B, message: message({ editedAt: N, deletedAt: N }) }]);
    const again = await w.edB.delete(`${CH}/conversations/${id}/messages/${mid}`).set(H);
    expect([again.status, shape(again.body)]).toEqual([409, { ok: B, error: S, reason: S }]);
  });
});

describe('the body limit of a reporter\'s message routes (#1296)', () => {
  const REFUSED = { ok: false, error: 'body over 512kb', path: '$' };

  it('refuses a body over 128 KB with 413 on the peer message route and the channel post, in the words of the 512 KB limit of the report route', async () => {
    const w = await world();
    const peer = (n: number) => request(w.app).post('/api/fleet/sessions/sess-dev/peers/messages').set(asEd(w)).send({ to: 'Tester@ci-runner-01', text: 'x'.repeat(n) });
    const channel = (n: number) => request(w.app).post('/api/fleet/sessions/sess-tester/chat/channels/general/messages').set(asEd(w)).send({ text: 'x'.repeat(n) });
    for (const over of [await peer(131_100), await channel(131_100)]) expect([over.status, over.body]).toEqual([413, REFUSED]);
    // Under the limit the body is read and the message is judged by its own limit instead.
    for (const under of [await peer(130_000), await channel(130_000)]) expect([under.status, shape(under.body)]).toEqual([422, { ok: B, error: S }]);
  });
});
