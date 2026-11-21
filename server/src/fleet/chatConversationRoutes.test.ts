// Conversations of people and agents (#1278, DECISIONS 74): a person writes to a person who has no orchestrator running, who finds it in Chat; the same members open one
// conversation; an Admin and a stranger cannot read a conversation of people; an Admin reads one with an agent in it, recorded, and a person may add their own agent.
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

const SECRET = 'admin-secret-for-the-conversation-tests';
const H = { 'X-Podium-Respond': '1' };
const CH = '/api/fleet/respond/chat';
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

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
  return { app, fleet, people, ed, alex, tick: (ms: number) => (clock += ms), now, storage };
}
type S = Awaited<ReturnType<typeof setup>>;

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
const post = (s: S, token: string, r: Report) => request(s.app).post('/api/fleet/report').set('X-Podium-Token', token).send(r);
const dev = (s: S) => post(s, s.ed.token, report('Ed', 'sess-dev', 'dev', MAC));
const tester = (s: S) => post(s, s.ed.token, report('Ed', 'sess-tester', 'Tester', LINUX));
const alexOne = (s: S) => post(s, s.alex.token, report('Alex', 'sess-alex', 'review', BOX));

async function signedIn(s: S, name: string, token: string) {
  const agent = request.agent(s.app);
  expect((await agent.post('/api/fleet/respond/sign-in').set(H).send({ name, token })).status).toBe(200);
  return agent;
}
type B = ReturnType<typeof request.agent>;

async function world() {
  const s = await setup();
  expect((await dev(s)).status).toBe(200);
  expect((await tester(s)).status).toBe(200);
  expect((await alexOne(s)).status).toBe(200);
  return { ...s, edB: await signedIn(s, 'Ed', s.ed.token), alexB: await signedIn(s, 'Alex', s.alex.token) };
}


const logRows = async (s: S) => (await s.people.listLog({ page: 1, pageSize: 200 })).rows;
const OPEN = (b: B, members: unknown, text?: string) => b.post(`${CH}/conversations`).set(H).send({ members, ...(text === undefined ? {} : { text }) });
const page = (b: B, id: string) => b.get(`${CH}/conversations/${id}/messages`);
const person = (name: string) => ({ kind: 'person', name });

