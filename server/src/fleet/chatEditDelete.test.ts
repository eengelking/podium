// A person edits and deletes their own Chat messages (#1269): the four browser routes for channel messages and direct messages, what they refuse, the
// views the page reads (`editedAt`, `deletedAt`, `canChange`, `changeWhy`), what an agent reads of an edited or a deleted message, and what the server
// does (and does not) signal and log. The store decides who may and when; these tests hold the server to asking it and to saying the answer in words.
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

const SECRET = 'admin-secret-for-the-edit-delete-tests';
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
const BOX2 = { name: 'alex-box2', id: 'alxalxalx002' };

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
const alexTwo = (s: S) => post(s, s.alex.token, report('Alex', 'sess-alex2', 'second', BOX2));

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
type W = Awaited<ReturnType<typeof world>>;

const say = (b: B, channel: string, text: string) => b.post(`${CH}/channels/${channel}/messages`).set(H).send({ text });
const edit = (b: B, channel: string, id: string, text: unknown) => b.patch(`${CH}/channels/${channel}/messages/${id}`).set(H).send({ text });
const del = (b: B, channel: string, id: string) => b.delete(`${CH}/channels/${channel}/messages/${id}`).set(H);
const read = (b: B, channel: string) => b.get(`${CH}/channels/${channel}/messages`);
const dmEdit = (b: B, path: string, id: string, text: unknown) => b.patch(`${CH}/dm/${path}/messages/${id}`).set(H).send({ text });
const dmDel = (b: B, path: string, id: string) => b.delete(`${CH}/dm/${path}/messages/${id}`).set(H);
const settle = () => new Promise((r) => setTimeout(r, 20));
const logRows = async (s: S) => (await s.people.listLog({ page: 1, pageSize: 200 })).rows;
const LOCKED_WORDS = 'Podium has already sent this message to Tester, so it can no longer be changed.';
const group = (s: S) => ({ ownerId: s.ed.person.id });
/** Both agents linked by a right, with one agent message between them, so there is a conversation a person can add to. */
async function linkedConversation(w: W) {
  const set = await w.edB.put('/api/fleet/respond/peers/rights').set(H).send({ from: MAC.id, to: LINUX.id, level: 'send' });
  expect(set.status).toBe(200);
  const sent = await request(w.app).post('/api/fleet/sessions/sess-dev/peers/messages').set('X-Podium-Token', w.ed.token).send({ to: 'Tester@ci-runner-01', text: 'agent hello' });
  expect(sent.status).toBe(202);
}
/** The number of `chat` events the stream has written so far. */
const watchStream = (s: S) => {
  const sse: string[] = [];
  s.fleet.hub.add({ write: (c: string) => sse.push(c) });
  return { count: () => sse.join('').split('\n\n').filter((c) => c.includes('event: chat')).length, raw: () => sse.join('') };
};

describe('a person edits their own channel message (#1269)', () => {
  it.each(['group', 'general'])('changes the text in %s, redacted like a post, and says it was edited', async (channel) => {
    const w = await world();
    const sent = await say(w.edB, channel, 'first draft');
    const id = sent.body.message.id as string;
    expect(sent.body.message).toMatchObject({ editedAt: null, deletedAt: null, canChange: true, changeWhy: null, mine: true });
    w.tick(5_000);
    const res = await edit(w.edB, channel, id, 'second draft with key sk-abcdefghijklmnopqrstuvwxyz123456 inside');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatchObject({ id, text: expect.stringContaining('[redacted]'), editedAt: w.now(), deletedAt: null, canChange: true, changeWhy: null, mine: true });
    expect(res.body.message.text).not.toContain('sk-abcdef');
    expect(res.body.message).not.toHaveProperty('authorId');
    const page = await read(w.edB, channel);
    expect(page.body.messages).toHaveLength(1);
    expect(page.body.messages[0]).toMatchObject({ id, editedAt: w.now(), canChange: true });
    expect(JSON.stringify(page.body)).not.toContain('first draft');
  });

  it('changes a message in a public channel someone opened', async () => {
    const w = await world();
    expect((await w.edB.post(`${CH}/channels`).set(H).send({ name: 'ops', description: 'Operations' })).status).toBe(201);
    const id = (await say(w.edB, 'ops', 'ops one')).body.message.id as string;
    expect((await edit(w.edB, 'ops', id, 'ops two')).body.message.text).toBe('ops two');
    const gone = await del(w.edB, 'ops', id);
    expect(gone.status).toBe(200);
    expect(gone.body.message).toMatchObject({ text: '', deletedAt: w.now() });
  });

  it('answers an empty text 400 and a text over the limit 422, and changes nothing', async () => {
    const w = await world();
    const id = (await say(w.edB, 'general', 'keep me')).body.message.id as string;
    expect((await edit(w.edB, 'general', id, '   ')).status).toBe(400);
    expect((await edit(w.edB, 'general', id, undefined)).status).toBe(400);
    // Nothing but characters that draw nothing (U+200B) is empty once cleaned, as it is for a post.
    expect((await edit(w.edB, 'general', id, '\u200B\u200B')).status).toBe(400);
    expect((await edit(w.edB, 'general', id, 'x'.repeat(4001))).status).toBe(422);
    expect((await read(w.edB, 'general')).body.messages[0]).toMatchObject({ text: 'keep me', editedAt: null });
  });

  it('counts an edit against the same per-minute limit as a post', async () => {
    const w = await world();
    const id = (await say(w.edB, 'general', 'one')).body.message.id as string;
    for (let i = 0; i < 5; i++) expect((await edit(w.edB, 'general', id, `edit ${i}`)).status).toBe(200);
    const over = await edit(w.edB, 'general', id, 'one too many');
    expect(over.status).toBe(429);
    expect((await read(w.edB, 'general')).body.messages[0].text).toBe('edit 4');
  });

  it('refuses an edit that adds or removes an @mention, and one that changes it, in words, leaving the message as it was', async () => {
    const w = await world();
    expect((await w.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: true })).status).toBe(200);
    const sent = await say(w.edB, 'group', '@Tester@ci-runner-01 please run it');
    expect(sent.body.message.mentions[0].state).toBe('held');
    const id = sent.body.message.id as string;
    const WORDS = 'To change who is mentioned, delete this message and send a new one.';
    for (const text of ['please run it', '@Tester@ci-runner-01 @dev@ed-mbp please run it', '@dev@ed-mbp please run it']) {
      const res = await edit(w.edB, 'group', id, text);
      expect(res.status, text).toBe(422);
      expect(res.body.error).toContain(WORDS);
    }
    // The same mention, in other letters and with other words around it, is not a change.
    const ok = await edit(w.edB, 'group', id, 'Could you run it, @TESTER@CI-RUNNER-01?');
    expect(ok.status).toBe(200);
    expect(ok.body.message.mentions).toHaveLength(1);
    expect(ok.body.message.mentions[0]).toMatchObject({ typed: 'Tester@ci-runner-01', state: 'held' });
  });

  it('lets a person edit a message that mentions a person, and refuses a change of who', async () => {
    const w = await world();
    const sent = await say(w.edB, 'general', 'hello @Alex@console');
    const id = sent.body.message.id as string;
    expect(sent.body.message.mentions[0]).toMatchObject({ state: 'done' });
    expect(sent.body.message.canChange).toBe(true);
    expect((await edit(w.edB, 'general', id, 'hello again @Alex@console')).status).toBe(200);
    expect((await edit(w.edB, 'general', id, 'hello again')).status).toBe(422);
  });
});

