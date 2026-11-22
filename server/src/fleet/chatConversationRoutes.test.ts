// Conversations of people and agents (#1278, DECISIONS 74): a person writes to a person who has no orchestrator running, who finds it in Chat; the same members open one
// conversation; an Admin and a stranger cannot read a conversation of people; an Admin reads one with an agent in it, recorded, and a person may add their own agent.
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { createFleetRouter } from './routes.js';
import { createLogger } from '../logging/logger.js';
import { createAdminRouter } from '../admin/adminRouter.js';
import { Lockout } from './lockout.js';
import { createRespondBridge } from './respondBridge.js';
import { ENDED_NOTICE_MARK, type Report } from './protocol.js';
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

  it('reads the Admin\'s limits once for a send, and for a send that opens the conversation with its first message', async () => {
    const w = await world();
    const settings = vi.spyOn(w.fleet.chat.core.store.settings, 'get');
    const opened = await OPEN(w.edB, [person('Alex')]);
    expect(opened.status).toBe(201);
    const id = opened.body.conversation.id as string;
    settings.mockClear();
    expect((await w.edB.post(`${CH}/conversations/${id}/messages`).set(H).send({ text: 'one read of the limits' })).status).toBe(201);
    expect(settings).toHaveBeenCalledTimes(1);
    settings.mockClear();
    expect((await OPEN(w.edB, [person('Alex')], 'and a first message')).status).toBeLessThan(300);
    expect(settings.mock.calls.length).toBe(1);
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

// An Admin never reads in silence (PROJECT.md): each person in a conversation is told in the console (the record line and the live reading), in every live reporter session
// (the callout), and the Admin log gets a row without the text. The same path serves the ping an open page sends (#1310).
describe('an Admin reads a conversation with an agent in it', () => {
  it('tells every person in it in the console and in their reporter sessions, and writes the Admin log row, and tells no one else', async () => {
    const w = await world();
    const admins = (await w.people.allGroups()).find((g) => g.name === 'Administrators')!;
    const root = await w.people.createPerson('Root', admins.id);
    const rootB = await signedIn(w, 'Root', root.token);
    const res = await OPEN(w.edB, [person('Alex'), { kind: 'agent', sessionId: 'sess-dev' }], 'a private plan');
    const id = res.body.conversation.id as string;
    const callouts = async (s: 'dev' | 'tester' | 'alex') => (((await (s === 'dev' ? dev(w) : s === 'tester' ? tester(w) : alexOne(w))).body.adminNotices ?? []) as { text: string }[]).map((n) => n.text);
    expect(await callouts('dev')).toEqual([]);
    expect((await page(rootB, id)).status).toBe(200);
    const words = 'Root (an Admin) is reading your Podium conversation with dev, Ed, Alex.';
    expect(await callouts('dev')).toEqual([words]);
    expect(await callouts('tester')).toEqual([words]);
    expect(await callouts('alex')).toEqual([words]);
    for (const b of [w.edB, w.alexB]) {
      expect(((await b.get(CH)).body.conversations[0] as { adminReading: { admin: string }[] }).adminReading.map((r) => r.admin)).toEqual(['Root']);
      expect(((await page(b, id)).body.adminReads as { admin: string }[]).map((r) => r.admin)).toEqual(['Root']);
    }
    const reads = (await logRows(w)).filter((r) => r.kind === 'chat_admin_read');
    expect(reads).toHaveLength(1);
    expect(JSON.stringify(reads)).not.toContain('a private plan');
    // A ping keeps the reading live and adds no second log row; a stranger is told nothing.
    w.tick(15_000);
    expect((await rootB.post(`${CH}/conversations/${id}/reading`).set(H).send({})).status).toBe(200);
    expect((await logRows(w)).filter((r) => r.kind === 'chat_admin_read')).toHaveLength(1);
    expect(JSON.stringify(await callouts('dev'))).toContain(words);
  });
});

describe('a conversation ends when an agent in it ends (#1283)', () => {
  const finish = async (s: S, id: 'sess-tester' | 'sess-dev') => {
    const r = fixtureReport();
    r.session = { ...r.session, id, name: id === 'sess-tester' ? 'Tester' : 'dev', status: 'done', waitReason: null, peers: true };
    r.userName = 'Ed';
    r.machine = { ...(id === 'sess-tester' ? LINUX : MAC), os: 'macOS 27.0.1' };
    r.adminNotices = true;
    await post(s, s.ed.token, r);
    s.tick(DEFAULT_CONFIG.lingerMs + 1000);
    await s.fleet.sweep();
  };

  it('keeps a conversation that still has two people in it, marks the agent ended, and refuses a message to it', async () => {
    const w = await world();
    const res = await OPEN(w.edB, [person('Alex'), { kind: 'agent', sessionId: 'sess-tester' }], 'run the suite');
    const id = res.body.conversation.id as string;
    await finish(w, 'sess-tester');
    const seen = (await w.edB.get(CH)).body.conversations as { id: string; members: { name: string; kind: string; ended?: boolean }[] }[];
    expect(seen.map((c) => c.id)).toEqual([id]);
    expect(seen[0]!.members.find((m) => m.name === 'Tester')).toMatchObject({ kind: 'agent', ended: true });
    expect(seen[0]!.members.find((m) => m.name === 'Alex')?.ended).toBeFalsy();
    // The people can still write, and the text is still there.
    expect((await page(w.alexB, id)).body.messages[0].text).toBe('run the suite');
    const sent = await w.edB.post(`${CH}/conversations/${id}/messages`).set(H).send({ text: 'carry on without it' });
    expect(sent.status).toBe(201);
    expect(sent.body.skipped).toEqual([expect.stringMatching(/^Tester: it ended, so it did not get this message/)]);
    expect((await w.edB.get(`${CH}/concluded`)).body.concluded).toEqual([]);
  });

  it('deletes a conversation with fewer than two people left, lists it as concluded, and tells the agent that remains once', async () => {
    const w = await world();
    const res = await OPEN(w.edB, [{ kind: 'agent', sessionId: 'sess-tester' }, { kind: 'agent', sessionId: 'sess-dev' }], 'both of you');
    expect(res.status).toBe(201);
    const id = res.body.conversation.id as string;
    await finish(w, 'sess-tester');
    expect((await w.edB.get(CH)).body.conversations).toEqual([]);
    expect((await page(w.edB, id)).status).toBe(404);
    const concluded = (await w.edB.get(`${CH}/concluded`)).body.concluded as { agent: string; with: string[] }[];
    expect(concluded).toHaveLength(1);
    expect(concluded[0]).toMatchObject({ agent: 'Tester' });
    const told = ((await dev(w)).body.peerDeliveries ?? []) as { kind: string; text?: string }[];
    expect(told.filter((n) => n.kind === 'notice' && /Tester ended/.test(n.text ?? '') && /concluded/.test(n.text ?? ''))).toHaveLength(1);
    expect(told.map((n) => n.text)).toEqual([`${ENDED_NOTICE_MARK} Tester ended. This direct message has been concluded. Do not try to continue it, and do not open a new direct message to Tester.`]);
  });

  it('forgets the counts left for a conversation that no longer exists when the maintenance runs, and keeps the counts of one that does (#1296)', async () => {
    const w = await world();
    const kept = (await OPEN(w.alexB, [person('Ed')], 'stays')).body.conversation.id as string;
    // A count with no conversation behind it, as a crash between deleting a conversation and its counts leaves.
    const readState = w.fleet.chat.core.store.readState;
    await readState.bumpMany('convo:cnv_00000000_000000000000000000000000', [{ personId: w.ed.person.id, mention: false }]);
    const counted = async () => (await readState.threads('convo:')).sort();
    expect(await counted()).toEqual([`convo:${kept}`, 'convo:cnv_00000000_000000000000000000000000'].sort());
    await w.fleet.chat.maintain();
    expect(await counted()).toEqual([`convo:${kept}`]);
    expect(((await w.edB.get(CH)).body.conversations as { id: string; unread: number }[]).map((c) => [c.id, c.unread])).toEqual([[kept, 1]]);
  });

  it('tells the agent that remains, once, in its own words when the conversation stays because two people are still in it', async () => {
    const w = await world();
    const res = await OPEN(w.edB, [person('Alex'), { kind: 'agent', sessionId: 'sess-tester' }, { kind: 'agent', sessionId: 'sess-dev' }], 'all of you');
    expect(res.status).toBe(201);
    await finish(w, 'sess-tester');
    const told = ((await dev(w)).body.peerDeliveries ?? []) as { kind: string; text?: string }[];
    expect(told.filter((n) => n.kind === 'notice').map((n) => n.text)).toEqual([`${ENDED_NOTICE_MARK} Tester ended. It can no longer be written to, and you should not send it anything. The people in the conversation can keep writing.`]);
  });
});

// What a conversation refuses (a member list, a text, a rate), what it writes to the Admin log, and the Admin's ping of a conversation with an agent in it. Pinned before a
// Direct Message moves to the conversation tables (#1296).
describe('what a conversation refuses, and what it writes to the Admin log (#1296)', () => {
  const HA = { 'X-Podium-Admin': '1' };
  const SEND = (b: B, id: string, text?: unknown) => b.post(`${CH}/conversations/${id}/messages`).set(H).send(text === undefined ? {} : { text });
  /** Lets the Admin log's writes, which the events start without waiting, finish. */
  const settle = () => new Promise((r) => setTimeout(r, 20));
  async function withAlex() {
    const w = await world();
    const id = (await OPEN(w.edB, [person('Alex')])).body.conversation.id as string;
    return { ...w, id };
  }
  async function adminAgent(s: S) {
    const agent = request.agent(s.app);
    expect((await agent.post('/api/admin/unlock').set(HA).send({ name: 'Admin', token: SECRET })).status).toBe(200);
    return agent;
  }

  it('refuses a list of members that is empty, missing or longer than 49, and a member that is neither a person nor an agent', async () => {
    const w = await world();
    const WORDS = 'members must be a list of 1 to 49 people or agents.';
    for (const members of [[], 'Alex', undefined, Array.from({ length: 50 }, (_, i) => person(`Nobody${i}`))]) {
      const out = await OPEN(w.edB, members);
      expect(out.status).toBe(400);
      expect(out.body.error).toBe(WORDS);
    }
    // 49 is inside the limit: the list is read, and the first name nobody has is what stops it.
    const edge = await OPEN(w.edB, Array.from({ length: 49 }, (_, i) => person(`Nobody${i}`)));
    expect(edge.status).toBe(404);
    expect(edge.body.error).toBe('There is no person named Nobody0.');
    const odd = await OPEN(w.edB, [{ kind: 'robot', name: 'R2' }]);
    expect(odd.status).toBe(400);
    expect(odd.body.error).toBe('A member is { kind: "person", name } or { kind: "agent", sessionId }.');
    expect((await w.edB.get(CH)).body.conversations).toEqual([]);
  });

  it('refuses an empty message and one that is not text in words, and an over-long one with the Admin\'s limit, storing nothing', async () => {
    const w = await withAlex();
    const empty = await SEND(w.edB, w.id, '   ');
    expect([empty.status, empty.body.error]).toEqual([400, 'Write something to send.']);
    for (const bad of [7, ['a'], { text: 'a' }, undefined]) {
      const out = await SEND(w.edB, w.id, bad);
      expect([out.status, out.body.error]).toEqual([400, 'text must be a string.']);
    }
    expect((await (await adminAgent(w)).put('/api/admin/settings').set(HA).send({ chat: { maxChars: 20, perMinute: 6 } })).status).toBe(200);
    const long = await SEND(w.edB, w.id, 'x'.repeat(21));
    expect([long.status, long.body.error]).toEqual([422, 'A message is at most 20 characters.']);
    expect((await SEND(w.edB, w.id, 'x'.repeat(20))).status).toBe(201);
    expect((await page(w.edB, w.id)).body.messages).toHaveLength(1);
    // The first message of a new conversation is held to the same limit, and a refusal opens nothing.
    const first = await OPEN(w.edB, [person('Alex'), { kind: 'agent', sessionId: 'sess-dev' }], 'y'.repeat(21));
    expect([first.status, first.body.error]).toEqual([422, 'A message is at most 20 characters.']);
    expect((await w.edB.get(CH)).body.conversations).toHaveLength(1);
  });

  it('stops a person at 6 messages a minute with the seconds to wait, charges nothing for a refused message, and lets the next minute through', async () => {
    const w = await withAlex();
    for (let i = 0; i < 3; i++) expect((await SEND(w.edB, w.id, ' ')).status).toBe(400);
    for (let i = 0; i < 6; i++) expect((await SEND(w.edB, w.id, `m${i}`)).status).toBe(201);
    const over = await SEND(w.edB, w.id, 'one too many');
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/^You are sending too fast\. Wait \d+ seconds\.$/);
    expect((await page(w.edB, w.id)).body.messages).toHaveLength(6);
    // Another person has a rate of their own.
    expect((await SEND(w.alexB, w.id, 'hello Ed')).status).toBe(201);
    w.tick(61_000);
    expect((await SEND(w.edB, w.id, 'a minute on')).status).toBe(201);
  });

  it('writes a row to the Admin log for a conversation opened, written in, edited, deleted from, added to and left, with ids and never the text', async () => {
    const w = await world();
    const sam = await w.people.createPerson('Sam');
    const opened = await OPEN(w.edB, [person('Alex')], 'a private first line');
    const id = opened.body.conversation.id as string;
    const mid = opened.body.message.id as string;
    expect((await SEND(w.edB, id, 'a private second line')).status).toBe(201);
    expect((await w.edB.patch(`${CH}/conversations/${id}/messages/${mid}`).set(H).send({ text: 'a private edit' })).status).toBe(200);
    expect((await w.edB.delete(`${CH}/conversations/${id}/messages/${mid}`).set(H)).status).toBe(200);
    expect((await w.edB.post(`${CH}/conversations/${id}/members`).set(H).send({ members: [person('Sam')] })).status).toBe(200);
    const samB = await signedIn(w, 'Sam', sam.token);
    for (const b of [w.edB, w.alexB, samB]) expect((await b.delete(`${CH}/conversations/${id}/members/me`).set(H)).status).toBe(200);
    await settle();
    const rows = await logRows(w);
    // The log lists the newest row first; read in the order things happened.
    const detail = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => [r.actor, r.detail]).reverse();
    const short = '\\[cnv_[0-9a-f]{8}\\]';
    expect(detail('conversation_opened')).toEqual([['Ed', expect.stringMatching(new RegExp(`^Opened a conversation of 2 members ${short}$`))]]);
    expect(detail('conversation_sent')).toEqual([
      ['Ed', expect.stringMatching(new RegExp(`^Sent a message in a conversation ${short} \\[cmg_[0-9a-f]{8}\\]$`))],
      ['Ed', expect.stringMatching(new RegExp(`^Sent a message in a conversation ${short} \\[cmg_[0-9a-f]{8}\\]$`))],
    ]);
    expect(detail('conversation_message_edited')).toEqual([['Ed', expect.stringMatching(new RegExp(`^Edited own message in a conversation ${short} \\[cmg_[0-9a-f]{8}\\]$`))]]);
    expect(detail('conversation_message_deleted')).toEqual([['Ed', expect.stringMatching(new RegExp(`^Deleted own message in a conversation ${short} \\[cmg_[0-9a-f]{8}\\]$`))]]);
    expect(detail('conversation_members_added')).toEqual([['Ed', expect.stringMatching(new RegExp(`^Added 1 to a conversation ${short}$`))]]);
    expect(detail('conversation_left').map(([actor, d]) => [actor, String(d).replace(/\[cnv_[0-9a-f]{8}\]/, '[id]')])).toEqual([
      ['Ed', 'Left a conversation [id]'],
      ['Alex', 'Left a conversation [id]'],
      ['Sam', 'Left a conversation (the last person, so it was deleted) [id]'],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/a private/);
  });

  it('answers an Admin\'s ping of a conversation with an agent in it with ok, keeps the reading live for its people, and refuses a ping from a person who is no Admin', async () => {
    const w = await world();
    const admins = (await w.people.allGroups()).find((g) => g.name === 'Administrators')!;
    const root = await w.people.createPerson('Root', admins.id);
    const rootB = await signedIn(w, 'Root', root.token);
    const id = (await OPEN(w.edB, [person('Alex'), { kind: 'agent', sessionId: 'sess-tester' }], 'run the suite')).body.conversation.id as string;
    const reading = () => w.edB.get(CH).then((r) => (r.body.conversations[0].adminReading as { admin: string }[]).map((a) => a.admin));
    expect(await reading()).toEqual([]);
    const ping = await rootB.post(`${CH}/conversations/${id}/reading`).set(H);
    expect([ping.status, ping.body]).toEqual([200, { ok: true }]);
    expect(await reading()).toEqual(['Root']);
    // Left alone, the reading goes stale; a ping 15 seconds later in a real page keeps it live.
    w.tick(31_000);
    expect(await reading()).toEqual([]);
    expect((await rootB.post(`${CH}/conversations/${id}/reading`).set(H)).status).toBe(200);
    expect(await reading()).toEqual(['Root']);
    for (const b of [w.edB, w.alexB]) {
      const refused = await b.post(`${CH}/conversations/${id}/reading`).set(H);
      expect([refused.status, refused.body.error]).toEqual([403, 'Only an Admin reads a conversation that is not their own.']);
    }
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

// What a conversation says when it refuses to change a message: its own words for a message that is not there, that is not the person's, that is deleted already and that an agent
// has been handed, with the reason a form reads, and the same words in the message's own `changeWhy` (#1310).
describe('the refusals of a change in a conversation', () => {
  const HANDED = 'Podium has already sent this to an agent, so it can no longer be changed.';
  it('says each one in the conversation\'s words, and shows a locked message as one the author cannot change', async () => {
    const w = await world();
    const res = await OPEN(w.edB, [person('Alex'), { kind: 'agent', sessionId: 'sess-dev' }]);
    expect(res.status).toBe(201);
    const id = res.body.conversation.id as string;
    const send = async (text: string) => (await w.edB.post(`${CH}/conversations/${id}/messages`).set(H).send({ text })).body.message.id as string;
    const patch = (b: B, mid: string, text = '@Alex@console x') => b.patch(`${CH}/conversations/${id}/messages/${mid}`).set(H).send({ text });
    const remove = (b: B, mid: string) => b.delete(`${CH}/conversations/${id}/messages/${mid}`).set(H);
    const words = (r: { status: number; body: { error: string; reason?: string } }) => [r.status, r.body.error, r.body.reason];
    const quiet = await send('@Alex@console to a person only');
    expect(words(await patch(w.edB, 'cmg_00000000_000000000000000000000000'))).toEqual([404, 'There is no such message.', undefined]);
    expect(words(await remove(w.edB, 'cmg_00000000_000000000000000000000000'))).toEqual([404, 'There is no such message.', undefined]);
    const handed = await send('hello dev');
    // The check of who a message is for runs before the store's check of the author, so another member's edit of a message that names someone is refused for that first.
    expect(words(await patch(w.alexB, quiet))).toEqual([422, 'An edit cannot change who a message is for. Delete it and write it again to address someone else.', undefined]);
    expect(words(await patch(w.alexB, handed))).toEqual([403, 'You can change only your own messages.', undefined]);
    expect(words(await remove(w.alexB, quiet))).toEqual([403, 'You can change only your own messages.', undefined]);
    expect((await remove(w.edB, quiet)).status).toBe(200);
    expect(words(await patch(w.edB, quiet))).toEqual([409, 'That message was already deleted.', 'deleted']);
    expect(words(await remove(w.edB, quiet))).toEqual([409, 'That message was already deleted.', 'deleted']);
    expect(words(await patch(w.edB, handed, 'hello dev again'))).toEqual([409, HANDED, 'locked']);
    expect(words(await remove(w.edB, handed))).toEqual([409, HANDED, 'locked']);
    const view = (await page(w.edB, id)).body.messages as { id: string; canChange: boolean; changeWhy: string | null }[];
    expect(view.find((m) => m.id === handed)).toMatchObject({ canChange: false, changeWhy: HANDED });
    expect(view.find((m) => m.id === quiet)).toMatchObject({ canChange: false, changeWhy: null });
    expect((await page(w.alexB, id)).body.messages.find((m: { id: string }) => m.id === handed)).toMatchObject({ canChange: false, changeWhy: null });
  });
});

// What a conversation says when it refuses a text for its length or its rate: its own words (shorter than a channel's and a Direct Message's), the same on a send, an edit and an
// agent's answer, with the limits the Admin set (#1310).
describe('the length and rate refusals of a conversation', () => {
  const TOO_LONG = (n: number) => `A message is at most ${n} characters.`;
  const TOO_FAST = (s: number) => `You are sending too fast. Wait ${s} seconds.`;
  const HA = { 'X-Podium-Admin': '1' };
  async function limited(chat: { maxChars: number; perMinute: number }) {
    const w = await world();
    const res = await OPEN(w.edB, [person('Alex'), { kind: 'agent', sessionId: 'sess-dev' }]);
    expect(res.status).toBe(201);
    const admin = request.agent(w.app);
    expect((await admin.post('/api/admin/unlock').set(HA).send({ name: 'Admin', token: SECRET })).status).toBe(200);
    expect((await admin.put('/api/admin/settings').set(HA).send({ chat })).status).toBe(200);
    return { ...w, id: res.body.conversation.id as string };
  }
  const send = (b: B, id: string, text: unknown) => b.post(`${CH}/conversations/${id}/messages`).set(H).send({ text });

  it('says it in the conversation\'s words on a send, and counts a refusal for length as no send', async () => {
    const w = await limited({ maxChars: 20, perMinute: 2 });
    const long = await send(w.edB, w.id, 'x'.repeat(21));
    expect([long.status, long.body.error]).toEqual([422, TOO_LONG(20)]);
    expect((await send(w.edB, w.id, 'one')).status).toBe(201);
    expect((await send(w.edB, w.id, 'two')).status).toBe(201);
    const fast = await send(w.edB, w.id, 'three');
    expect([fast.status, fast.body.error]).toEqual([429, TOO_FAST(60)]);
    expect((await send(w.edB, w.id, 42)).status).toBe(400);
    expect((await send(w.edB, w.id, '   ')).body.error).toBe('Write something to send.');
    w.tick(61_000);
    expect((await send(w.edB, w.id, 'four')).status).toBe(201);
  });

  it('says it in the same words on an edit, and on an agent\'s answer', async () => {
    const w = await limited({ maxChars: 20, perMinute: 2 });
    const first = await send(w.edB, w.id, '@Alex@console hi');
    expect(first.status).toBe(201);
    const edit = (text: string) => w.edB.patch(`${CH}/conversations/${w.id}/messages/${first.body.message.id}`).set(H).send({ text });
    const long = await edit('@Alex@console ' + 'y'.repeat(21));
    expect([long.status, long.body.error]).toEqual([422, TOO_LONG(20)]);
    expect((await edit('@Alex@console fine')).status).toBe(200);
    const fast = await edit('@Alex@console again');
    expect([fast.status, fast.body.error]).toEqual([429, TOO_FAST(60)]);
    w.tick(61_000);
    const handed = await send(w.alexB, w.id, '@dev status?');
    expect(handed.status).toBe(201);
    const answer = (text: string) => request(w.app).post(`/api/fleet/sessions/sess-dev/chat/conversations/${w.id}/messages`).set('X-Podium-Token', w.ed.token).send({ text });
    const tooLong = await answer('z'.repeat(21));
    expect([tooLong.status, tooLong.body.error]).toEqual([422, TOO_LONG(20)]);
    expect((await answer('ok one')).status).toBe(201);
    expect((await answer('ok two')).status).toBe(201);
    const slow = await answer('ok three');
    expect([slow.status, slow.body.error]).toEqual([429, TOO_FAST(60)]);
  });
});