describe('a conversation of people', () => {
  it('lets a person write to a person who has no orchestrator running, who finds it in Chat with an unread count', async () => {
    const w = await world();
    const sam = await w.people.createPerson('Sam');
    const samB = await signedIn(w, 'Sam', sam.token);
    const res = await OPEN(w.edB, [person('Sam')], 'hello Sam');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, created: true, conversation: { hasAgent: false, messages: 1 }, message: { text: 'hello Sam', author: { kind: 'person', name: 'Ed', you: true }, canChange: true } });
    const id = res.body.conversation.id as string;
    const ov = (await samB.get(CH)).body;
    expect(ov.conversations).toHaveLength(1);
    expect(ov.conversations[0]).toMatchObject({ id, unread: 1, hasAgent: false });
    expect(ov.conversations[0].members.map((m: { name: string; you: boolean }) => [m.name, m.you])).toEqual([['Ed', false], ['Sam', true]]);
    const read = await page(samB, id);
    expect(read.status).toBe(200);
    expect(read.body.messages.map((m: { text: string; author: { you: boolean } }) => [m.text, m.author.you])).toEqual([['hello Sam', false]]);
    const marked = await samB.post(`${CH}/read`).set(H).send({ thread: `convo:${id}`, upTo: null });
    expect(marked.body).toMatchObject({ ok: true, unread: 0 });
    expect(JSON.stringify((await samB.get(CH)).body.conversations)).not.toContain('hello Sam');
  });

  it('answers the same conversation for the same members, in any order, and lists a person even when they have never signed in', async () => {
    const w = await world();
    const a = await OPEN(w.edB, [person('Alex')]);
    expect(a.status).toBe(201);
    const b = await OPEN(w.alexB, [person('Ed')]);
    expect(b.status).toBe(200);
    expect(b.body.conversation.id).toBe(a.body.conversation.id);
    const names = (await w.edB.get(`${CH}/people`)).body.people as { name: string; conversation: string | null }[];
    expect(names.find((p) => p.name === 'Alex')).toEqual({ name: 'Alex', conversation: a.body.conversation.id });
    expect(names.find((p) => p.name === 'Ed')).toBeUndefined();
  });

  it('refuses a stranger and an Admin who is not in a conversation of people, with the answer of a conversation that does not exist', async () => {
    const w = await world();
    const sam = await w.people.createPerson('Sam');
    const samB = await signedIn(w, 'Sam', sam.token);
    const admins = (await w.people.allGroups()).find((g) => g.name === 'Administrators')!;
    const root = await w.people.createPerson('Root', admins.id);
    const rootB = await signedIn(w, 'Root', root.token);
    const id = (await OPEN(w.edB, [person('Alex')], 'private')).body.conversation.id as string;
    for (const b of [samB, rootB]) {
      const r = await page(b, id);
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('There is no such conversation.');
    }
    expect((await rootB.post(`${CH}/conversations/${id}/reading`).set(H)).status).toBe(404);
    expect((await samB.post(`${CH}/conversations/${id}/messages`).set(H).send({ text: 'hi' })).status).toBe(404);
    // An Admin's browse of Ed's Chat does not name it, and the logs hold no text.
    const browse = await rootB.get(`${CH}?owner=Ed`);
    expect(browse.status).toBe(200);
    expect(browse.body.conversations).toEqual([]);
    expect(JSON.stringify(await logRows(w))).not.toContain('private');
  });

  it('refuses nobody, yourself, an unknown person and the admin secret, in words', async () => {
    const w = await world();
    expect((await OPEN(w.edB, [])).status).toBe(400);
    expect((await OPEN(w.edB, [person('Ed')])).status).toBe(400);
    const ghost = await OPEN(w.edB, [person('Nobody')]);
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toBe('There is no person named Nobody.');
    const secret = await signedIn(w, 'Admin', SECRET);
    expect((await OPEN(secret, [person('Alex')])).status).toBe(403);
  });

  it('holds the author to their own message: edit and delete, a stranger refused, and a tombstone left', async () => {
    const w = await world();
    const id = (await OPEN(w.edB, [person('Alex')], 'first')).body.conversation.id as string;
    const mid = (await page(w.edB, id)).body.messages[0].id as string;
    expect((await w.alexB.patch(`${CH}/conversations/${id}/messages/${mid}`).set(H).send({ text: 'mine' })).status).toBe(403);
    const edited = await w.edB.patch(`${CH}/conversations/${id}/messages/${mid}`).set(H).send({ text: 'first, changed' });
    expect(edited.body).toMatchObject({ ok: true, message: { text: 'first, changed', canChange: true } });
    expect(edited.body.message.editedAt).not.toBeNull();
    const gone = await w.edB.delete(`${CH}/conversations/${id}/messages/${mid}`).set(H);
    expect(gone.body.message).toMatchObject({ text: '', canChange: false });
    expect((await w.edB.delete(`${CH}/conversations/${id}/messages/${mid}`).set(H)).status).toBe(409);
  });

  it('adds a person without asking them, and the last person to leave deletes the conversation', async () => {
    const w = await world();
    const sam = await w.people.createPerson('Sam');
    const samB = await signedIn(w, 'Sam', sam.token);
    const id = (await OPEN(w.edB, [person('Alex')])).body.conversation.id as string;
    expect((await samB.get(`${CH}/conversations/${id}/messages`)).status).toBe(404);
    const added = await w.edB.post(`${CH}/conversations/${id}/members`).set(H).send({ members: [person('Sam')] });
    expect(added.status).toBe(200);
    expect((await samB.get(`${CH}/conversations/${id}/messages`)).status).toBe(200);
    for (const b of [w.edB, w.alexB]) expect((await b.delete(`${CH}/conversations/${id}/members/me`).set(H)).body).toEqual({ ok: true, deleted: false });
    expect((await samB.delete(`${CH}/conversations/${id}/members/me`).set(H)).body).toEqual({ ok: true, deleted: true });
    expect((await samB.get(`${CH}/conversations/${id}/messages`)).status).toBe(404);
  });
});