describe('a person deletes their own channel message (#1269)', () => {
  it.each(['group', 'general'])('leaves a tombstone in %s: no text, no mentions, the place kept', async (channel) => {
    const w = await world();
    await say(w.edB, channel, 'before');
    const sent = await say(w.edB, channel, 'to be deleted @Alex@console');
    await say(w.edB, channel, 'after');
    const id = sent.body.message.id as string;
    w.tick(1_000);
    const res = await del(w.edB, channel, id);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ id, text: '', mentions: [], deletedAt: w.now(), canChange: false, changeWhy: null, authorName: 'Ed', authorKind: 'person', createdAt: sent.body.message.createdAt, replyTo: null });
    const page = await read(w.edB, channel);
    expect(page.body.total).toBe(3);
    expect(page.body.messages.map((m: { text: string }) => m.text)).toEqual(['before', '', 'after']);
    expect(page.body.messages[1]).toMatchObject({ id, deletedAt: w.now(), canChange: false, changeWhy: null, mentions: [] });
    expect(JSON.stringify(page.body)).not.toContain('to be deleted');
    // Alex reads the same tombstone in General.
    if (channel === 'general') expect(JSON.stringify((await read(w.alexB, 'general')).body)).not.toContain('to be deleted');
  });

  it('answers a second delete, and an edit of a tombstone, 409 deleted', async () => {
    const w = await world();
    const id = (await say(w.edB, 'general', 'gone soon')).body.message.id as string;
    expect((await del(w.edB, 'general', id)).status).toBe(200);
    for (const res of [await del(w.edB, 'general', id), await edit(w.edB, 'general', id, 'back again')]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ ok: false, reason: 'deleted' });
      expect(res.body.error).toBe('This message has already been deleted.');
    }
  });

  it('keeps the clear-all route as it was, and never takes a message id for it', async () => {
    const w = await world();
    const id = (await say(w.edB, 'group', 'one')).body.message.id as string;
    await say(w.edB, 'group', 'two');
    await say(w.edB, 'general', 'public one');
    // Only an Admin clears General.
    expect((await w.edB.delete(`${CH}/channels/general/messages`).set(H)).status).toBe(403);
    expect((await del(w.edB, 'group', id)).status).toBe(200);
    expect((await read(w.edB, 'group')).body.total).toBe(2);
    const cleared = await w.edB.delete(`${CH}/channels/group/messages`).set(H);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ ok: true, removed: 2 });
    expect((await read(w.edB, 'general')).body.total).toBe(1);
  });
});

describe('who may change a channel message, and when (#1269)', () => {
  it('answers 404 for a message that is not in the channel, or does not exist', async () => {
    const w = await world();
    const inGeneral = (await say(w.edB, 'general', 'in general')).body.message.id as string;
    await say(w.edB, 'group', 'in group');
    for (const f of [(id: string) => edit(w.edB, 'group', id, 'x'), (id: string) => del(w.edB, 'group', id)]) {
      expect((await f(inGeneral)).status).toBe(404);
      expect((await f('grp_00000000_000000000000000000000000')).status).toBe(404);
    }
    expect((await edit(w.edB, 'nowhere', inGeneral, 'x')).status).toBe(404);
  });

  it('refuses another person, an agent\'s message and the admin secret, and reveals no more than a read does', async () => {
    const w = await world();
    const mine = (await say(w.edB, 'general', 'Ed wrote this')).body.message.id as string;
    for (const res of [await edit(w.alexB, 'general', mine, 'Alex changes it'), await del(w.alexB, 'general', mine)]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Only the person who wrote a message can change it.');
    }
    // The page tells Alex it is not theirs to change, and does not say why.
    expect((await read(w.alexB, 'general')).body.messages[0]).toMatchObject({ canChange: false, changeWhy: null, mine: false });
    // A person's group is their own: another person's id is not in it, so it is not found, as it is not in their read of it.
    const groupId = (await say(w.edB, 'group', 'private')).body.message.id as string;
    expect((await edit(w.alexB, 'group', groupId, 'x')).status).toBe(404);
    expect((await del(w.alexB, 'group', groupId)).status).toBe(404);
    // An agent's message.
    expect((await say(w.edB, 'group', '@Tester@ci-runner-01 are you there?')).status).toBe(201);
    const posted = await request(w.app).post('/api/fleet/sessions/sess-tester/chat/channels/group/messages').set('X-Podium-Token', w.ed.token).send({ text: 'agent says hi' });
    expect(posted.status).toBe(201);
    const agentId = posted.body.id as string;
    expect((await edit(w.edB, 'group', agentId, 'Ed rewrites the agent')).status).toBe(403);
    expect((await del(w.edB, 'group', agentId)).status).toBe(403);
    const agentView = (await read(w.edB, 'group')).body.messages.find((m: { id: string }) => m.id === agentId);
    expect(agentView).toMatchObject({ text: 'agent says hi', canChange: false, changeWhy: null });
    // The admin secret has no person, so it has no message.
    const root = await signedIn(w, 'Admin', SECRET);
    for (const res of [await edit(root, 'general', mine, 'x'), await del(root, 'general', mine), await edit(root, 'group', groupId, 'x'), await del(root, 'group', groupId)]) expect(res.status).toBeGreaterThanOrEqual(403);
    expect([(await edit(root, 'general', mine, 'x')).status, (await del(root, 'general', mine)).status]).toEqual([403, 403]);
    expect((await read(w.edB, 'general')).body.messages[0].text).toBe('Ed wrote this');
  });

  it('refuses a signed-out request, and one while messaging is off', async () => {
    const w = await world();
    const id = (await say(w.edB, 'general', 'mine')).body.message.id as string;
    expect((await request(w.app).patch(`${CH}/channels/general/messages/${id}`).set(H).send({ text: 'x' })).status).toBe(403);
    expect((await request(w.app).delete(`${CH}/channels/general/messages/${id}`).set(H)).status).toBe(403);
    await w.fleet.features.setFeature(PEER_MESSAGING, false);
    expect((await edit(w.edB, 'general', id, 'x')).status).toBe(403);
  });

  it('does not let a person who was deleted and made again under the same name change the old one\'s message', async () => {
    const w = await world();
    // A message written by an earlier person who had this name: the same name, another id.
    const old = await w.fleet.chat.core.store.public.post('general', { authorKind: 'person', authorRef: 'Ed', authorName: 'Ed', text: 'from the earlier Ed', authorId: w.ed.person.id + 1000 });
    const res = await edit(w.edB, 'general', old.id, 'mine now');
    expect(res.status).toBe(403);
    expect((await del(w.edB, 'general', old.id)).status).toBe(403);
    const view = (await read(w.edB, 'general')).body.messages[0];
    expect(view).toMatchObject({ text: 'from the earlier Ed', mine: true, canChange: false, changeWhy: null });
  });

  it.each(['waiting', 'working', 'done'] as const)('refuses a message an agent has (%s) with 409 locked, in words that name the agent, and leaves it as it was', async (state) => {
    const w = await world();
    const sent = await say(w.edB, 'group', '@Tester@ci-runner-01 run the suite');
    const id = sent.body.message.id as string;
    expect(sent.body.message.mentions[0].state).toBe('waiting');
    expect(sent.body.message).toMatchObject({ canChange: false, changeWhy: LOCKED_WORDS });
    if (state !== 'waiting') await w.fleet.chat.core.store.group.setMention(group(w), id, 0, { state });
    for (const res of [await edit(w.edB, 'group', id, 'run another suite @Tester@ci-runner-01'), await del(w.edB, 'group', id)]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ ok: false, reason: 'locked', error: LOCKED_WORDS });
    }
    const view = (await read(w.edB, 'group')).body.messages[0];
    expect(view).toMatchObject({ text: '@Tester@ci-runner-01 run the suite', editedAt: null, deletedAt: null, canChange: false, changeWhy: LOCKED_WORDS });
  });

  it('names every agent a message was sent to', async () => {
    const w = await world();
    const sent = await say(w.edB, 'group', '@Tester@ci-runner-01 @dev@ed-mbp both of you');
    expect(sent.body.message.changeWhy).toBe('Podium has already sent this message to Tester and dev, so it can no longer be changed.');
  });

  it('does not lock for a mention of a person, or one that was not delivered, and changes both', async () => {
    const w = await world();
    const person = (await say(w.edB, 'general', 'hi @Alex@console')).body.message;
    const nobody = (await say(w.edB, 'general', 'hi @ghost@nowhere')).body.message;
    expect(nobody.mentions[0].state).toBe('not-delivered');
    for (const m of [person, nobody]) {
      expect(m.canChange).toBe(true);
      expect((await del(w.edB, 'general', m.id)).status).toBe(200);
    }
  });

  it('changes a held message, and the resume hands the agent the edited text', async () => {
    const w = await world();
    expect((await w.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: true })).status).toBe(200);
    const id = (await say(w.edB, 'group', '@dev@ed-mbp original words')).body.message.id as string;
    expect((await edit(w.edB, 'group', id, '@dev@ed-mbp edited words')).status).toBe(200);
    const resumed = await w.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: false });
    expect(resumed.body).toMatchObject({ ok: true, delivered: 1 });
    const got = (await dev(w)).body.deliveries as { text: string }[];
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toContain('edited words');
    expect(got[0]!.text).not.toContain('original words');
    // Now it is with the agent, so it is locked.
    const locked = await edit(w.edB, 'group', id, '@dev@ed-mbp too late');
    expect(locked.status).toBe(409);
    expect(locked.body.error).toBe('Podium has already sent this message to dev, so it can no longer be changed.');
  });

  it('never hands an agent a held message that was deleted before the resume', async () => {
    const w = await world();
    expect((await w.edB.put(`${CH}/channels/general/pause`).set(H).send({ paused: true })).status).toBe(200);
    const kept = (await say(w.edB, 'general', '@dev@ed-mbp keep this one')).body.message.id as string;
    const gone = (await say(w.edB, 'general', '@dev@ed-mbp delete this one')).body.message.id as string;
    expect((await del(w.edB, 'general', gone)).status).toBe(200);
    const resumed = await w.edB.put(`${CH}/channels/general/pause`).set(H).send({ paused: false });
    expect(resumed.body).toMatchObject({ ok: true, delivered: 1 });
    const got = (await dev(w)).body.deliveries as { text: string }[];
    expect(got.map((d) => d.text).join('|')).toContain('keep this one');
    expect(got.map((d) => d.text).join('|')).not.toContain('delete this one');
    const page = (await read(w.edB, 'general')).body.messages;
    expect(page.find((m: { id: string }) => m.id === gone)).toMatchObject({ text: '', mentions: [], deletedAt: expect.any(Number) });
    expect(page.find((m: { id: string }) => m.id === kept).mentions[0].state).toBe('waiting');
  });

  it('does not deliver a message deleted while a resume is in progress (the state change comes before the delivery)', async () => {
    const w = await world();
    expect((await w.edB.put(`${CH}/channels/general/pause`).set(H).send({ paused: true })).status).toBe(200);
    const id = (await say(w.edB, 'general', '@dev@ed-mbp deleted in the middle')).body.message.id as string;
    // The store refuses a change of the state of a tombstone, which is what the resume asks first.
    expect((await del(w.edB, 'general', id)).status).toBe(200);
    expect(await w.fleet.chat.core.store.public.setMention('general', id, 0, { state: 'waiting' })).toBeNull();
    expect((await w.edB.put(`${CH}/channels/general/pause`).set(H).send({ paused: false })).body.delivered).toBe(0);
    expect(((await dev(w)).body.deliveries ?? []) as unknown[]).toHaveLength(0);
  });
});