describe('a conversation with an agent in it', () => {
  it('hands a person\'s message to their own agent, tells the people in it of an Admin who reads, and refuses another person\'s agent', async () => {
    const w = await world();
    const admins = (await w.people.allGroups()).find((g) => g.name === 'Administrators')!;
    const root = await w.people.createPerson('Root', admins.id);
    const rootB = await signedIn(w, 'Root', root.token);
    const res = await OPEN(w.edB, [person('Alex'), { kind: 'agent', sessionId: 'sess-tester' }], 'run the suite');
    expect(res.status).toBe(201);
    expect(res.body.conversation.hasAgent).toBe(true);
    const id = res.body.conversation.id as string;
    // Another person's agent is not added yet.
    const other = await w.edB.post(`${CH}/conversations/${id}/members`).set(H).send({ members: [{ kind: 'agent', sessionId: 'sess-alex' }] });
    expect(other.status).toBe(403);
    expect(other.body.error).toContain('not available yet');
    // An Admin may read it, and the read is recorded and told to the people in it.
    const read = await page(rootB, id);
    expect(read.status).toBe(200);
    expect(read.body.messages[0].text).toBe('run the suite');
    const seen = (await w.edB.get(CH)).body.conversations[0];
    expect(seen.adminReading.map((r: { admin: string }) => r.admin)).toEqual(['Root']);
    expect((await rootB.patch(`${CH}/conversations/${id}/messages/${read.body.messages[0].id}`).set(H).send({ text: 'x' })).status).toBe(403);
    expect(JSON.stringify(await logRows(w))).not.toContain('run the suite');
    const log = (await logRows(w)).map((r) => r.kind);
    expect(log).toContain('chat_admin_read');
  });
});

// An @ in a Direct Message with more than one agent (#1282): a message with no @ goes to every agent in it; one that names members goes only to them.
describe('an @ in a conversation with two agents and a person', () => {
  const SEND = (b: B, id: string, text: string) => b.post(`${CH}/conversations/${id}/messages`).set(H).send({ text });
  async function room() {
    const w = await world();
    const res = await OPEN(w.edB, [person('Alex'), { kind: 'agent', sessionId: 'sess-dev' }, { kind: 'agent', sessionId: 'sess-tester' }]);
    expect(res.status).toBe(201);
    return { ...w, id: res.body.conversation.id as string };
  }
  const SESSION = { dev: 'sess-dev', tester: 'sess-tester' } as const;
  /** What the agent is handed on its next report, and, when `take`, the agent's answer that it took each one (what moves a delivery to Delivered). */
  const got = async (s: S, which: 'dev' | 'tester', take = false) => {
    const handed = ((await (which === 'dev' ? dev(s) : tester(s))).body.deliveries ?? []) as { id: string; text: string }[];
    if (take) for (const d of handed) expect((await request(s.app).post(`/api/fleet/sessions/${SESSION[which]}/deliveries/${d.id}/result`).set('X-Podium-Token', s.ed.token).send({ result: 'took' })).status).toBe(200);
    if (take) await new Promise((r) => setTimeout(r, 50));
    return handed.map((d) => d.text);
  };

  it('hands a message with no @ to every agent in it, and says so for each', async () => {
    const w = await room();
    const sent = await SEND(w.edB, w.id, 'both of you: status?');
    expect(sent.status).toBe(201);
    expect(sent.body.message.deliveries.map((d: { name: string; named: boolean; state: string }) => [d.name, d.named, d.state])).toEqual([['Tester', false, 'queued'], ['dev', false, 'queued']]);
    expect(await got(w, 'dev', true)).toHaveLength(1);
    expect(await got(w, 'tester', true)).toHaveLength(1);
    const read = await page(w.edB, w.id);
    expect(read.body.messages[0].deliveries.map((d: { state: string }) => d.state)).toEqual(['delivered', 'delivered']);
  });

  it('hands a message that names one agent to that agent only, and the other receives nothing', async () => {
    const w = await room();
    const sent = await SEND(w.edB, w.id, '@Tester@ci-runner-01 rerun the specs');
    expect(sent.status).toBe(201);
    expect(sent.body.message.deliveries).toMatchObject([{ kind: 'agent', name: 'Tester', named: true, state: 'queued' }]);
    expect(await got(w, 'dev')).toEqual([]);
    expect(await got(w, 'tester', true)).toHaveLength(1);
    expect((await page(w.edB, w.id)).body.messages[0].deliveries).toMatchObject([{ name: 'Tester', named: true, state: 'delivered' }]);
    // Locked once an agent has it, as any message handed to an agent is.
    expect(sent.body.message.canChange).toBe(false);
  });

  it('hands a message that names a person to no agent, and leaves it editable', async () => {
    const w = await room();
    const sent = await SEND(w.edB, w.id, '@Alex@console can you look?');
    expect(sent.status).toBe(201);
    expect(sent.body.message.deliveries).toMatchObject([{ kind: 'person', name: 'Alex', named: true, state: null }]);
    expect(sent.body.message.canChange).toBe(true);
    expect(await got(w, 'dev')).toEqual([]);
    expect(await got(w, 'tester')).toEqual([]);
    // The person it names is told, as for any message they can read.
    const alexSees = (await w.alexB.get(CH)).body.conversations.find((c: { id: string }) => c.id === w.id);
    expect(alexSees).toMatchObject({ unread: 1 });
  });

  it('refuses a name that is not in it, in words, and stores and hands over nothing', async () => {
    const w = await room();
    const out = await SEND(w.edB, w.id, '@review@alex-box please look');
    expect(out.status).toBe(422);
    expect(out.body.error).toBe('review@alex-box is not in this conversation, so nothing was sent. Add it from Members, or remove the @.');
    expect((await page(w.edB, w.id)).body.messages).toEqual([]);
    expect(await got(w, 'dev')).toEqual([]);
    expect(await got(w, 'tester')).toEqual([]);
    const all = await SEND(w.edB, w.id, '@everyone hello');
    expect(all.status).toBe(422);
    expect(all.body.error).toContain('@group and @everyone are not available in a Direct Message');
  });

  it('reads the @ of someone who may not write there as a refusal of the send, not of the address', async () => {
    const w = await room();
    const stranger = await w.people.createPerson('Sam');
    const samB = await signedIn(w, 'Sam', stranger.token);
    expect((await SEND(samB, w.id, '@Tester@ci-runner-01 hi')).status).toBe(404);
    expect(await got(w, 'tester')).toEqual([]);
  });

  it('lets a message that names a person be edited, but not to name someone else or no one, since who it is for is fixed when it is sent', async () => {
    const w = await room();
    const sent = await SEND(w.edB, w.id, '@Alex@console can you look?');
    const mid = sent.body.message.id as string;
    const EDIT = (text: string) => w.edB.patch(`${CH}/conversations/${w.id}/messages/${mid}`).set(H).send({ text });
    expect((await EDIT('@Alex@console can you look at the PR?')).status).toBe(200);
    const other = await EDIT('@Tester@ci-runner-01 run rm');
    expect(other.status).toBe(422);
    expect(other.body.error).toBe('An edit cannot change who a message is for. Delete it and write it again to address someone else.');
    expect((await EDIT('can you look?')).status).toBe(422);
    const read = await page(w.edB, w.id);
    expect(read.body.messages[0]).toMatchObject({ text: '@Alex@console can you look at the PR?', deliveries: [{ name: 'Alex', named: true }] });
    expect(await got(w, 'tester')).toEqual([]);
  });
});