describe('what the server tells and records about a change (#1269)', () => {
  it('signals the open consoles after an edit and a delete, with nothing in the signal, and none after a refusal', async () => {
    const w = await world();
    const stream = watchStream(w);
    const id = (await say(w.edB, 'general', 'a secret plan')).body.message.id as string;
    const after = stream.count();
    expect((await edit(w.edB, 'general', id, 'a different plan')).status).toBe(200);
    expect(stream.count()).toBe(after + 1);
    expect((await edit(w.alexB, 'general', id, 'x')).status).toBe(403);
    expect((await edit(w.edB, 'general', id, '')).status).toBe(400);
    expect(stream.count()).toBe(after + 1);
    expect((await del(w.edB, 'general', id)).status).toBe(200);
    expect(stream.count()).toBe(after + 2);
    expect((await del(w.edB, 'general', id)).status).toBe(409);
    expect(stream.count()).toBe(after + 2);
    const events = stream.raw().split('\n\n').filter((c) => c.includes('event: chat')).map((c) => JSON.parse(c.split('data: ')[1]!));
    for (const d of events) expect(Object.keys(d).sort()).toEqual(['rev', 'scope']);
    expect(stream.raw()).not.toContain('plan');
  });

  it('writes a log row for each edit and delete with ids and scope, never the text', async () => {
    const w = await world();
    const id = (await say(w.edB, 'group', 'private words one')).body.message.id as string;
    await edit(w.edB, 'group', id, 'private words two');
    const open = (await say(w.edB, 'general', 'public words one')).body.message.id as string;
    await del(w.edB, 'general', open);
    await edit(w.alexB, 'general', open, 'refused');
    await w.fleet.flush();
    await settle();
    const rows = await logRows(w);
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['group_message_edited', 'general_message_deleted']));
    expect(kinds.filter((k) => k.endsWith('_message_edited') || k.endsWith('_message_deleted'))).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toMatch(/private words|public words|refused/);
    expect(rows.find((r) => r.kind === 'group_message_edited')!.detail).toContain(id.slice(0, 12));
  });

  it('does not make an edit or a deletion a new unread message for anyone', async () => {
    const w = await world();
    const unread = async (b: B) => ((await b.get(CH)).body.channels as { id: string; unread: number }[]).find((c) => c.id === 'general')!.unread;
    const id = (await say(w.alexB, 'general', 'from Alex')).body.message.id as string;
    expect(await unread(w.edB)).toBe(1);
    w.tick(1000);
    expect((await edit(w.alexB, 'general', id, 'from Alex, edited')).status).toBe(200);
    expect(await unread(w.edB)).toBe(1);
    expect((await w.edB.post(`${CH}/read`).set(H).send({ thread: 'public', upTo: null })).status).toBe(200);
    expect((await edit(w.alexB, 'general', id, 'from Alex, edited twice')).status).toBe(200);
    expect(await unread(w.edB)).toBe(0);
    expect((await del(w.alexB, 'general', id)).status).toBe(200);
    expect(await unread(w.edB)).toBe(0);
  });
});

describe('what an agent reads of an edited or a deleted message (#1269)', () => {
  it('returns the current text and editedAt for an edited one, and only the tombstone fields for a deleted one', async () => {
    const w = await world();
    const called = (await say(w.edB, 'group', '@Tester@ci-runner-01 look at this')).body.message.id as string;
    const plain = (await say(w.edB, 'group', 'plain v1')).body.message.id as string;
    const gone = (await say(w.edB, 'group', 'plain to delete')).body.message.id as string;
    w.tick(2_000);
    expect((await edit(w.edB, 'group', plain, 'plain v2')).status).toBe(200);
    w.tick(2_000);
    expect((await del(w.edB, 'group', gone)).status).toBe(200);
    const res = await request(w.app).get('/api/fleet/sessions/sess-tester/chat/channels/group/messages').set('X-Podium-Token', w.ed.token);
    expect(res.status).toBe(200);
    const by = (id: string) => res.body.messages.find((m: { id: string }) => m.id === id);
    expect(by(called)).not.toHaveProperty('editedAt');
    expect(by(called)).not.toHaveProperty('deleted');
    expect(by(plain)).toMatchObject({ text: 'plain v2', editedAt: expect.any(Number) });
    const tomb = by(gone);
    expect(Object.keys(tomb).sort()).toEqual(['authorKind', 'authorName', 'createdAt', 'deleted', 'deletedAt', 'id', 'replyTo']);
    expect(tomb).toMatchObject({ id: gone, authorKind: 'person', authorName: 'Ed', replyTo: null, deleted: true, deletedAt: expect.any(Number) });
    expect(JSON.stringify(res.body)).not.toMatch(/plain v1|plain to delete/);
  });

  it('does not count a deleted call as a call into the channel', async () => {
    const w = await world();
    expect((await w.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: true })).status).toBe(200);
    const held = (await say(w.edB, 'group', '@Tester@ci-runner-01 held call')).body.message.id as string;
    expect((await del(w.edB, 'group', held)).status).toBe(200);
    const res = await request(w.app).get('/api/fleet/sessions/sess-tester/chat/channels/group/messages').set('X-Podium-Token', w.ed.token);
    expect(res.status).toBe(403);
  });
});

describe('a person edits and deletes their own direct message (#1269)', () => {
  const MSG = 'Please look at the build, Alex.';
  const toAlex = async (w: W, text = MSG) => {
    const sent = await w.edB.post(`${CH}/dm/me/sess-alex/messages`).set(H).send({ text });
    expect(sent.status).toBe(202);
    return sent.body.message as { id: string; state: string; canChange: boolean };
  };
  const requestsOf = async (b: B) => ((await b.get('/api/fleet/respond/peers')).body.requests ?? []) as { id: string; kind: string }[];
  const thread = (b: B, path = 'me/sess-alex') => b.get(`${CH}/dm/${path}/messages`);

  it('edits a message that waits for approval, redacted, with the new text for its owner and no new request', async () => {
    const w = await world();
    const m = await toAlex(w);
    expect(m).toMatchObject({ state: 'approval', canChange: true });
    w.tick(3_000);
    const res = await dmEdit(w.edB, 'me/sess-alex', m.id, 'Look at the build please, key sk-abcdefghijklmnopqrstuvwxyz123456.');
    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ id: m.id, text: expect.stringContaining('[redacted]'), editedAt: w.now(), deletedAt: null, canChange: true, changeWhy: null, state: 'approval' });
    expect(res.body.message).not.toHaveProperty('authorId');
    // The owner reads the new text, and cannot change it.
    const theirs = await thread(w.alexB, 'person:1/sess-alex');
    expect(theirs.body.messages[0]).toMatchObject({ text: expect.stringContaining('Look at the build please'), editedAt: w.now(), canChange: false, changeWhy: null });
    expect(await requestsOf(w.alexB)).toHaveLength(1);
    expect(JSON.stringify((await thread(w.edB)).body)).not.toContain('Please look at the build, Alex.');
  });

  it('answers 400 and 422 for a bad text and changes nothing', async () => {
    const w = await world();
    const m = await toAlex(w);
    expect((await dmEdit(w.edB, 'me/sess-alex', m.id, '  ')).status).toBe(400);
    expect((await dmEdit(w.edB, 'me/sess-alex', m.id, '\u200B')).status).toBe(400);
    expect((await dmEdit(w.edB, 'me/sess-alex', m.id, 'x'.repeat(4001))).status).toBe(422);
    expect((await thread(w.edB)).body.messages[0]).toMatchObject({ text: MSG, editedAt: null });
  });

  it('deletes a message that waits for approval: a tombstone for both, and the owner\'s request is closed', async () => {
    const w = await world();
    const m = await toAlex(w);
    expect(await requestsOf(w.alexB)).toHaveLength(1);
    w.tick(1_000);
    const res = await dmDel(w.edB, 'me/sess-alex', m.id);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ id: m.id, text: '', deletedAt: w.now(), canChange: false, changeWhy: null, state: 'dropped', reason: 'Deleted by its sender.', waitingFor: null });
    expect(await requestsOf(w.alexB)).toHaveLength(0);
    for (const [b, path] of [[w.edB, 'me/sess-alex'], [w.alexB, 'person:1/sess-alex']] as const) {
      const t = await thread(b, path);
      expect(t.body.messages).toHaveLength(1);
      expect(t.body.messages[0]).toMatchObject({ id: m.id, text: '', deletedAt: w.now(), canChange: false, reason: 'Deleted by its sender.' });
      expect(JSON.stringify(t.body)).not.toContain('look at the build');
    }
    // A second delete, and an edit of the tombstone.
    for (const again of [await dmDel(w.edB, 'me/sess-alex', m.id), await dmEdit(w.edB, 'me/sess-alex', m.id, 'back')]) {
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ ok: false, reason: 'deleted', error: 'This message has already been deleted.' });
    }
    // Nothing is handed to the agent.
    expect(((await alexOne(w)).body.peerDeliveries ?? []) as unknown[]).toHaveLength(0);
  });

  it('locks a message its owner approved before the agent fetched it, for edit and delete, and says so in the thread', async () => {
    const w = await world();
    const m = await toAlex(w);
    const [req] = await requestsOf(w.alexB);
    expect((await w.alexB.post(`/api/fleet/respond/peers/requests/${req!.id}`).set(H).send({ answer: 'deliver' })).status).toBe(200);
    const words = 'Podium has already sent this message to review, so it can no longer be changed.';
    expect((await thread(w.edB)).body.messages[0]).toMatchObject({ state: 'ready', canChange: false, changeWhy: words });
    for (const res of [await dmEdit(w.edB, 'me/sess-alex', m.id, 'edited while ready'), await dmDel(w.edB, 'me/sess-alex', m.id)]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ ok: false, reason: 'locked', error: words });
    }
    expect((await thread(w.edB)).body.messages[0]).toMatchObject({ text: MSG, editedAt: null, deletedAt: null });
    // The agent gets the text the owner approved.
    expect(((await alexOne(w)).body.peerDeliveries ?? []) as { text: string }[]).toHaveLength(1);
  });

  it('still changes a ready message that needed no approval, because its link was already open', async () => {
    const w = await world();
    await toAlex(w);
    const [req] = await requestsOf(w.alexB);
    expect((await w.alexB.post(`/api/fleet/respond/peers/requests/${req!.id}`).set(H).send({ answer: 'deliver' })).status).toBe(200);
    const second = await toAlex(w, 'A second one, over the open link.');
    expect(second).toMatchObject({ state: 'ready', canChange: true });
    expect((await dmEdit(w.edB, 'me/sess-alex', second.id, 'edited while ready')).status).toBe(200);
    expect((await dmDel(w.edB, 'me/sess-alex', second.id)).status).toBe(200);
  });

  it('refuses a message that was handed to an agent, in words that name it, and shows it in the thread', async () => {
    const w = await world();
    const m = await toAlex(w);
    const [req] = await requestsOf(w.alexB);
    await w.alexB.post(`/api/fleet/respond/peers/requests/${req!.id}`).set(H).send({ answer: 'deliver' });
    const handed = ((await alexOne(w)).body.peerDeliveries ?? []) as { text: string }[];
    expect(handed).toHaveLength(1);
    const words = 'Podium has already sent this message to review, so it can no longer be changed.';
    for (const res of [await dmEdit(w.edB, 'me/sess-alex', m.id, 'too late'), await dmDel(w.edB, 'me/sess-alex', m.id)]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ ok: false, reason: 'locked', error: words });
    }
    expect((await thread(w.edB)).body.messages[0]).toMatchObject({ text: MSG, state: 'handed', canChange: false, changeWhy: words, editedAt: null, deletedAt: null });
  });

  it.each(['queued', 'delivered'] as const)('refuses a message to the person\'s own agent that is %s', async (state) => {
    const w = await world();
    const sent = await w.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: 'please run the suite' });
    expect(sent.status).toBe(202);
    const id = sent.body.message.id as string;
    expect(sent.body.message).toMatchObject({ state: 'queued', canChange: false, changeWhy: LOCKED_WORDS });
    if (state === 'delivered') expect(await w.fleet.peers.messages.result('sess-tester', id, 'took')).toBe('new');
    for (const res of [await dmEdit(w.edB, 'me/sess-tester', id, 'x'), await dmDel(w.edB, 'me/sess-tester', id)]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ reason: 'locked', error: LOCKED_WORDS });
    }
    const page = await thread(w.edB, 'me/sess-tester');
    expect(page.body.messages[0]).toMatchObject({ text: 'please run the suite', canChange: false, changeWhy: LOCKED_WORDS });
  });

  it('answers 404 for a message that is not in the conversation, or is not there', async () => {
    const w = await world();
    const m = await toAlex(w);
    const own = await w.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: 'for the tester' });
    for (const f of [(id: string) => dmEdit(w.edB, 'me/sess-tester', id, 'x'), (id: string) => dmDel(w.edB, 'me/sess-tester', id)]) {
      expect((await f(m.id)).status).toBe(404);
      expect((await f('msg_nothere')).status).toBe(404);
    }
    expect((await dmEdit(w.edB, 'me/sess-nobody', m.id, 'x')).status).toBe(404);
    expect((await dmEdit(w.edB, 'me/sess-alex', own.body.message.id, 'x')).status).toBe(404);
    expect((await thread(w.edB)).body.messages[0].text).toBe(MSG);
  });

  it('refuses the owner of the agent, an Admin who reads, another person, the admin secret and a signed-out request', async () => {
    const w = await world();
    const m = await toAlex(w);
    for (const res of [await dmEdit(w.alexB, 'person:1/sess-alex', m.id, 'Alex rewrites'), await dmDel(w.alexB, 'person:1/sess-alex', m.id)]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Only the person who wrote a message can change it.');
    }
    const root = await signedIn(w, 'Admin', SECRET);
    for (const res of [await dmEdit(root, 'person:1/sess-alex', m.id, 'x'), await dmDel(root, 'person:1/sess-alex', m.id), await dmEdit(root, 'me/sess-alex', m.id, 'x')]) expect([403, 404]).toContain(res.status);
    expect((await dmEdit(root, 'person:1/sess-alex', m.id, 'x')).status).toBe(403);
    expect((await request(w.app).patch(`${CH}/dm/me/sess-alex/messages/${m.id}`).set(H).send({ text: 'x' })).status).toBe(403);
    expect((await request(w.app).delete(`${CH}/dm/me/sess-alex/messages/${m.id}`).set(H)).status).toBe(403);
    expect((await thread(w.edB)).body.messages[0]).toMatchObject({ text: MSG, editedAt: null, deletedAt: null });
  });

  it('signals both people, and the owner\'s count of what waits, with no text, and logs ids only', async () => {
    const w = await world();
    const stream = watchStream(w);
    const m = await toAlex(w);
    const before = stream.count();
    expect((await dmEdit(w.edB, 'me/sess-alex', m.id, 'a private reword')).status).toBe(200);
    expect(stream.count()).toBeGreaterThan(before);
    const afterEdit = stream.count();
    expect((await dmEdit(w.alexB, 'person:1/sess-alex', m.id, 'x')).status).toBe(403);
    expect(stream.count()).toBe(afterEdit);
    expect((await dmDel(w.edB, 'me/sess-alex', m.id)).status).toBe(200);
    expect(stream.count()).toBeGreaterThan(afterEdit);
    expect(stream.raw()).not.toContain('reword');
    await w.fleet.flush();
    await settle();
    const rows = await logRows(w);
    expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining(['chat_message_edited', 'chat_message_deleted']));
    expect(JSON.stringify(rows)).not.toMatch(/private reword|look at the build/);
  });

  it('changes a message to two agents as one: shown once, edited together, deleted together', async () => {
    const w = await world();
    await linkedConversation(w);
    const person = w.ed.person;
    const peers = w.fleet.peers.messages;
    const a = await peers.sendFromPerson({ ownerId: person.id, person: 'Ed', toSession: 'sess-dev', withSession: 'sess-tester', text: 'carry on, both', authorId: person.id });
    const b = await peers.sendFromPerson({ ownerId: person.id, person: 'Ed', toSession: 'sess-tester', withSession: 'sess-dev', text: 'carry on, both', authorId: person.id });
    expect('ok' in a || 'ok' in b).toBe(false);
    const path = 'sess-dev/sess-tester';
    const view = async () => ((await thread(w.edB, path)).body.messages as { id: string; text: string; to: unknown[]; canChange: boolean }[]).filter((m) => m.text !== 'agent hello');
    expect(await view()).toMatchObject([{ text: 'carry on, both', canChange: true }]);
    expect((await view())[0]!.to).toHaveLength(2);
    const id = (await view())[0]!.id;
    const edited = await dmEdit(w.edB, path, id, 'carry on, both of you');
    expect(edited.status).toBe(200);
    expect(edited.body.message.to).toHaveLength(2);
    expect(await view()).toMatchObject([{ text: 'carry on, both of you' }]);
    const gone = await dmDel(w.edB, path, id);
    expect(gone.status).toBe(200);
    expect(gone.body.message).toMatchObject({ text: '', canChange: false });
    expect(gone.body.message.to).toHaveLength(2);
    expect(await view()).toHaveLength(1);
  });

  it('locks a message to two agents as one when either was sent, naming both', async () => {
    const w = await world();
    await linkedConversation(w);
    const peers = w.fleet.peers.messages;
    await peers.sendFromPerson({ ownerId: w.ed.person.id, person: 'Ed', toSession: 'sess-dev', withSession: 'sess-tester', text: 'both of you', authorId: w.ed.person.id });
    await peers.sendFromPerson({ ownerId: w.ed.person.id, person: 'Ed', toSession: 'sess-tester', withSession: 'sess-dev', text: 'both of you', authorId: w.ed.person.id, state: 'queued' });
    const m = ((await thread(w.edB, 'sess-dev/sess-tester')).body.messages as { id: string; text: string; canChange: boolean; changeWhy: string | null }[]).find((x) => x.text === 'both of you')!;
    expect(m.canChange).toBe(false);
    expect(m.changeWhy).toBe('Podium has already sent this message to Tester, so it can no longer be changed.');
    const res = await dmEdit(w.edB, 'sess-dev/sess-tester', m.id, 'x');
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('locked');
  });

  it('does not let a person who was deleted and made again under the same name change the old one\'s message', async () => {
    const w = await world();
    const peers = w.fleet.peers.messages;
    const old = await peers.sendFromPerson({ ownerId: w.ed.person.id, person: 'Ed', toSession: 'sess-tester', text: 'from the earlier Ed', authorId: w.ed.person.id + 1000 });
    expect('ok' in old).toBe(false);
    const row = old as { id: string };
    expect((await dmEdit(w.edB, 'me/sess-tester', row.id, 'mine now')).status).toBe(403);
    expect((await dmDel(w.edB, 'me/sess-tester', row.id)).status).toBe(403);
    expect((await thread(w.edB, 'me/sess-tester')).body.messages[0]).toMatchObject({ text: 'from the earlier Ed', canChange: false, changeWhy: null });
  });
});