// An agent answers in the conversation a person wrote to it in (#1299): the message it was handed names the conversation (`convo`), and podium_send to `convo:<id>`
// posts the answer there. The `person:<name>` address cannot, because that names a person and a person can share several conversations with one agent.
describe('an agent answering in a conversation', () => {
  const SEND = (b: B, id: string, text: string) => b.post(`${CH}/conversations/${id}/messages`).set(H).send({ text });
  const ANSWER = (s: S, session: string, id: string, text: string) => request(s.app).post(`/api/fleet/sessions/${session}/chat/conversations/${id}/messages`).set('X-Podium-Token', s.ed.token).send({ text });
  async function room() {
    const w = await world();
    const res = await OPEN(w.edB, [person('Alex'), { kind: 'agent', sessionId: 'sess-dev' }, { kind: 'agent', sessionId: 'sess-tester' }]);
    expect(res.status).toBe(201);
    return { ...w, id: res.body.conversation.id as string };
  }

  it('hands the agent the conversation it was written to in, so it can answer there', async () => {
    const w = await room();
    expect((await SEND(w.edB, w.id, '@dev status?')).status).toBe(201);
    const handed = ((await dev(w)).body.deliveries ?? []) as { convo?: string; chat?: boolean }[];
    expect(handed).toHaveLength(1);
    expect(handed[0]!.convo).toBe(w.id);
  });

  it('posts the agent\'s answer in the conversation as the agent, and counts it unread for the other person', async () => {
    const w = await room();
    expect((await SEND(w.edB, w.id, '@dev status?')).status).toBe(201);
    const out = await ANSWER(w, 'sess-dev', w.id, 'All green.');
    expect(out.status).toBe(201);
    const read = await page(w.edB, w.id);
    const last = read.body.messages.at(-1);
    expect(last.text).toBe('All green.');
    expect(last.author).toMatchObject({ kind: 'agent', name: 'dev' });
    const alexSees = (await w.alexB.get(CH)).body.conversations.find((c: { id: string }) => c.id === w.id);
    expect(alexSees.unread).toBeGreaterThan(0);
  });

  it('refuses an agent that is not in it, one nobody wrote to there, and a conversation that does not exist', async () => {
    const w = await room();
    const other = await OPEN(w.edB, [{ kind: 'agent', sessionId: 'sess-dev' }, person('Ed')]);
    expect((await ANSWER(w, 'sess-dev', 'cnv_nope', 'hi')).status).toBe(404);
    // Written to in the room, not in this one.
    expect((await SEND(w.edB, w.id, '@dev status?')).status).toBe(201);
    expect((await ANSWER(w, 'sess-dev', other.body.conversation.id, 'hi')).status).toBe(403);
    // Not a member of the room at all.
    const solo = await OPEN(w.edB, [{ kind: 'agent', sessionId: 'sess-dev' }, person('Alex')]);
    expect((await ANSWER(w, 'sess-tester', solo.body.conversation.id, 'hi')).status).toBe(404);
  });

  it('still lets an agent answer a message that more than 50 later messages have pushed out of the newest page', async () => {
    const w = await room();
    expect((await SEND(w.edB, w.id, '@dev status?')).status).toBe(201);
    const store = w.fleet.chat.core.store.conversations;
    for (let i = 0; i < 120; i++) expect(await store.post(w.id, { authorKind: 'person', authorRef: String(w.ed.person.id), authorName: 'Ed', authorId: w.ed.person.id, text: `chatter ${i}` }, w.now() + i + 1), `chatter ${i} was stored`).not.toBeNull();
    expect((await page(w.edB, w.id)).body.older, 'the conversation is longer than its newest page').not.toBeNull();
    expect((await ANSWER(w, 'sess-dev', w.id, 'All green.')).status).toBe(201);
  });

  it('refuses an answer to a message written more than an hour ago, even when the conversation has since filled more than a page', async () => {
    const w = await room();
    expect((await SEND(w.edB, w.id, '@dev status?')).status).toBe(201);
    w.tick(61 * 60 * 1000);
    const store = w.fleet.chat.core.store.conversations;
    for (let i = 0; i < 120; i++) expect(await store.post(w.id, { authorKind: 'person', authorRef: String(w.ed.person.id), authorName: 'Ed', authorId: w.ed.person.id, text: `later ${i}` }, w.now() + i), `later ${i} was stored`).not.toBeNull();
    const out = await ANSWER(w, 'sess-dev', w.id, 'All green.');
    expect(out.status).toBe(403);
    expect(out.body.error).toContain('last hour');
  });

  it('does not take an answer from an agent whose delivery was dropped, since it was never handed the message', async () => {
    const w = await room();
    const sent = await SEND(w.edB, w.id, '@dev status?');
    expect(sent.status).toBe(201);
    await w.fleet.chat.core.store.conversations.setDelivery(w.id, sent.body.message.id, { kind: 'agent', ref: 'sess-dev' }, 'dropped', w.now());
    const out = await ANSWER(w, 'sess-dev', w.id, 'All green.');
    expect(out.status).toBe(403);
  });
});