describe('a message that waits for another person\'s approval, and the copy Alex is asked about (#1269)', () => {
  const copies = async (b: B, agent = 'sess-alex') => (await b.get(`${CH}/dm/person:1/${agent}/messages`)).body.messages as { id: string; text: string; state: string; deletedAt: number | null }[];
  const requestsOf = async (b: B) => ((await b.get('/api/fleet/respond/peers')).body.requests ?? []) as { id: string }[];
  const approveAll = async (b: B) => {
    for (const r of await requestsOf(b)) expect((await b.post(`/api/fleet/respond/peers/requests/${r.id}`).set(H).send({ answer: 'deliver' })).status).toBe(200);
  };
  const ASK = '@review@alex-box please look';

  it('edits the copy for its owner and the message, and shows the page that it can be changed, with no copy id', async () => {
    const w = await world();
    const sent = await say(w.edB, 'general', ASK);
    expect(sent.body.message.mentions[0].state).toBe('approval');
    expect(sent.body.message).toMatchObject({ canChange: true, changeWhy: null });
    expect(JSON.stringify(sent.body)).not.toContain('copyId');
    expect((await copies(w.alexB))[0]!.text).toContain('please look');
    w.tick(1_000);
    const res = await edit(w.edB, 'general', sent.body.message.id, `${ASK} again, with key sk-abcdefghijklmnopqrstuvwxyz123456`);
    expect(res.status).toBe(200);
    expect(res.body.message.text).toContain('again');
    expect(JSON.stringify(res.body)).not.toContain('copyId');
    const theirs = (await copies(w.alexB))[0]!;
    expect(theirs.text).toContain('again');
    expect(theirs.text).toContain('[redacted]');
    expect(theirs.text).not.toContain('sk-abcdef');
    expect(await requestsOf(w.alexB)).toHaveLength(1);
    expect(JSON.stringify((await read(w.edB, 'general')).body)).not.toContain('copyId');
  });

  it('deletes the copy with the message: the request closes and nothing is handed over', async () => {
    const w = await world();
    const sent = await say(w.edB, 'general', ASK);
    expect(await requestsOf(w.alexB)).toHaveLength(1);
    const res = await del(w.edB, 'general', sent.body.message.id);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ text: '', mentions: [], canChange: false });
    expect(await requestsOf(w.alexB)).toHaveLength(0);
    const theirs = (await copies(w.alexB))[0]!;
    expect(theirs).toMatchObject({ text: '', state: 'dropped', deletedAt: expect.any(Number) });
    expect(((await alexOne(w)).body.peerDeliveries ?? []) as unknown[]).toHaveLength(0);
  });

  it('refuses a message whose copy was handed over meanwhile, with the locked words, and changes nothing', async () => {
    const w = await world();
    const sent = await say(w.edB, 'general', ASK);
    const id = sent.body.message.id as string;
    await approveAll(w.alexB);
    expect(((await alexOne(w)).body.peerDeliveries ?? []) as unknown[]).toHaveLength(1);
    await settle();
    // The channel's own mention moves to waiting as the answer arrives; put it back to the state it had a moment before, as a race would leave it.
    await w.fleet.chat.core.store.public.setMention('general', id, 0, { state: 'approval' });
    for (const res of [await edit(w.edB, 'general', id, `${ASK} changed`), await del(w.edB, 'general', id)]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ reason: 'locked', error: 'Podium has already sent this message to review, so it can no longer be changed.' });
    }
    expect((await read(w.edB, 'general')).body.messages[0]).toMatchObject({ text: ASK, editedAt: null, deletedAt: null });
    expect((await copies(w.alexB))[0]).toMatchObject({ text: ASK, deletedAt: null });
  });

  it('refuses a message whose copy its owner approved before the agent fetched it, with the locked words, and changes nothing', async () => {
    const w = await world();
    const sent = await say(w.edB, 'general', ASK);
    const id = sent.body.message.id as string;
    await approveAll(w.alexB);
    // The channel's own mention moves to waiting as the answer arrives; put it back to the state it had a moment before, as a race would leave it. The copy was approved and not fetched.
    await settle();
    await w.fleet.chat.core.store.public.setMention('general', id, 0, { state: 'approval' });
    expect((await copies(w.alexB))[0]).toMatchObject({ state: 'ready' });
    for (const res of [await edit(w.edB, 'general', id, `${ASK} changed`), await del(w.edB, 'general', id)]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ reason: 'locked', error: 'Podium has already sent this message to review, so it can no longer be changed.' });
    }
    expect((await read(w.edB, 'general')).body.messages[0]).toMatchObject({ text: ASK, editedAt: null, deletedAt: null });
    expect((await copies(w.alexB))[0]).toMatchObject({ text: ASK, deletedAt: null });
    // The agent gets the text its owner approved.
    expect(((await alexOne(w)).body.peerDeliveries ?? []) as { text: string }[]).toHaveLength(1);
  });

  it('puts the first copy back when a later one cannot be changed, so no copy says what the message does not', async () => {
    const w = await world();
    expect((await alexTwo(w)).status).toBe(200);
    const sent = await say(w.edB, 'general', '@review@alex-box @second@alex-box2 both of you');
    const id = sent.body.message.id as string;
    expect(sent.body.warnings).toEqual([]);
    expect(sent.body.message.mentions.map((m: { state: string }) => m.state)).toEqual(['approval', 'approval']);
    await approveAll(w.alexB);
    // Only the second agent fetches its message, so only that copy is handed over.
    expect(((await alexTwo(w)).body.peerDeliveries ?? []) as unknown[]).toHaveLength(1);
    await settle();
    await w.fleet.chat.core.store.public.setMention('general', id, 0, { state: 'approval' });
    await w.fleet.chat.core.store.public.setMention('general', id, 1, { state: 'approval' });
    const res = await edit(w.edB, 'general', id, '@review@alex-box @second@alex-box2 changed words');
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('locked');
    expect((await copies(w.alexB, 'sess-alex'))[0]!.text).toBe('@review@alex-box @second@alex-box2 both of you');
    expect((await read(w.edB, 'general')).body.messages[0].text).toBe('@review@alex-box @second@alex-box2 both of you');
  });

  it('keeps the refusal for an approval mention stored before copies were kept, and says so in the view', async () => {
    const w = await world();
    const old = await w.fleet.chat.core.store.public.post('general', { authorKind: 'person', authorRef: 'Ed', authorName: 'Ed', text: '@review@alex-box from before', authorId: w.ed.person.id, mentions: [{ sessionId: 'sess-alex', peerKey: null, typed: 'review@alex-box', state: 'approval', why: 'Waiting for Alex to approve' }] });
    const view = (await read(w.edB, 'general')).body.messages[0];
    expect(view).toMatchObject({ canChange: false, changeWhy: 'This message is waiting for Alex to approve, so it cannot be changed now.' });
    for (const res of [await edit(w.edB, 'general', old.id, '@review@alex-box changed'), await del(w.edB, 'general', old.id)]) {
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('approval');
    }
  });

  describe('the length limit of the agent\'s owner', () => {
    const LIMIT = 20;
    const words = (n: number) => `The message is ${n} characters, over the limit of ${LIMIT}. Send a shorter one.`;
    const limitAlex = async (w: W) => expect(await w.fleet.peers.setDefaults(w.alex.person.id, { limits: { maxChars: LIMIT } }, { name: 'Alex', admin: false })).toMatchObject({ ok: true });

    it('refuses an edit of a direct message to it in the words of a send, and changes nothing', async () => {
      const w = await world();
      await limitAlex(w);
      const sent = await w.edB.post(`${CH}/dm/me/sess-alex/messages`).set(H).send({ text: 'a short text' });
      expect(sent.status).toBe(202);
      const long = 'x'.repeat(30);
      const res = await dmEdit(w.edB, 'me/sess-alex', sent.body.message.id, long);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe(words(30));
      expect((await w.edB.get(`${CH}/dm/me/sess-alex/messages`)).body.messages[0]).toMatchObject({ text: 'a short text', editedAt: null });
      // The send path answers the same status and words.
      expect((await dmDel(w.edB, 'me/sess-alex', sent.body.message.id)).status).toBe(200);
      const again = await w.edB.post(`${CH}/dm/me/sess-alex/messages`).set(H).send({ text: long });
      expect([again.status, again.body.error]).toEqual([422, words(30)]);
      // At the limit it goes through.
      const ok = await w.edB.post(`${CH}/dm/me/sess-alex/messages`).set(H).send({ text: 'short' });
      expect((await dmEdit(w.edB, 'me/sess-alex', ok.body.message.id, 'y'.repeat(LIMIT))).status).toBe(200);
    });

    it('refuses an edit of a channel message that waits for it, changing neither the copy nor the message', async () => {
      const w = await world();
      await limitAlex(w);
      const sent = await say(w.edB, 'general', '@review@alex-box hi');
      expect(sent.body.message.mentions[0].state).toBe('approval');
      const text = `@review@alex-box ${'x'.repeat(30)}`;
      const res = await edit(w.edB, 'general', sent.body.message.id, text);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe(words(text.length));
      expect((await read(w.edB, 'general')).body.messages[0]).toMatchObject({ text: '@review@alex-box hi', editedAt: null });
      expect((await copies(w.alexB))[0]!.text).toBe('@review@alex-box hi');
    });
  });
});

describe('a message older than the newest 1000 of its channel (#1269)', () => {
  it('can still be edited and deleted by its author, in a public channel and in the group', async () => {
    const w = await world();
    const store = w.fleet.chat.core.store;
    const mineOld = { authorKind: 'person' as const, authorRef: 'Ed', authorName: 'Ed', authorId: w.ed.person.id };
    const g = await store.group.post(group(w), { ...mineOld, text: 'oldest in my group' });
    const p = await store.public.post('general', { ...mineOld, text: 'oldest in general' });
    for (let i = 0; i < 1005; i++) {
      await store.group.post(group(w), { authorKind: 'orchestrator', authorRef: 'sess-dev', authorName: 'dev', text: `filler ${i}` });
      await store.public.post('general', { authorKind: 'orchestrator', authorRef: 'sess-dev', authorName: 'dev', text: `filler ${i}` });
    }
    expect((await edit(w.edB, 'general', p.id, 'oldest in general, edited')).status).toBe(200);
    expect((await edit(w.edB, 'group', g.id, 'oldest in my group, edited')).status).toBe(200);
    expect((await del(w.edB, 'general', p.id)).status).toBe(200);
    const gone = await del(w.edB, 'group', g.id);
    expect(gone.status).toBe(200);
    expect(gone.body.message).toMatchObject({ id: g.id, text: '', deletedAt: expect.any(Number) });
    expect((await del(w.edB, 'group', g.id)).status).toBe(409);
    expect((await edit(w.edB, 'group', 'grp_00000000_000000000000000000000000', 'x')).status).toBe(404);
  });
});
