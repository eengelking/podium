// The Chat page's server (#1034): the browser's routes under /api/fleet/respond/chat, the reporter-token route shapes for agents, mentions and
// their delivery, pausing and disconnecting a channel, the direct messages a person adds to, how a conversation hides and returns, retention,
// the content-free stream signal and the audit rows. The privacy rule (a direct message's text is never returned with a channel's) is held here
// with two people, and by `chatSeparation.test.ts` against the route table.
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

const SECRET = 'admin-secret-for-the-chat-tests';
const H = { 'X-Podium-Respond': '1' };
const HA = { 'X-Podium-Admin': '1' };
const CH = '/api/fleet/respond/chat';
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

async function setup(opts: { flag?: boolean } = {}) {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const storage = openSqliteStorage(':memory:', now());
  const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, now);
  const people = storage.people;
  const lockout = new Lockout(now);
  const respondBridge = createRespondBridge();
  const lines: string[] = [];
  const logger = createLogger({ format: 'json', level: 'debug', write: (l) => lines.push(l) });
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: SECRET, people, reporters: storage.reporters, lockout, respondBridge, logger }));
  app.use('/api/admin', createAdminRouter({ secret: SECRET, storage, people, reporters: storage.reporters, peers: fleet.peers, chat: fleet.chat.settings, features: fleet.features, lockout, respondBridge, now, log: () => {} }));
  await fleet.init();
  closers.push(() => fleet.close());
  if (opts.flag !== false) {
    await fleet.features.setFeature(PEER_MESSAGING, true);
    await fleet.features.setFeature(RESPOND, true);
    await fleet.features.setFeature(ACTIVITY_FEED, true);
  }
  const ed = await people.createPerson('Ed');
  const alex = await people.createPerson('Alex');
  return { app, fleet, people, ed, alex, lines, tick: (ms: number) => (clock += ms), now };
}
type S = Awaited<ReturnType<typeof setup>>;

const ACCEPTS = ['message', 'command', 'question', 'plan-approve', 'plan-feedback', 'permission'] as const;
const MAC = { name: 'ed-mbp', id: 'macmacmac001' };
const LINUX = { name: 'ci-runner-01', id: 'lnxlnxlnx001' };
const BOX = { name: 'alex-box', id: 'alxalxalx001' };
const PI = { name: 'build-pi', id: 'pipipipipi01' };

function report(userName: string, sid: string, name: string, machine: { name: string; id: string }, over: Partial<Report['session']> = {}): Report {
  const r = fixtureReport();
  r.session = { ...r.session, id: sid, name, status: 'waiting', waitReason: 'input', peers: true, respond: { level: 'everything', accepts: [...ACCEPTS], limits: [] }, ...over };
  r.userName = userName;
  r.machine = { ...machine, os: 'macOS 27.0.1' };
  return r;
}
const post = (s: S, token: string, r: Report) => request(s.app).post('/api/fleet/report').set('X-Podium-Token', token).send(r);
const dev = (s: S, over: Partial<Report['session']> = {}) => post(s, s.ed.token, report('Ed', 'sess-dev', 'dev', MAC, over));
const tester = (s: S, over: Partial<Report['session']> = {}) => post(s, s.ed.token, report('Ed', 'sess-tester', 'Tester', LINUX, over));
const alexOne = (s: S, over: Partial<Report['session']> = {}) => post(s, s.alex.token, report('Alex', 'sess-alex', 'review', BOX, over));

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

/** Ed's two orchestrators and Alex's, all reporting, with Ed and Alex signed in. */
async function world() {
  const s = await setup();
  expect((await dev(s, { status: 'running', waitReason: null })).status).toBe(200);
  expect((await tester(s)).status).toBe(200);
  expect((await alexOne(s)).status).toBe(200);
  const ed = await signedIn(s, 'Ed', s.ed.token);
  const alex = await signedIn(s, 'Alex', s.alex.token);
  return { ...s, edB: ed, alexB: alex };
}
type W = Awaited<ReturnType<typeof world>>;

const say = (b: ReturnType<typeof request.agent>, channel: string, text: string, extra: Record<string, unknown> = {}) => b.post(`${CH}/channels/${channel}/messages`).set(H).send({ text, ...extra });
const read = (b: ReturnType<typeof request.agent>, channel: string, q = '') => b.get(`${CH}/channels/${channel}/messages${q}`);
const texts = (res: { body: { messages: { text: string }[] } }) => res.body.messages.map((m) => m.text);
/** Lets the Admin log's writes, which the events start without waiting, finish. */
const settle = () => new Promise((r) => setTimeout(r, 20));
const logRows = async (s: S) => (await s.people.listLog({ page: 1, pageSize: 200 })).rows;
const logKinds = async (s: S) => (await logRows(s)).map((r) => r.kind);
/** The deliveries a session's next report is answered with. */
const deliveriesFor = async (s: S, who: 'tester' | 'dev') => {
  const r = who === 'tester' ? await tester(s) : await dev(s);
  return (r.body.deliveries ?? []) as { id: string; kind: string; text?: string }[];
};
/** Both agents linked by a right, so there is a conversation to add to. */
async function linkedConversation(w: W) {
  const set = await w.edB.put('/api/fleet/respond/peers/rights').set(H).send({ from: MAC.id, to: LINUX.id, level: 'send' });
  expect(set.status).toBe(200);
  const sent = await request(w.app).post('/api/fleet/sessions/sess-dev/peers/messages').set('X-Podium-Token', w.ed.token).send({ to: 'Tester@ci-runner-01', text: 'agent hello' });
  expect(sent.status).toBe(202);
}

describe('the gate and the overview', () => {
  it('is refused while orchestrator messaging is off, and without a sign-in', async () => {
    const off = await setup({ flag: false });
    await dev(off);
    expect((await request(off.app).get(CH)).status).toBe(403);
    const s = await world();
    expect((await request(s.app).get(CH)).status).toBe(403);
    expect((await s.edB.get(CH)).status).toBe(200);
  });

  it('lists General and My group, the agents and the settings, with zero counts', async () => {
    const s = await world();
    const res = await s.edB.get(CH);
    expect(res.body).toMatchObject({ enabled: true, me: { name: 'Ed', admin: false }, settings: { maxChars: 4000, perMinute: 6, retainDays: 30, graceHours: 24, everyone: false } });
    expect(res.body.channels.map((c: { id: string }) => c.id)).toEqual(['general', 'group']);
    expect(res.body.channels[0]).toMatchObject({ name: 'General', thread: 'public', unread: 0, mentions: 0, paused: false, disconnected: false, can: { pause: true, pauseEveryone: false, disconnect: true, removeAll: false } });
    expect(res.body.channels[1]).toMatchObject({ name: 'My group', thread: 'group:ed', can: { pause: true, disconnect: true, removeAll: true } });
    expect(res.body.agents.map((a: { address: string }) => a.address).sort()).toEqual(['Tester@ci-runner-01', 'dev@ed-mbp']);
    expect(res.body.agents.some((a: { name: string }) => a.name === 'review')).toBe(false);
    expect(res.body.people.map((p: { name: string }) => p.name).sort()).toEqual(['Alex', 'Ed']);
    expect(res.body.directs).toEqual([]);
  });

  it('gives an Admin who signed in with the secret General and no group of their own', async () => {
    const s = await world();
    const a = await signedIn(s, 'Admin', SECRET);
    const res = await a.get(CH);
    expect(res.body.me).toMatchObject({ name: 'Admin', admin: true });
    expect(res.body.channels.map((c: { id: string }) => c.id)).toEqual(['general']);
    expect(res.body.channels[0].can).toMatchObject({ pauseEveryone: true, removeAll: true });
  });
});

describe('posting to a channel', () => {
  it('stores a message in My group and pages back with a cursor', async () => {
    const s = await world();
    for (const t of ['one', 'two', 'three']) expect((await say(s.edB, 'group', t)).status).toBe(201);
    const p1 = await read(s.edB, 'group', '?limit=2');
    expect(texts(p1)).toEqual(['two', 'three']);
    expect(p1.body.older).toEqual(expect.any(String));
    expect(p1.body.total).toBe(3);
    const p2 = await read(s.edB, 'group', `?limit=2&before=${encodeURIComponent(p1.body.older)}`);
    expect(texts(p2)).toEqual(['one']);
    expect(p2.body.older).toBeNull();
    expect(p1.body.messages[1]).toMatchObject({ authorKind: 'person', authorName: 'Ed', mine: true, mentions: [] });
    expect((await read(s.edB, 'group', '?before=junk')).status).toBe(400);
    expect((await read(s.edB, 'nowhere')).status).toBe(404);
  });

  it('keeps My group to its person: another person has their own, and cannot read or clear Ed\'s', async () => {
    const s = await world();
    await say(s.edB, 'group', 'ED-GROUP-ONLY');
    expect(texts(await read(s.alexB, 'group'))).toEqual([]);
    expect((await read(s.alexB, 'group', '?owner=Ed')).status).toBe(403);
    expect((await s.alexB.delete(`${CH}/channels/group/messages`).set(H).send({ owner: 'Ed' })).status).toBe(403);
    expect((await s.alexB.put(`${CH}/channels/group/pause`).set(H).send({ owner: 'Ed', paused: true })).status).toBe(403);
    expect(JSON.stringify((await s.alexB.get(CH)).body)).not.toContain('ED-GROUP-ONLY');
    expect(texts(await read(s.edB, 'group'))).toEqual(['ED-GROUP-ONLY']);
  });

  it('lets an Admin read and clear another person\'s group by naming the owner', async () => {
    const s = await world();
    await say(s.edB, 'group', 'for the admin');
    const a = await signedIn(s, 'Admin', SECRET);
    expect((await read(a, 'group')).status).toBe(400);
    expect(texts(await read(a, 'group', '?owner=Ed'))).toEqual(['for the admin']);
    const cleared = await a.delete(`${CH}/channels/group/messages`).set(H).send({ owner: 'Ed' });
    expect(cleared.body).toMatchObject({ ok: true, removed: 1 });
  });

  it('lets an Admin read and stop another person\'s group but never write in it', async () => {
    const s = await world();
    await say(s.edB, 'group', 'for the admin');
    const admins = (await s.people.allGroups()).find((g) => g.name === 'Administrators')!;
    const rootB = await signedIn(s, 'Root', (await s.people.createPerson('Root', admins.id)).token);
    const secretB = await signedIn(s, 'Admin', SECRET);
    for (const b of [rootB, secretB]) {
      const sent = await say(b, 'group', '@dev@ed-mbp admin writes', { owner: 'Ed' });
      expect(sent.status).toBe(403);
      expect(sent.body.error).toBe('An Admin can read and stop a person\'s group but cannot write in it.');
      expect((await say(b, 'group', 'a reply', { owner: 'Ed', replyTo: 'x' })).status).toBe(403);
    }
    await s.fleet.flush();
    await settle();
    expect(texts(await read(s.edB, 'group'))).toEqual(['for the admin']);
    expect((await logRows(s)).filter((r) => r.kind === 'group_sent')).toHaveLength(1);
    expect(texts(await read(rootB, 'group', '?owner=Ed'))).toEqual(['for the admin']);
    // An Administrator still writes in their own group and in General.
    expect((await say(rootB, 'group', 'my own')).status).toBe(201);
    expect((await say(rootB, 'general', 'hello all')).status).toBe(201);
    expect((await rootB.put(`${CH}/channels/group/pause`).set(H).send({ owner: 'Ed', paused: true })).status).toBe(200);
  });

  it('shows General to every signed-in person and to no one else', async () => {
    const s = await world();
    expect((await say(s.alexB, 'general', 'hello everyone')).status).toBe(201);
    expect(texts(await read(s.edB, 'general'))).toEqual(['hello everyone']);
    expect((await request(s.app).get(`${CH}/channels/general/messages`)).status).toBe(403);
  });

  it('replaces secrets in the person\'s text before storing it', async () => {
    const s = await world();
    const res = await say(s.edB, 'general', 'use sk-abcdefghijklmnopqrstuvwxyz123456 and token=hunter2hunter2 now');
    expect(res.status).toBe(201);
    expect(res.body.message.text).not.toContain('sk-abcdef');
    expect(res.body.message.text).toContain('[redacted]');
    expect(JSON.stringify((await read(s.alexB, 'general')).body)).not.toContain('hunter2');
    expect(JSON.stringify((await read(s.alexB, 'general')).body)).not.toContain(s.ed.token);
  });

  it('refuses an empty message, a message over the Admin\'s length, and a post over the rate', async () => {
    const s = await world();
    expect((await say(s.edB, 'group', '   ')).status).toBe(400);
    const a = await adminAgent(s);
    expect((await a.put('/api/admin/settings').set(HA).send({ chat: { maxChars: 20, perMinute: 2 } })).status).toBe(200);
    const long = await say(s.edB, 'group', 'x'.repeat(21));
    expect(long.status).toBe(422);
    expect(long.body.error).toMatch(/21 characters.*20/);
    expect((await say(s.edB, 'group', 'a')).status).toBe(201);
    expect((await say(s.edB, 'group', 'b')).status).toBe(201);
    const third = await say(s.edB, 'group', 'c');
    expect(third.status).toBe(429);
    expect(third.body.error).toMatch(/2 messages a minute/);
    expect((await say(s.alexB, 'group', 'hi')).status).toBe(201);
    s.tick(61_000);
    expect((await say(s.edB, 'group', 'd')).status).toBe(201);
  });
});

describe('addressing with @', () => {
  it('delivers a name@location mention to the live agent, as a message with Podium\'s frame, and says Waiting', async () => {
    const s = await world();
    const res = await say(s.edB, 'group', '@Tester@ci-runner-01 run the Debian tests');
    expect(res.status).toBe(201);
    expect(res.body.message.mentions).toEqual([expect.objectContaining({ typed: 'Tester@ci-runner-01', sessionId: 'sess-tester', state: 'waiting', why: null })]);
    const got = await deliveriesFor(s, 'tester');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'message' });
    expect(got[0]!.text).toContain('run the Debian tests');
    expect(got[0]!.text).toMatch(/Podium Chat.*My group.*Ed/);
    // The other agent heard nothing.
    expect(await deliveriesFor(s, 'dev')).toEqual([]);
  });

  it('moves a mention to working when the agent takes it, and to done when the agent replies in the thread', async () => {
    const s = await world();
    const res = await say(s.edB, 'group', '@Tester@ci-runner-01 go');
    const [d] = await deliveriesFor(s, 'tester');
    const took = await request(s.app).post(`/api/fleet/sessions/sess-tester/deliveries/${d!.id}/result`).set('X-Podium-Token', s.ed.token).send({ result: 'took' });
    expect(took.status).toBe(200);
    let page = await read(s.edB, 'group');
    expect(page.body.messages[0].mentions[0].state).toBe('working');
    const reply = await request(s.app).post('/api/fleet/sessions/sess-tester/chat/channels/group/messages').set('X-Podium-Token', s.ed.token).send({ text: 'Done, 14 of 14 pass.', replyTo: res.body.message.id });
    expect(reply.status).toBe(201);
    page = await read(s.edB, 'group');
    expect(page.body.messages[0].mentions[0].state).toBe('done');
    expect(page.body.messages[1]).toMatchObject({ authorKind: 'orchestrator', authorName: 'Tester', replyTo: res.body.message.id, mine: false });
  });

  it('marks a mention not delivered when the agent did not take it, with the reason', async () => {
    const s = await world();
    await say(s.edB, 'group', '@Tester@ci-runner-01 go');
    const [d] = await deliveriesFor(s, 'tester');
    await request(s.app).post(`/api/fleet/sessions/sess-tester/deliveries/${d!.id}/result`).set('X-Podium-Token', s.ed.token).send({ result: 'refused' });
    const m = (await read(s.edB, 'group')).body.messages[0].mentions[0];
    expect(m.state).toBe('not-delivered');
    expect(m.why).toMatch(/refused/);
  });

  it('refuses a plain @Name that two agents share, naming the candidates, and stores nothing', async () => {
    const s = await world();
    await post(s, s.ed.token, report('Ed', 'sess-tester-2', 'Tester', PI));
    const res = await say(s.edB, 'group', 'hey @Tester please');
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Tester@ci-runner-01');
    expect(res.body.error).toContain('Tester@build-pi');
    expect(texts(await read(s.edB, 'group'))).toEqual([]);
    // Typing the location picks one.
    expect((await say(s.edB, 'group', 'hey @Tester@build-pi please')).status).toBe(201);
  });

  it('takes a plain @Name when one agent has it, and tells the id of same-named agents on one machine apart', async () => {
    const s = await world();
    const one = await say(s.edB, 'group', '@dev look at this');
    expect(one.body.message.mentions[0]).toMatchObject({ typed: 'dev', sessionId: 'sess-dev' });
    await post(s, s.ed.token, report('Ed', 'xyz98765-dev', 'dev', MAC));
    const twin = await say(s.edB, 'group', '@dev@ed-mbp hello');
    expect(twin.status).toBe(409);
    expect(twin.body.error).toContain('dev@ed-mbp#xyz98765');
    const id = /dev@ed-mbp#([A-Za-z0-9_-]+)/.exec(twin.body.error)![1];
    const picked = await say(s.edB, 'group', `@dev@ed-mbp#${id} hello`);
    expect(picked.status).toBe(201);
  });

  it('marks a mention of an agent that is not there not-delivered, and still posts the message', async () => {
    const s = await world();
    const res = await say(s.edB, 'group', '@ghost@box-x are you there');
    expect(res.status).toBe(201);
    expect(res.body.message.mentions[0]).toMatchObject({ typed: 'ghost@box-x', sessionId: null, state: 'not-delivered' });
    expect(res.body.message.mentions[0].why).toMatch(/no live agent called ghost on box-x/);
  });

  it('delivers a held mention to the one live session with the same name and peer key when the typed session has been replaced', async () => {
    const s = await world();
    await s.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: true });
    await say(s.edB, 'group', '@Tester@ci-runner-01 hi');
    // The orchestrator restarted: a new session of the same name on the same reporter, and the old one ended.
    await post(s, s.ed.token, report('Ed', 'sess-tester-new', 'Tester', LINUX));
    await tester(s, { status: 'done', waitReason: null });
    s.tick(10_000);
    await s.fleet.sweep();
    expect((await read(s.edB, 'group')).body.messages[0].mentions[0]).toMatchObject({ state: 'held', sessionId: 'sess-tester' });
    expect((await s.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: false })).body.delivered).toBe(1);
    const fresh = await post(s, s.ed.token, report('Ed', 'sess-tester-new', 'Tester', LINUX));
    expect(fresh.body.deliveries).toEqual([expect.objectContaining({ text: expect.stringContaining('hi') })]);
  });

  it('refuses @group and @everyone with a clear message until an Admin turns them on', async () => {
    const s = await world();
    const off = await say(s.edB, 'group', '@everyone stop');
    expect(off.status).toBe(422);
    expect(off.body.error).toMatch(/@group and @everyone are off/);
    expect(off.body.error).toMatch(/Admin > Settings/);
    expect(texts(await read(s.edB, 'group'))).toEqual([]);
    const a = await adminAgent(s);
    expect((await a.put('/api/admin/settings').set(HA).send({ features: { 'chat-everyone': true } })).status).toBe(200);
    expect((await s.edB.get(CH)).body.settings.everyone).toBe(true);
    const on = await say(s.edB, 'group', '@group status please');
    expect(on.status).toBe(201);
    // @group reaches each of the person's own orchestrators.
    expect(on.body.message.mentions.map((m: { sessionId: string }) => m.sessionId).sort()).toEqual(['sess-dev', 'sess-tester']);
  });

  it('does not deliver an @everyone that an Admin turned off while it was held', async () => {
    const s = await world();
    const a = await adminAgent(s);
    await a.put('/api/admin/settings').set(HA).send({ features: { 'chat-everyone': true } });
    await s.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: true });
    await say(s.edB, 'group', '@everyone stand by');
    await a.put('/api/admin/settings').set(HA).send({ features: { 'chat-everyone': false } });
    const resumed = await s.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: false });
    expect(resumed.body.delivered).toBe(0);
    const m = (await read(s.edB, 'group')).body.messages[0].mentions[0];
    expect(m.state).toBe('not-delivered');
    expect(m.why).toMatch(/turned off by an Admin/);
    expect(await deliveriesFor(s, 'tester')).toEqual([]);
  });

  it('lists the Admin flag in Admin > Settings, off by default', async () => {
    const s = await world();
    const a = await adminAgent(s);
    const got = (await a.get('/api/admin/settings')).body;
    expect(got.features.find((f: { id: string }) => f.id === 'chat-everyone')).toMatchObject({ on: false });
    expect(got.chat).toEqual({ retainDays: 30, graceHours: 24, maxChars: 4000, perMinute: 6 });
    expect((await a.put('/api/admin/settings').set(HA).send({ chat: { retainDays: 0 } })).status).toBe(400);
    expect((await a.put('/api/admin/settings').set(HA).send({ chat: { retainDays: 7, graceHours: 2 } })).body.chat).toMatchObject({ retainDays: 7, graceHours: 2 });
    expect(await logKinds(s)).toContain('chat_settings_changed');
  });

  it('holds a mention of another person\'s agent for that person to approve; the agent hears nothing yet (#1034)', async () => {
    const s = await world();
    const res = await say(s.edB, 'general', '@review@alex-box can you check');
    expect(res.status).toBe(201);
    expect(res.body.message.mentions[0]).toMatchObject({ sessionId: 'sess-alex', state: 'approval', why: 'Waiting for Alex to approve' });
    const alexReply = await alexOne(s);
    expect(alexReply.body.deliveries ?? []).toEqual([]);
    expect(alexReply.body.peerDeliveries ?? []).toEqual([]);
  });

  it('gives the person a mention badge, counts unread for others, and clears both on mark read', async () => {
    const s = await world();
    await say(s.alexB, 'general', 'hello @Ed@console, a question');
    await say(s.alexB, 'general', 'another one');
    const ch = (await s.edB.get(CH)).body.channels[0];
    expect(ch).toMatchObject({ unread: 2, mentions: 1 });
    const alexSees = (await s.alexB.get(CH)).body.channels[0];
    expect(alexSees).toMatchObject({ unread: 0, mentions: 0 });
    const marked = await s.edB.post(`${CH}/read`).set(H).send({ thread: 'public', upTo: null });
    expect(marked.body).toMatchObject({ ok: true, unread: 0, mentions: 0 });
    expect((await s.edB.get(CH)).body.channels[0]).toMatchObject({ unread: 0, mentions: 0 });
    expect((await s.edB.post(`${CH}/read`).set(H).send({ thread: 'group:alex', upTo: null })).status).toBe(403);
  });

  it('lists what @ can address, with @group and @everyone disabled and the reason while off', async () => {
    const s = await world();
    const res = await s.edB.get(`${CH}/addresses?channel=group&q=t`);
    expect(res.body.addresses.map((a: { typed: string }) => a.typed)).toEqual(['Tester@ci-runner-01']);
    const all = await s.edB.get(`${CH}/addresses?channel=general`);
    const typed = all.body.addresses.map((a: { typed: string }) => a.typed);
    expect(typed).toEqual(expect.arrayContaining(['dev@ed-mbp', 'review@alex-box', 'Alex@console', 'group', 'everyone']));
    expect(all.body.addresses.find((a: { typed: string }) => a.typed === 'everyone')).toMatchObject({ disabled: true });
    expect(all.body.addresses.find((a: { typed: string }) => a.typed === 'everyone').why).toMatch(/Admin > Settings/);
  });
});

describe('pausing, disconnecting and removing a channel', () => {
  it('holds a mention while the group is paused and delivers it, in order, on resume', async () => {
    const s = await world();
    expect((await s.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: true })).body).toMatchObject({ ok: true, paused: true });
    expect((await s.edB.get(CH)).body.channels[1]).toMatchObject({ paused: true });
    await say(s.edB, 'group', '@Tester@ci-runner-01 first');
    await say(s.edB, 'group', '@Tester@ci-runner-01 second');
    expect((await read(s.edB, 'group')).body.messages.map((m: { mentions: { state: string }[] }) => m.mentions[0]!.state)).toEqual(['held', 'held']);
    expect(await deliveriesFor(s, 'tester')).toEqual([]);
    const resumed = await s.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: false });
    expect(resumed.body).toMatchObject({ ok: true, paused: false, delivered: 2 });
    const got = await deliveriesFor(s, 'tester');
    expect(got.map((d) => d.text)).toEqual([expect.stringContaining('first'), expect.stringContaining('second')]);
    expect((await read(s.edB, 'group')).body.messages.map((m: { mentions: { state: string }[] }) => m.mentions[0]!.state)).toEqual(['waiting', 'waiting']);
  });

  it('marks a held mention dropped, with the reason, when the agent ends before the resume', async () => {
    const s = await world();
    await s.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: true });
    await say(s.edB, 'group', '@Tester@ci-runner-01 first');
    await tester(s, { status: 'done', waitReason: null });
    s.tick(10_000);
    await s.fleet.sweep();
    const m = (await read(s.edB, 'group')).body.messages[0].mentions[0];
    expect(m).toMatchObject({ state: 'dropped' });
    expect(m.why).toMatch(/ended while the message was held/);
    const resumed = await s.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: false });
    expect(resumed.body.delivered).toBe(0);
  });

  it('takes the person\'s agents out of a channel on Disconnect, and gives them back on Reconnect', async () => {
    const s = await world();
    expect((await s.edB.put(`${CH}/channels/group/disconnect`).set(H).send({ disconnected: true })).body).toMatchObject({ ok: true, disconnected: true });
    const res = await say(s.edB, 'group', '@Tester@ci-runner-01 hello');
    expect(res.body.message.mentions[0]).toMatchObject({ state: 'not-delivered' });
    expect(res.body.message.mentions[0].why).toMatch(/disconnected/);
    const agentPost = await request(s.app).post('/api/fleet/sessions/sess-tester/chat/channels/group/messages').set('X-Podium-Token', s.ed.token).send({ text: 'can I?' });
    expect(agentPost.status).toBe(403);
    const agentRead = await request(s.app).get('/api/fleet/sessions/sess-tester/chat/channels/group/messages').set('X-Podium-Token', s.ed.token);
    expect(agentRead.status).toBe(403);
    await s.edB.put(`${CH}/channels/group/disconnect`).set(H).send({ disconnected: false });
    expect((await request(s.app).post('/api/fleet/sessions/sess-tester/chat/channels/group/messages').set('X-Podium-Token', s.ed.token).send({ text: 'back' })).status).toBe(201);
    const again = await say(s.edB, 'group', '@Tester@ci-runner-01 hello again');
    expect(again.body.message.mentions[0].state).toBe('waiting');
  });

  it('refuses an agent\'s post while its channel is paused', async () => {
    const s = await world();
    await s.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: true });
    const res = await request(s.app).post('/api/fleet/sessions/sess-tester/chat/channels/group/messages').set('X-Podium-Token', s.ed.token).send({ text: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/paused/);
  });

  it('follows the ownership rules in General: anyone stops their own agents, only an Admin stops it for everyone or removes its messages', async () => {
    const s = await world();
    await say(s.alexB, 'general', 'kept unless an Admin removes it');
    const mine = await s.edB.put(`${CH}/channels/general/pause`).set(H).send({ paused: true });
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ paused: true, pausedForEveryone: false });
    // Only Ed's agents are held: Alex's own channel is not paused.
    expect((await s.alexB.get(CH)).body.channels[0]).toMatchObject({ paused: false });
    expect((await s.edB.put(`${CH}/channels/general/pause`).set(H).send({ paused: true, everyone: true })).status).toBe(403);
    expect((await s.edB.delete(`${CH}/channels/general/messages`).set(H).send({})).status).toBe(403);
    expect((await s.edB.put(`${CH}/channels/general/disconnect`).set(H).send({ disconnected: true })).status).toBe(200);
    const a = await signedIn(s, 'Admin', SECRET);
    const all = await a.put(`${CH}/channels/general/pause`).set(H).send({ paused: true, everyone: true });
    expect(all.body).toMatchObject({ ok: true, paused: true, pausedForEveryone: true });
    expect((await s.alexB.get(CH)).body.channels[0]).toMatchObject({ paused: true, pausedForEveryone: true });
    expect((await a.put(`${CH}/channels/general/pause`).set(H).send({ paused: false, everyone: true })).body.pausedForEveryone).toBe(false);
    expect((await a.delete(`${CH}/channels/general/messages`).set(H).send({})).body).toMatchObject({ ok: true, removed: 1 });
    expect(texts(await read(s.alexB, 'general'))).toEqual([]);
  });

  it('writes the group_ and general_ audit rows with the ids and never the text', async () => {
    const s = await world();
    await say(s.edB, 'group', '@Tester@ci-runner-01 PRIVATE-WORDS-HERE');
    await deliveriesFor(s, 'tester');
    await s.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: true });
    await s.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: false });
    await s.edB.put(`${CH}/channels/group/disconnect`).set(H).send({ disconnected: true });
    await s.edB.put(`${CH}/channels/group/disconnect`).set(H).send({ disconnected: false });
    await s.edB.delete(`${CH}/channels/group/messages`).set(H).send({});
    await say(s.edB, 'general', 'PUBLIC-WORDS-HERE');
    await s.fleet.flush();
    await settle();
    const rows = await logRows(s);
    const kinds = rows.map((r) => r.kind);
    for (const k of ['group_sent', 'group_paused', 'group_resumed', 'group_disconnected', 'group_reconnected', 'group_cleared', 'general_sent']) expect(kinds, k).toContain(k);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE-WORDS-HERE');
    expect(JSON.stringify(rows)).not.toContain('PUBLIC-WORDS-HERE');
    expect(s.lines.join('\n')).not.toContain('PRIVATE-WORDS-HERE');
  });

  it('shows a clear error when an agent already has 20 messages waiting, and still posts the message', async () => {
    const s = await world();
    const a = await adminAgent(s);
    await a.put('/api/admin/settings').set(HA).send({ chat: { perMinute: 600 } });
    for (let i = 0; i < 20; i++) expect((await say(s.edB, 'group', `@Tester@ci-runner-01 n${i}`)).body.message.mentions[0].state).toBe('waiting');
    const over = await say(s.edB, 'group', '@Tester@ci-runner-01 one too many');
    expect(over.status).toBe(201);
    expect(over.body.message.mentions[0]).toMatchObject({ state: 'not-delivered' });
    expect(over.body.message.mentions[0].why).toMatch(/20 messages/);
    expect(over.body.warnings.join(' ')).toMatch(/Tester.*20 messages/);
  });
});

describe('direct messages', () => {
  it('sends the person\'s message to one agent as a message of the console, stores it, and follows it to Delivered', async () => {
    const s = await world();
    const res = await s.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: 'please run the suite' });
    expect(res.status).toBe(202);
    expect(res.body.message).toMatchObject({ text: 'please run the suite', author: 'person', state: 'queued' });
    const got = await deliveriesFor(s, 'tester');
    expect(got).toEqual([expect.objectContaining({ kind: 'message', text: 'please run the suite' })]);
    // The peer path must not hand the same text a second time.
    const again = await tester(s);
    expect(again.body.peerDeliveries).toEqual([]);
    expect(again.body.deliveries).toEqual([expect.objectContaining({ text: 'please run the suite' })]);
    const took = await request(s.app).post(`/api/fleet/sessions/sess-tester/deliveries/${got[0]!.id}/result`).set('X-Podium-Token', s.ed.token).send({ result: 'took' });
    expect(took.status).toBe(200);
    const page = await s.edB.get(`${CH}/dm/me/sess-tester/messages`);
    expect(page.body.messages.map((m: { state: string; text: string }) => [m.text, m.state])).toEqual([['please run the suite', 'delivered']]);
    expect(page.body.messages[0].from).toMatchObject({ kind: 'person', name: 'Ed' });
    expect(page.body).toMatchObject({ a: expect.anything(), b: expect.anything(), older: null, total: 1 });
    const list = (await s.edB.get(CH)).body.directs;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ messages: 1, thread: expect.stringContaining('dm:') });
  });

  it('replaces secrets before storing and delivering, and refuses an empty text', async () => {
    const s = await world();
    expect((await s.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: '  ' })).status).toBe(400);
    await s.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: 'key sk-abcdefghijklmnopqrstuvwxyz123456 ok' });
    const got = await deliveriesFor(s, 'tester');
    expect(got[0]!.text).toContain('[redacted]');
    expect(got[0]!.text).not.toContain('sk-abcdef');
    const page = await s.edB.get(`${CH}/dm/me/sess-tester/messages`);
    expect(page.body.messages[0].text).toContain('[redacted]');
  });

  it('refuses a send to an agent that has ended, and queues nothing', async () => {
    const s = await world();
    await s.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: 'first' });
    await tester(s, { status: 'done', waitReason: null });
    s.tick(10_000);
    await s.fleet.sweep();
    const res = await s.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: 'anyone?' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ended/);
    expect((await s.edB.post(`${CH}/dm/me/nobody/messages`).set(H).send({ text: 'hi' })).status).toBe(404);
  });

  it('holds a send to another person\'s agent for that person to approve (#1034), and refuses one to an agent nobody has', async () => {
    const s = await world();
    const sent = await s.edB.post(`${CH}/dm/me/sess-alex/messages`).set(H).send({ text: 'hi' });
    expect(sent.status).toBe(202);
    expect(sent.body.message).toMatchObject({ state: 'approval', waitingFor: 'Alex', text: 'hi' });
    expect((await s.edB.post(`${CH}/dm/me/nobody/messages`).set(H).send({ text: 'hi' })).status).toBe(404);
  });

  it('shows a clear error and stores nothing at 20 waiting messages', async () => {
    const s = await world();
    for (let i = 0; i < 20; i++) expect((await s.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: `m${i}` })).status).toBe(202);
    const over = await s.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: 'm20' });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/Tester.*20 messages/);
    expect((await s.edB.get(`${CH}/dm/me/sess-tester/messages`)).body.total).toBe(20);
  });

  it('refuses a send when the reporter does not take messages from Podium', async () => {
    const s = await world();
    await tester(s, { respond: { level: 'questions', accepts: ['question'], limits: [] } });
    const res = await s.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: 'hi' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/does not take messages from Podium/);
  });

  it('lets the person add to a conversation between two agents, reaching both, shown once; the round trips are unchanged', async () => {
    const s = await world();
    await linkedConversation(s);
    const key = (await s.edB.get(CH)).body.directs[0];
    expect(key.roundTrips).toMatchObject({ used: 0, cap: 10 });
    const [x, y] = [key.a.sessionId, key.b.sessionId];
    const res = await s.edB.post(`${CH}/dm/${x}/${y}/messages`).set(H).send({ text: 'carry on, both of you' });
    expect(res.status).toBe(202);
    expect(res.body.skipped).toEqual([]);
    expect(res.body.message.to.map((t: { sessionId: string }) => t.sessionId).sort()).toEqual(['sess-dev', 'sess-tester']);
    expect((await deliveriesFor(s, 'tester')).map((d) => d.text)).toContain('carry on, both of you');
    expect((await deliveriesFor(s, 'dev')).map((d) => d.text)).toContain('carry on, both of you');
    const page = await s.edB.get(`${CH}/dm/${x}/${y}/messages`);
    expect(page.body.messages.filter((m: { text: string }) => m.text === 'carry on, both of you')).toHaveLength(1);
    expect((await s.edB.get(CH)).body.directs[0].roundTrips.used).toBe(0);
    // The two stored rows are one message in the thread, so the total and the sidebar count what the thread shows (#1034).
    expect(page.body.total).toBe(page.body.messages.length);
    expect((await s.edB.get(CH)).body.directs[0].messages).toBe(page.body.messages.length);
  });

  it('does not let the person\'s message count as a round trip, nor reset the cap the owner has to approve past', async () => {
    const s = await world();
    const a = await adminAgent(s);
    expect((await a.put('/api/admin/settings').set(HA).send({ peerMessaging: { roundTrips: 1 } })).status).toBe(200);
    await linkedConversation(s);
    await s.edB.put('/api/fleet/respond/peers/rights').set(H).send({ from: LINUX.id, to: MAC.id, level: 'send' });
    const toTester = (text: string) => request(s.app).post('/api/fleet/sessions/sess-dev/peers/messages').set('X-Podium-Token', s.ed.token).send({ to: 'Tester@ci-runner-01', text });
    const reply = await request(s.app).post('/api/fleet/sessions/sess-tester/peers/messages').set('X-Podium-Token', s.ed.token).send({ to: 'dev@ed-mbp', text: 'agent reply' });
    expect(reply.status).toBe(202);
    const key = (await s.edB.get(CH)).body.directs[0];
    expect(key.roundTrips).toMatchObject({ used: 1, cap: 1 });
    const [x, y] = [key.a.sessionId, key.b.sessionId];
    expect((await s.edB.post(`${CH}/dm/${x}/${y}/messages`).set(H).send({ text: 'a word from the person' })).status).toBe(202);
    expect((await s.edB.get(CH)).body.directs[0].roundTrips).toMatchObject({ used: 1, cap: 1 });
    // Still over the cap after the person spoke: the next agent message waits for the owner's approval.
    const next = await toTester('one more');
    expect(next.body).toMatchObject({ state: 'approval', approvalWhy: 'round-trips' });
  });

  it('keeps working when a conversation is deleted while a message in it is queued', async () => {
    const s = await world();
    await s.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: 'queued then deleted' });
    const [d] = await deliveriesFor(s, 'tester');
    const key = (await s.edB.get(CH)).body.directs[0];
    expect((await s.edB.delete(`${CH}/dm/${key.a.sessionId}/${key.b.sessionId}`).set(H)).body.removed).toBe(1);
    const took = await request(s.app).post(`/api/fleet/sessions/sess-tester/deliveries/${d!.id}/result`).set('X-Podium-Token', s.ed.token).send({ result: 'took' });
    expect(took.status).toBe(200);
    expect((await s.edB.get(CH)).body.directs).toEqual([]);
  });

  it('says which agent ended and that it will not receive the message, and refuses when all have ended', async () => {
    const s = await world();
    await linkedConversation(s);
    const key = (await s.edB.get(CH)).body.directs[0];
    const [x, y] = [key.a.sessionId, key.b.sessionId];
    await tester(s, { status: 'done', waitReason: null });
    s.tick(10_000);
    await s.fleet.sweep();
    const state = (await s.edB.get(CH)).body.directs[0];
    expect(state.ended).toEqual(['Tester']);
    const some = await s.edB.post(`${CH}/dm/${x}/${y}/messages`).set(H).send({ text: 'still there, dev?' });
    expect(some.status).toBe(202);
    expect(some.body.skipped).toEqual([expect.objectContaining({ sessionId: 'sess-tester', name: 'Tester', why: expect.stringMatching(/will not receive/) })]);
    await dev(s, { status: 'done', waitReason: null });
    s.tick(10_000);
    await s.fleet.sweep();
    expect((await s.edB.post(`${CH}/dm/${x}/${y}/messages`).set(H).send({ text: 'anyone?' })).status).toBe(409);
  });

  it('hides a conversation once every agent in it has left the live set, and shows it again when they are back', async () => {
    const s = await world();
    await linkedConversation(s);
    expect((await s.edB.get(CH)).body.directs).toHaveLength(1);
    await tester(s, { status: 'done', waitReason: null });
    await dev(s, { status: 'done', waitReason: null });
    s.tick(10_000);
    await s.fleet.sweep();
    expect((await s.edB.get(CH)).body.directs).toEqual([]);
    // The same session reports again: the conversation and its history return.
    await tester(s);
    const back = (await s.edB.get(CH)).body.directs;
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ messages: 1 });
  });

  it('deletes a hidden conversation\'s messages after the Admin\'s grace period, and not before', async () => {
    const s = await world();
    await linkedConversation(s);
    const key = (await s.edB.get(CH)).body.directs[0];
    await tester(s, { status: 'done', waitReason: null });
    await dev(s, { status: 'done', waitReason: null });
    s.tick(10_000);
    await s.fleet.sweep();
    s.tick(23 * 3_600_000);
    await s.fleet.retain();
    // A sign-in ends after 12 idle hours, so the person signs in again.
    const again = await signedIn(s, 'Ed', s.ed.token);
    expect((await again.get(`${CH}/dm/${key.a.sessionId}/${key.b.sessionId}/messages`)).body.messages).toHaveLength(1);
    s.tick(2 * 3_600_000);
    await s.fleet.retain();
    expect((await again.get(`${CH}/dm/${key.a.sessionId}/${key.b.sessionId}/messages`)).status).toBe(404);
  });

  it('deletes a conversation on request, keeps the link, and writes chat_deleted without the text', async () => {
    const s = await world();
    await linkedConversation(s);
    const key = (await s.edB.get(CH)).body.directs[0];
    const gone = await s.edB.delete(`${CH}/dm/${key.a.sessionId}/${key.b.sessionId}`).set(H);
    expect(gone.body).toMatchObject({ ok: true, removed: 1 });
    expect((await s.edB.get(CH)).body.directs).toEqual([]);
    const rights = await s.edB.get('/api/fleet/respond/peers');
    expect(rights.body.rights.length).toBeGreaterThan(0);
    await s.fleet.flush();
    await settle();
    const rows = await logRows(s);
    expect(rows.map((r) => r.kind)).toContain('chat_deleted');
    expect(JSON.stringify(rows)).not.toContain('agent hello');
    expect((await s.alexB.delete(`${CH}/dm/${key.a.sessionId}/${key.b.sessionId}`).set(H)).status).toBe(404);
  });

  it('keeps a conversation from another person: 403 where the existing rule says 403, and no text anywhere else', async () => {
    const s = await world();
    await linkedConversation(s);
    const key = (await s.edB.get(CH)).body.directs[0];
    const url = `${CH}/dm/${key.a.sessionId}/${key.b.sessionId}`;
    expect((await s.alexB.get(`${url}/messages`)).status).toBe(403);
    expect((await s.alexB.post(`${url}/messages`).set(H).send({ text: 'let me in' })).status).toBe(403);
    expect((await s.alexB.get(CH)).body.directs).toEqual([]);
    expect(JSON.stringify((await s.alexB.get(CH)).body)).not.toContain('agent hello');
    const admin = await signedIn(s, 'Admin', SECRET);
    expect((await admin.get(`${url}/messages`)).status).toBe(200);
    expect((await admin.post(`${url}/messages`).set(H).send({ text: 'admin tries' })).status).toBe(403);
    expect((await s.edB.get(`${CH}/dm/sess-dev/sess-unknown/messages`)).status).toBe(404);
  });

  it('never returns a direct message\'s text from a channel, address, overview, stream or agent route', async () => {
    const s = await world();
    await linkedConversation(s);
    await s.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: 'DM-ONLY-SECRET-TEXT' });
    await say(s.edB, 'group', 'channel text');
    await say(s.edB, 'general', 'public text');
    const seen: string[] = [];
    for (const b of [s.edB, s.alexB]) {
      for (const path of ['', '/channels/group/messages', '/channels/general/messages', '/addresses?channel=general', '/addresses?channel=group']) seen.push(JSON.stringify((await b.get(`${CH}${path}`)).body));
    }
    for (const path of ['group', 'general']) seen.push(JSON.stringify((await request(s.app).get(`/api/fleet/sessions/sess-tester/chat/channels/${path}/messages`).set('X-Podium-Token', s.ed.token)).body));
    const sse: string[] = [];
    s.fleet.hub.add({ write: (c: string) => sse.push(c) });
    await say(s.edB, 'group', 'one more');
    await s.fleet.flush();
    seen.push(sse.join(''));
    for (const body of seen) expect(body).not.toContain('DM-ONLY-SECRET-TEXT');
    expect(seen.join('')).not.toContain('agent hello');
  });
});

describe('the stream', () => {
  it('sends a chat event with only a revision and a scope: no name, count, id or text', async () => {
    const s = await world();
    const sse: string[] = [];
    s.fleet.hub.add({ write: (c: string) => sse.push(c) });
    await say(s.alexB, 'general', 'SECRET-STREAM-TEXT for @Ed@console');
    await s.fleet.flush();
    const chats = sse.join('').split('\n\n').filter((c) => c.includes('event: chat'));
    expect(chats.length).toBeGreaterThan(0);
    const data = JSON.parse(chats.at(-1)!.split('data: ')[1]!);
    expect(data).toMatchObject({ scope: 'public', rev: expect.any(Number) });
    for (const c of chats) expect(Object.keys(JSON.parse(c.split('data: ')[1]!)).sort()).toEqual(['rev', 'scope']);
    expect(sse.join('')).not.toContain('SECRET-STREAM-TEXT');
    expect(chats.join('')).not.toMatch(/owner|unread|mentions|approvals|"ed"|"alex"/);
  });
});

describe('retention', () => {
  it('deletes channel messages older than the Admin\'s days when retention runs', async () => {
    const s = await world();
    await say(s.edB, 'group', 'old group');
    await say(s.edB, 'general', 'old public');
    s.tick(29 * 86_400_000);
    const ed = await signedIn(s, 'Ed', s.ed.token);
    await say(ed, 'group', 'newer group');
    await s.fleet.retain();
    expect(texts(await read(ed, 'group'))).toEqual(['old group', 'newer group']);
    s.tick(2 * 86_400_000);
    await s.fleet.retain();
    const later = await signedIn(s, 'Ed', s.ed.token);
    expect(texts(await read(later, 'group'))).toEqual(['newer group']);
    expect(texts(await read(later, 'general'))).toEqual([]);
    await settle();
    expect(await logKinds(s)).toContain('chat_purged');
  });
});

describe('the reporter-token routes for agents', () => {
  const agentPost = (s: S, sid: string, channel: string, body: Record<string, unknown>, token?: string) =>
    request(s.app).post(`/api/fleet/sessions/${sid}/chat/channels/${channel}/messages`).set('X-Podium-Token', token ?? s.ed.token).send(body);
  const agentRead = (s: S, sid: string, channel: string, q = '', token?: string) =>
    request(s.app).get(`/api/fleet/sessions/${sid}/chat/channels/${channel}/messages${q}`).set('X-Podium-Token', token ?? s.ed.token);

  it('lets an orchestrator post to its group and to General, and read both', async () => {
    const s = await world();
    expect((await agentPost(s, 'sess-tester', 'group', { text: 'to my group' })).status).toBe(201);
    expect((await agentPost(s, 'sess-tester', 'general', { text: 'to everyone' })).status).toBe(201);
    expect(texts(await agentRead(s, 'sess-dev', 'group'))).toEqual(['to my group']);
    expect(texts(await agentRead(s, 'sess-dev', 'general'))).toEqual(['to everyone']);
    expect((await read(s.alexB, 'general')).body.messages[0]).toMatchObject({ authorKind: 'orchestrator', authorName: 'Tester' });
    expect(texts(await read(s.alexB, 'group'))).toEqual([]);
  });

  it('refuses a token that does not own the session, an unknown session, an agent that is not taking part, and messaging while off', async () => {
    const s = await world();
    expect((await agentPost(s, 'sess-tester', 'group', { text: 'x' }, s.alex.token)).status).toBe(403);
    expect((await agentPost(s, 'sess-nope', 'group', { text: 'x' })).status).toBe(404);
    await tester(s, { peers: false });
    expect((await agentPost(s, 'sess-tester', 'group', { text: 'x' })).status).toBe(403);
    expect((await agentRead(s, 'sess-tester', 'group')).status).toBe(403);
    expect((await agentPost(s, 'sess-dev', 'nowhere', { text: 'x' })).status).toBe(404);
    expect((await agentPost(s, 'sess-dev', 'group', { text: '' })).status).toBe(400);
    await s.fleet.features.setFeature(PEER_MESSAGING, false);
    expect((await agentPost(s, 'sess-dev', 'group', { text: 'x' })).status).toBe(403);
  });

  it('does not deliver an agent\'s mention to another agent here; it is stored as not delivered, for #1035', async () => {
    const s = await world();
    const res = await agentPost(s, 'sess-dev', 'group', { text: '@Tester@ci-runner-01 please look' });
    expect(res.status).toBe(201);
    expect((await read(s.edB, 'group')).body.messages[0].mentions[0]).toMatchObject({ state: 'not-delivered' });
    expect(await deliveriesFor(s, 'tester')).toEqual([]);
  });

  it('reads about 30,000 characters a call, newest first by page, with a cursor that gets the rest', async () => {
    const s = await world();
    const a = await adminAgent(s);
    await a.put('/api/admin/settings').set(HA).send({ chat: { maxChars: 12_000, perMinute: 600 } });
    for (let i = 0; i < 6; i++) expect((await say(s.edB, 'group', `${i}`.repeat(12_000))).status).toBe(201);
    const first = await agentRead(s, 'sess-dev', 'group');
    expect(first.status).toBe(200);
    const size = (r: typeof first) => (r.body.messages as { text: string }[]).reduce((n, m) => n + m.text.length, 0);
    expect(size(first)).toBeLessThanOrEqual(30_000);
    expect(first.body.messages).toHaveLength(2);
    expect(first.body.messages.at(-1).text[0]).toBe('5');
    expect(first.body.older).toEqual(expect.any(String));
    const second = await agentRead(s, 'sess-dev', 'group', `?before=${encodeURIComponent(first.body.older)}`);
    expect(second.body.messages.at(-1).text[0]).toBe('3');
    const third = await agentRead(s, 'sess-dev', 'group', `?before=${encodeURIComponent(second.body.older)}`);
    expect(third.body.older).toBeNull();
    expect((await agentRead(s, 'sess-dev', 'group', '?before=junk')).status).toBe(400);
  });
});

describe('a person writing to another person\'s agent (#1034)', () => {
  const MSG_FROM_ED = 'Please look at the build, Alex.';
  /** The whole text of the post, which is what the agent is handed: the @ stays in it. */
  const FULL = `@review@alex-box ${MSG_FROM_ED}`;
  const requestsOf = async (b: ReturnType<typeof request.agent>) => ((await b.get('/api/fleet/respond/peers')).body.requests ?? []) as { id: string; kind: string; fromPerson: boolean; fromKey: string; from: { name: string | null; machine: string }; text: string | null }[];
  const answer = (b: ReturnType<typeof request.agent>, id: string, a: 'deliver' | 'decline') => b.post(`/api/fleet/respond/peers/requests/${id}`).set(H).send({ answer: a });
  const dmPath = '/dm/me/sess-alex';
  const mention = async (w: W) => (await read(w.edB, 'general')).body.messages.at(-1).mentions[0] as { state: string; why: string | null; sessionId: string };
  const thread = (b: ReturnType<typeof request.agent>, path = `${CH}/dm/me/sess-alex/messages`) => b.get(path);
  const link = (b: ReturnType<typeof request.agent>, op: string, path = `${CH}/dm/me/sess-alex/link`) => b.put(path).set(H).send({ op });
  /** Alex's agent reports idle and says what it was handed, as the mod does. */
  const handed = async (w: W) => ((await alexOne(w)).body.peerDeliveries ?? []) as { id: string; kind: string; text: string; from: { name: string; machine: string; owner: string; person?: boolean } }[];
  const took = (w: W, id: string, result: 'took' | 'queued') => request(w.app).post(`/api/fleet/sessions/sess-alex/peers/deliveries/${id}/result`).set('X-Podium-Token', w.alex.token).send({ result });

  it('shows the owner a request in My reporters, and the sender "Waiting for Alex to approve"', async () => {
    const w = await world();
    await say(w.edB, 'general', `@review@alex-box ${MSG_FROM_ED}`);
    expect(await mention(w)).toMatchObject({ state: 'approval', why: 'Waiting for Alex to approve' });
    const reqs = await requestsOf(w.alexB);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ kind: 'message', fromPerson: true, fromKey: 'person:ed', from: { name: 'Ed', machine: 'Podium Chat' } });
    expect(reqs[0]!.text).toBe(FULL);
    expect(await requestsOf(w.edB)).toEqual([]);
    expect((await w.alexB.get(CH)).body.approvals).toBe(1);
    expect((await w.edB.get(CH)).body.approvals).toBe(0);
  });

  it('opens a link on Allow and hands the text over framed as a person\'s, then moves the mention to working', async () => {
    const w = await world();
    await say(w.edB, 'general', `@review@alex-box ${MSG_FROM_ED}`);
    const id = (await requestsOf(w.alexB))[0]!.id;
    expect((await answer(w.alexB, id, 'deliver')).status).toBe(200);
    await w.fleet.flush();
    expect(await mention(w)).toMatchObject({ state: 'waiting', why: null });
    const got = await handed(w);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'message', text: FULL, from: { name: 'Ed', machine: '', owner: 'Alex', person: true } });
    expect((await took(w, got[0]!.id, 'queued')).status).toBe(200);
    expect((await took(w, got[0]!.id, 'took')).status).toBe(200);
    await settle();
    expect(await mention(w)).toMatchObject({ state: 'working' });
    // A second message goes straight over the open link, with no new request.
    await say(w.edB, 'general', '@review@alex-box and the tests too');
    expect(await requestsOf(w.alexB)).toEqual([]);
    expect(await mention(w)).toMatchObject({ state: 'waiting' });
    expect((await handed(w)).map((d) => d.text)).toEqual(['@review@alex-box and the tests too']);
  });

  it('makes the conversation a Direct Message both owners read, an Admin reads, and nobody else', async () => {
    const w = await world();
    const zed = await w.people.createPerson('Zed');
    const zedB = await signedIn(w, 'Zed', zed.token);
    await say(w.edB, 'general', `@review@alex-box ${MSG_FROM_ED}`);
    const asEd = await thread(w.edB);
    expect(asEd.status).toBe(200);
    expect(asEd.body.messages.map((m: { text: string; state: string }) => [m.text, m.state])).toEqual([[FULL, 'approval']]);
    expect(asEd.body.cross).toMatchObject({ person: 'Ed', owner: 'Alex', link: 'waiting', viewerIs: 'sender' });
    const asAlex = await thread(w.alexB, `${CH}/dm/person:ed/sess-alex/messages`);
    expect(asAlex.status).toBe(200);
    expect(asAlex.body.cross).toMatchObject({ viewerIs: 'owner' });
    expect(asAlex.body.messages[0].text).toBe(FULL);
    const admin = await signedIn(w, 'Admin', SECRET);
    const asAdmin = await thread(admin, `${CH}/dm/person:ed/sess-alex/messages`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.cross).toMatchObject({ viewerIs: 'admin' });
    expect((await link(admin, 'pause', `${CH}/dm/person:ed/sess-alex/link`)).status).toBe(404);
    expect((await admin.post(`${CH}/dm/person:ed/sess-alex/messages`).set(H).send({ text: 'admin tries' })).status).toBe(403);
    // A third person: 403 on the thread, nothing in the list, and no way to touch it.
    expect((await thread(zedB, `${CH}/dm/person:ed/sess-alex/messages`)).status).toBe(403);
    expect(JSON.stringify((await zedB.get(CH)).body.directs)).toBe('[]');
    expect((await link(zedB, 'pause', `${CH}/dm/person:ed/sess-alex/link`)).status).toBe(403);
    expect((await zedB.delete(`${CH}/dm/person:ed/sess-alex`).set(H)).status).toBe(403);
    expect((await zedB.post(`${CH}/dm/person:ed/sess-alex/messages`).set(H).send({ text: 'hi' })).status).toBe(403);
    // Both list it.
    expect((await w.edB.get(CH)).body.directs.map((d: { cross: { viewerIs: string } | null }) => d.cross?.viewerIs)).toEqual(['sender']);
    expect((await w.alexB.get(CH)).body.directs.map((d: { cross: { viewerIs: string } | null }) => d.cross?.viewerIs)).toEqual(['owner']);
    // The owner cannot send into someone else's conversation as if it were their own.
    expect((await w.alexB.post(`${CH}/dm/person:ed/sess-alex/messages`).set(H).send({ text: 'reply' })).status).toBe(409);
  });

  it('drops the message and tells the sender why when the owner denies it, and opens no link', async () => {
    const w = await world();
    await say(w.edB, 'general', `@review@alex-box ${MSG_FROM_ED}`);
    expect((await answer(w.alexB, (await requestsOf(w.alexB))[0]!.id, 'decline')).status).toBe(200);
    await w.fleet.flush();
    expect(await mention(w)).toMatchObject({ state: 'dropped', why: 'Alex declined it' });
    const t = await thread(w.edB);
    expect(t.body.messages[0]).toMatchObject({ state: 'declined', reason: 'Alex declined it.' });
    expect(t.body.cross.link).toBe('none');
    expect(await handed(w)).toEqual([]);
    // The person may ask again: a denial is not a removed link.
    await say(w.edB, 'general', `@review@alex-box once more`);
    expect(await mention(w)).toMatchObject({ state: 'approval' });
  });

  it('makes a second @ of the same agent while one waits create no second request', async () => {
    const w = await world();
    await say(w.edB, 'general', `@review@alex-box first`);
    const again = await say(w.edB, 'general', `@review@alex-box second`);
    expect(again.body.message.mentions[0]).toMatchObject({ state: 'not-delivered' });
    expect(again.body.message.mentions[0].why).toMatch(/still waits for Alex to approve/);
    expect(await requestsOf(w.alexB)).toHaveLength(1);
    const dm = await w.edB.post(`${CH}${dmPath}/messages`).set(H).send({ text: 'third' });
    expect(dm.status).toBe(409);
    expect(await requestsOf(w.alexB)).toHaveLength(1);
  });

  it('refuses with the reason after the owner removes the link, and the owner can open it again', async () => {
    const w = await world();
    await say(w.edB, 'general', `@review@alex-box ${MSG_FROM_ED}`);
    await answer(w.alexB, (await requestsOf(w.alexB))[0]!.id, 'deliver');
    const out = await link(w.alexB, 'remove', `${CH}/dm/person:ed/sess-alex/link`);
    expect(out.body).toMatchObject({ ok: true, link: 'removed' });
    const again = await say(w.edB, 'general', '@review@alex-box are you there');
    expect(again.body.message.mentions[0]).toMatchObject({ state: 'not-delivered' });
    expect(again.body.message.mentions[0].why).toMatch(/Alex removed the link/);
    const dm = await w.edB.post(`${CH}${dmPath}/messages`).set(H).send({ text: 'hello?' });
    expect(dm.status).toBe(403);
    expect(dm.body.error).toMatch(/Alex removed the link/);
    expect((await thread(w.edB)).body.cross.link).toBe('removed');
    expect(await requestsOf(w.alexB)).toEqual([]);
    // Only the owner can open it again.
    expect((await link(w.edB, 'allow')).status).toBe(403);
    expect((await link(w.alexB, 'allow', `${CH}/dm/person:ed/sess-alex/link`)).body).toMatchObject({ ok: true, link: 'open' });
    expect((await w.edB.post(`${CH}${dmPath}/messages`).set(H).send({ text: 'back' })).status).toBe(202);
  });

  it('lets either owner pause and resume, and a pause blocks sends and says so', async () => {
    const w = await world();
    await say(w.edB, 'general', `@review@alex-box ${MSG_FROM_ED}`);
    await answer(w.alexB, (await requestsOf(w.alexB))[0]!.id, 'deliver');
    // The sender pauses: the owner sees it paused, and the sender is refused with the reason.
    expect((await link(w.edB, 'pause')).body).toMatchObject({ ok: true, link: 'paused' });
    expect((await thread(w.alexB, `${CH}/dm/person:ed/sess-alex/messages`)).body.cross.link).toBe('paused');
    const refused = await w.edB.post(`${CH}${dmPath}/messages`).set(H).send({ text: 'while paused' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/paused/);
    expect(await handed(w)).toEqual([]);
    // Only the one who paused it can resume it.
    expect((await link(w.alexB, 'resume', `${CH}/dm/person:ed/sess-alex/link`)).status).toBe(403);
    expect((await link(w.edB, 'resume')).body).toMatchObject({ ok: true, link: 'open' });
    expect((await handed(w)).map((d) => d.text)).toEqual([FULL]);
    // The owner pauses: the sender hears it.
    expect((await link(w.alexB, 'pause', `${CH}/dm/person:ed/sess-alex/link`)).body.link).toBe('paused');
    expect((await w.edB.post(`${CH}${dmPath}/messages`).set(H).send({ text: 'again' })).status).toBe(409);
    expect((await link(w.edB, 'bogus')).status).toBe(400);
  });

  it('drops a request when the agent ends first, tells both sides, and closes the owner\'s request', async () => {
    const w = await world();
    await say(w.edB, 'general', `@review@alex-box ${MSG_FROM_ED}`);
    expect(await requestsOf(w.alexB)).toHaveLength(1);
    await alexOne(w, { status: 'done', waitReason: null });
    await w.fleet.flush();
    await settle();
    expect(await mention(w)).toMatchObject({ state: 'dropped', why: 'review ended before it got the message' });
    expect(await requestsOf(w.alexB)).toEqual([]);
    const sse: string[] = [];
    w.fleet.hub.add({ write: (c: string) => sse.push(c) });
    const t = await thread(w.edB);
    expect(t.body.messages[0]).toMatchObject({ state: 'dropped', reason: 'review ended before it got the message.' });
    expect(sse.join('')).not.toContain(MSG_FROM_ED);
  });

  it('lets either owner delete the conversation, and keeps the link', async () => {
    const w = await world();
    await say(w.edB, 'general', `@review@alex-box ${MSG_FROM_ED}`);
    await answer(w.alexB, (await requestsOf(w.alexB))[0]!.id, 'deliver');
    expect((await w.alexB.delete(`${CH}/dm/person:ed/sess-alex`).set(H)).body).toMatchObject({ ok: true, removed: 1 });
    // Gone from both lists; the thread now reads as a fresh one, since the person may write to that agent again.
    expect((await thread(w.edB)).body).toMatchObject({ messages: [], total: 0, cross: { link: 'none' } });
    expect((await w.edB.get(CH)).body.directs).toEqual([]);
    const next = await w.edB.post(`${CH}${dmPath}/messages`).set(H).send({ text: 'new start' });
    expect(next.status).toBe(202);
    expect(next.body.message.state).toBe('ready');
    expect((await w.edB.delete(`${CH}${dmPath}`).set(H)).body).toMatchObject({ ok: true, removed: 1 });
    expect((await w.alexB.get(CH)).body.directs).toEqual([]);
  });

  it('says nothing about the owner\'s other agents in a refusal, and shares no text with the channels or the stream', async () => {
    const w = await world();
    await post(w, w.alex.token, report('Alex', 'sess-secret', 'hidden-plan', BOX));
    await say(w.edB, 'general', `@review@alex-box ${MSG_FROM_ED}`);
    const again = await w.edB.post(`${CH}${dmPath}/messages`).set(H).send({ text: 'x' });
    await link(w.alexB, 'remove', `${CH}/dm/person:ed/sess-alex/link`).catch(() => undefined);
    const refused = await w.edB.post(`${CH}${dmPath}/messages`).set(H).send({ text: 'y' });
    const gone = await w.edB.post(`${CH}/dm/me/sess-secret-nope/messages`).set(H).send({ text: 'z' });
    for (const body of [again.body, refused.body, gone.body]) expect(JSON.stringify(body)).not.toMatch(/hidden-plan|sess-secret/);
    // The channel read, the group, the agent routes and the stream never carry the conversation's text.
    const seen: string[] = [];
    for (const b of [w.edB, w.alexB]) for (const path of ['', '/channels/group/messages', '/channels/general/messages']) seen.push(JSON.stringify((await b.get(`${CH}${path}`)).body.directs ?? ''));
    expect(seen.join('')).not.toContain(MSG_FROM_ED);
  });

  it('limits how fast a person can ask, so a flood makes no more than one request', async () => {
    const w = await world();
    let limited = 0;
    for (let i = 0; i < 9; i++) {
      const res = await say(w.edB, 'general', `@review@alex-box flood ${i}`);
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    expect(await requestsOf(w.alexB)).toHaveLength(1);
  });

  it('still delivers the owner\'s own @ of their own agent in the normal way', async () => {
    const w = await world();
    const res = await say(w.alexB, 'general', '@review@alex-box do the thing');
    expect(res.body.message.mentions[0]).toMatchObject({ sessionId: 'sess-alex', state: 'waiting' });
    expect(await requestsOf(w.alexB)).toEqual([]);
  });

  it('writes audit rows for the request, the answer and the link, never the text, and signals with no name or count', async () => {
    const w = await world();
    const sse: string[] = [];
    w.fleet.hub.add({ write: (c: string) => sse.push(c) });
    await say(w.edB, 'general', `@review@alex-box ${MSG_FROM_ED}`);
    await answer(w.alexB, (await requestsOf(w.alexB))[0]!.id, 'deliver');
    await link(w.alexB, 'pause', `${CH}/dm/person:ed/sess-alex/link`);
    await link(w.edB, 'remove');
    await w.fleet.flush();
    await settle();
    const kinds = await logKinds(w);
    expect(kinds).toEqual(expect.arrayContaining(['chat_across_requested', 'peer_sent', 'peer_approved', 'peer_person_link_opened', 'peer_person_link_paused', 'peer_person_link_removed']));
    expect(JSON.stringify(await logRows(w))).not.toContain(MSG_FROM_ED);
    const chats = sse.join('').split('\n\n').filter((c) => c.includes('event: chat')).map((c) => JSON.parse(c.split('data: ')[1]!));
    expect(chats.length).toBeGreaterThan(0);
    for (const d of chats) expect(Object.keys(d).sort()).toEqual(['rev', 'scope']);
    expect(sse.join('')).not.toContain(MSG_FROM_ED);
  });

  it('refuses a person on the admin secret, and an agent that does not take part in messaging', async () => {
    const w = await world();
    const admin = await signedIn(w, 'Admin', SECRET);
    expect((await admin.post(`${CH}/dm/me/sess-alex/messages`).set(H).send({ text: 'hi' })).status).toBe(403);
    await alexOne(w, { peers: false });
    const off = await w.edB.post(`${CH}${dmPath}/messages`).set(H).send({ text: 'hi' });
    expect(off.status).toBe(404);
  });

  // ---- Only the pauser can resume (#1034) ----------------------------------------------------------------------------

  const L = `${CH}/dm/person:ed/sess-alex/link`;
  const T = `${CH}/dm/person:ed/sess-alex/messages`;
  const crossOf = async (b: ReturnType<typeof request.agent>) => (await thread(b, T)).body.cross as { link: string; pausedBy: string | null; canResume: boolean; viewerIs: string };
  /** Ed has asked, and Alex allowed it: the link is open. */
  async function openLink(w: W) {
    await say(w.edB, 'general', `@review@alex-box ${MSG_FROM_ED}`);
    await answer(w.alexB, (await requestsOf(w.alexB))[0]!.id, 'deliver');
  }

  it('lets only the sender resume a link the sender paused, and says who paused it', async () => {
    const w = await world();
    await openLink(w);
    expect(await crossOf(w.alexB)).toMatchObject({ link: 'open', pausedBy: null, canResume: false });
    expect((await link(w.edB, 'pause')).body).toMatchObject({ ok: true, link: 'paused' });
    expect(await crossOf(w.alexB)).toMatchObject({ link: 'paused', pausedBy: 'sender', canResume: false, viewerIs: 'owner' });
    expect(await crossOf(w.edB)).toMatchObject({ link: 'paused', pausedBy: 'sender', canResume: true, viewerIs: 'sender' });
    const refused = await link(w.alexB, 'resume', L);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Ed paused/);
    expect(await crossOf(w.alexB)).toMatchObject({ link: 'paused' });
    expect((await w.alexB.get(CH)).body.directs[0].cross).toMatchObject({ pausedBy: 'sender', canResume: false });
    expect((await w.edB.get(CH)).body.directs[0].cross).toMatchObject({ pausedBy: 'sender', canResume: true });
    // The owner can still remove it, and a removed link has no pauser.
    expect((await link(w.alexB, 'remove', L)).body).toMatchObject({ ok: true, link: 'removed' });
    expect(await crossOf(w.alexB)).toMatchObject({ link: 'removed', pausedBy: null, canResume: false });
  });

  it('lets only the agent\'s owner resume a link the owner paused', async () => {
    const w = await world();
    await openLink(w);
    expect((await link(w.alexB, 'pause', L)).body).toMatchObject({ ok: true, link: 'paused' });
    expect(await crossOf(w.edB)).toMatchObject({ pausedBy: 'owner', canResume: false });
    expect(await crossOf(w.alexB)).toMatchObject({ pausedBy: 'owner', canResume: true });
    const refused = await link(w.edB, 'resume');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Alex paused/);
    // The sender can still remove the link, and cannot reopen it.
    expect((await link(w.alexB, 'resume', L)).body).toMatchObject({ ok: true, link: 'open' });
    expect(await crossOf(w.edB)).toMatchObject({ link: 'open', pausedBy: null });
  });

  it('lets an Admin pause and resume any link, and only an Admin resume one an Admin paused', async () => {
    const w = await world();
    await openLink(w);
    const admin = await signedIn(w, 'Admin', SECRET);
    expect((await link(admin, 'pause', L)).body).toMatchObject({ ok: true, link: 'paused' });
    expect(await crossOf(w.edB)).toMatchObject({ pausedBy: 'admin', canResume: false });
    expect(await crossOf(w.alexB)).toMatchObject({ pausedBy: 'admin', canResume: false });
    expect(await crossOf(admin)).toMatchObject({ pausedBy: 'admin', canResume: true, viewerIs: 'admin' });
    for (const b of [w.edB, w.alexB]) {
      const refused = await link(b, 'resume', L);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/Administrator/);
    }
    expect((await link(admin, 'resume', L)).body).toMatchObject({ ok: true, link: 'open' });
    // An Admin can resume a pause either owner made.
    await link(w.edB, 'pause');
    expect((await link(admin, 'resume', L)).body).toMatchObject({ ok: true, link: 'open' });
  });

  it('lets either owner resume a pause whose pauser is not known (one made before the pauser was kept)', async () => {
    const w = await world();
    await openLink(w);
    const body = (await thread(w.alexB, T)).body as { a: { kind: string; reporterKey: string }; b: { kind: string; reporterKey: string } };
    const key = [body.a, body.b].find((p) => p.kind === 'agent')!.reporterKey;
    // The store call with no pauser is what a row paused before this change looks like.
    const paused = await w.fleet.peers.setPersonLink('person:ed', key, 'pause', { name: 'ed', admin: false });
    expect(paused, JSON.stringify(paused)).toMatchObject({ ok: true });
    expect(await crossOf(w.alexB)).toMatchObject({ link: 'paused', pausedBy: null, canResume: true });
    expect(await crossOf(w.edB)).toMatchObject({ pausedBy: null, canResume: true });
    expect((await link(w.alexB, 'resume', L)).body).toMatchObject({ ok: true, link: 'open' });
  });

  // ---- An agent answers the person who wrote to it (#1034) ----------------------------------------------------------------

  const reply = (w: W, text: string, to = 'person:ed', session = 'sess-alex', token = w.alex.token) => request(w.app).post(`/api/fleet/sessions/${session}/peers/messages`).set('X-Podium-Token', token).send({ to, text });
  const REPLY = 'The build is green now, Ed.';

  it('lets the agent answer the person over the link its owner opened: stored delivered, in the same conversation, read by both owners and an Admin', async () => {
    const w = await world();
    await openLink(w);
    const sse: string[] = [];
    w.fleet.hub.add({ write: (c: string) => sse.push(c) });
    const sent = await reply(w, REPLY);
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    expect(sent.body).toMatchObject({ ok: true, person: true, to: { name: 'Ed' } });
    await w.fleet.flush();
    await settle();
    for (const b of [w.edB, w.alexB, await signedIn(w, 'Admin', SECRET)]) {
      const t = await thread(b, T);
      expect(t.status).toBe(200);
      expect(t.body.messages.map((m: { text: string; author: string; state: string }) => [m.author, m.state, m.text])).toEqual([['person', 'ready', FULL], ['agent', 'delivered', REPLY]]);
      expect(t.body.messages[1]).toMatchObject({ from: { kind: 'agent', sessionId: 'sess-alex', name: 'review' }, to: [{ sessionId: 'person:ed', name: 'Ed', state: 'delivered' }] });
      expect(t.body.cross).toMatchObject({ link: 'open' });
    }
    // The owner has nothing to approve for it, and the agent is handed only the person's own text, never its own answer back.
    expect(await requestsOf(w.alexB)).toEqual([]);
    expect((await handed(w)).map((d) => d.text)).toEqual([FULL]);
    // The audit log names the event and never the text; the stream carries no text.
    expect(await logKinds(w)).toContain('peer_delivered');
    expect(JSON.stringify(await logRows(w))).not.toContain(REPLY);
    expect(sse.join('')).not.toContain(REPLY);
    const chats = sse.join('').split('\n\n').filter((c) => c.includes('event: chat')).map((c) => JSON.parse(c.split('data: ')[1]!));
    expect(chats.length).toBeGreaterThan(0);
    for (const d of chats) expect(Object.keys(d).sort()).toEqual(['rev', 'scope']);
  });

  it('counts the answer as one unread and a mention for the person, and one unread for the owner', async () => {
    const w = await world();
    await openLink(w);
    await settle();
    const before = { ed: await dmCounts(w.edB), alex: await dmCounts(w.alexB) };
    expect((await reply(w, REPLY)).status).toBe(202);
    await w.fleet.flush();
    await settle();
    const ed = await dmCounts(w.edB);
    const alex = await dmCounts(w.alexB);
    expect(ed[0]!.unread).toBe(before.ed[0]!.unread + 1);
    expect(ed[0]!.mentions).toBe(before.ed[0]!.mentions + 1);
    expect(alex[0]!.unread).toBe(before.alex[0]!.unread + 1);
    expect(alex[0]!.mentions).toBe(before.alex[0]!.mentions);
  });

  it('never returns the answer from a channel, to a third person, or from the agent routes', async () => {
    const w = await world();
    await openLink(w);
    await reply(w, REPLY);
    const zed = await w.people.createPerson('Zed');
    const zedB = await signedIn(w, 'Zed', zed.token);
    expect((await thread(zedB, T)).status).toBe(403);
    expect(JSON.stringify((await zedB.get(CH)).body)).not.toContain(REPLY);
    for (const b of [w.edB, w.alexB, zedB]) {
      for (const path of ['/channels/general/messages', '/channels/group/messages']) expect(JSON.stringify((await b.get(`${CH}${path}`)).body)).not.toContain(REPLY);
      expect(JSON.stringify((await b.get('/api/fleet/respond/peers/conversations')).body ?? '')).not.toContain(REPLY);
    }
  });

  it('refuses an answer to a person without a link, in the generic words, and names nothing of the owner\'s other agents', async () => {
    const w = await world();
    await post(w, w.alex.token, report('Alex', 'sess-secret', 'hidden-plan', BOX));
    // Ed never wrote.
    const none = await reply(w, REPLY);
    expect(none.status).toBe(404);
    expect(none.body.error).toBe('You cannot see an orchestrator called person:ed. Run podium_peers for the list.');
    // Ed wrote and the owner has not allowed it yet: still no link.
    await say(w.edB, 'general', FULL);
    expect((await reply(w, REPLY)).status).toBe(404);
    // A link to one agent is not a way for another agent of that owner to write.
    await answer(w.alexB, (await requestsOf(w.alexB))[0]!.id, 'deliver');
    const other = await reply(w, REPLY, 'person:ed', 'sess-secret');
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toMatch(/hidden-plan|review/);
    expect((await reply(w, REPLY, 'person:nobody')).status).toBe(404);
    expect(((await thread(w.edB, T)).body.messages as unknown[]).length).toBe(1);
  });

  it('refuses an answer while the link is paused, and after it is removed, with the reason, and sends again once it is open', async () => {
    const w = await world();
    await openLink(w);
    expect((await link(w.edB, 'pause')).body.link).toBe('paused');
    const paused = await reply(w, REPLY);
    expect(paused.status).toBe(409);
    expect(paused.body.error).toMatch(/paused/);
    expect((await link(w.edB, 'resume')).body.link).toBe('open');
    expect((await reply(w, REPLY)).status).toBe(202);
    expect((await link(w.alexB, 'remove', L)).body.link).toBe('removed');
    const removed = await reply(w, 'again');
    expect(removed.status).toBe(403);
    expect(removed.body.error).toMatch(/removed/);
    expect((await link(w.alexB, 'allow', L)).body.link).toBe('open');
    expect((await reply(w, 'back')).status).toBe(202);
    expect(((await thread(w.edB, T)).body.messages as { text: string }[]).map((m) => m.text)).toEqual([FULL, REPLY, 'back']);
  });

  it('limits how fast an agent can answer, and refuses an agent that has ended', async () => {
    const w = await world();
    await openLink(w);
    let limited = 0;
    for (let i = 0; i < 9; i++) if ((await reply(w, `flood ${i}`)).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    await alexOne(w, { status: 'done', waitReason: null });
    await w.fleet.flush();
    const ended = await reply(w, 'late');
    expect([403, 404]).toContain(ended.status);
    // What it wrote before it ended is still there.
    expect(((await thread(w.edB, T)).body.messages as unknown[]).length).toBeGreaterThan(1);
  });

  it('keeps an answer when the hourly sweep runs, and removes it with the conversation', async () => {
    const w = await world();
    await openLink(w);
    await reply(w, REPLY);
    await w.fleet.peers.retain();
    expect(((await thread(w.edB, T)).body.messages as { text: string }[]).map((m) => m.text)).toContain(REPLY);
    expect((await w.edB.delete(`${CH}${'/dm/person:ed/sess-alex'}`).set(H)).body).toMatchObject({ ok: true });
    expect((await w.alexB.get(CH)).body.directs).toEqual([]);
  });

  // ---- An Admin's @ of another person's agent needs the owner too (#1034) ----------------------------------------------

  it('holds an Administrator\'s @ of another person\'s agent for its owner, like anyone\'s', async () => {
    const w = await world();
    const admins = (await w.people.allGroups()).find((g) => g.name === 'Administrators')!;
    const root = await w.people.createPerson('Root', admins.id);
    const rootB = await signedIn(w, 'Root', root.token);
    const res = await say(rootB, 'general', '@review@alex-box look at this');
    expect(res.status).toBe(201);
    expect(res.body.message.mentions[0]).toMatchObject({ state: 'approval', why: 'Waiting for Alex to approve' });
    expect(await requestsOf(w.alexB)).toHaveLength(1);
    expect(await handed(w)).toEqual([]);
    // Their own agent is still theirs: no approval.
    expect((await rootB.get(CH)).body.me).toMatchObject({ admin: true });
  });

  it('refuses an Admin on the admin secret an @ of another person\'s agent, in plain words', async () => {
    const w = await world();
    const admin = await signedIn(w, 'Admin', SECRET);
    const res = await say(admin, 'general', '@review@alex-box look at this');
    expect(res.status).toBe(201);
    expect(res.body.message.mentions[0]).toMatchObject({ state: 'not-delivered' });
    expect(res.body.message.mentions[0].why).toMatch(/no person name/);
    expect(await requestsOf(w.alexB)).toEqual([]);
    expect(await handed(w)).toEqual([]);
  });

  // ---- Counts of a Direct Message (#1034) --------------------------------------------------------------------------------

  const dmCounts = async (b: ReturnType<typeof request.agent>) => ((await b.get(CH)).body.directs as { thread: string; unread: number; mentions: number }[]).map((d) => ({ thread: d.thread, unread: d.unread, mentions: d.mentions }));

  it('counts a person\'s message to another person\'s agent as unread and a mention for the owner, and not for the author', async () => {
    const w = await world();
    await say(w.edB, 'general', `@review@alex-box ${MSG_FROM_ED}`);
    await w.fleet.flush();
    await settle();
    const mineAlex = await dmCounts(w.alexB);
    expect(mineAlex).toHaveLength(1);
    expect(mineAlex[0]).toMatchObject({ unread: 1, mentions: 1 });
    expect(await dmCounts(w.edB)).toMatchObject([{ unread: 0, mentions: 0 }]);
    // A second message adds to it.
    await answer(w.alexB, (await requestsOf(w.alexB))[0]!.id, 'deliver');
    await w.edB.post(`${CH}${dmPath}/messages`).set(H).send({ text: 'and again' });
    await settle();
    expect(await dmCounts(w.alexB)).toMatchObject([{ unread: 2, mentions: 2 }]);
    // Marking the thread read clears it, for whoever reads it, and only for them.
    const t = mineAlex[0]!.thread;
    expect((await w.alexB.post(`${CH}/read`).set(H).send({ thread: t, upTo: null })).body).toMatchObject({ ok: true, unread: 0, mentions: 0 });
    expect(await dmCounts(w.alexB)).toMatchObject([{ unread: 0, mentions: 0 }]);
    expect((await w.edB.post(`${CH}/read`).set(H).send({ thread: t, upTo: null })).status).toBe(200);
    const zed = await signedIn(w, 'Zed', (await w.people.createPerson('Zed')).token);
    expect((await zed.post(`${CH}/read`).set(H).send({ thread: t, upTo: null })).status).toBe(403);
  });

  it('counts an agent-to-agent message as unread for the owner, with no mention, and never counts a person\'s own message against them', async () => {
    const w = await world();
    await linkedConversation(w);
    await w.fleet.flush();
    await settle();
    expect(await dmCounts(w.edB)).toMatchObject([{ unread: 1, mentions: 0 }]);
    const own = await w.edB.post(`${CH}/dm/me/sess-dev/messages`).set(H).send({ text: 'hello dev' });
    expect(own.status).toBe(202);
    await settle();
    const counts = await dmCounts(w.edB);
    expect(counts).toHaveLength(2);
    expect(counts.map((c) => [c.unread, c.mentions]).sort()).toEqual([[0, 0], [1, 0]]);
    expect((await w.alexB.get(CH)).body.directs).toEqual([]);
  });
});

describe('an Admin reading a conversation (#1034)', () => {
  const MIN = 60_000;
  const AB = `${CH}/dm/sess-dev/sess-tester`;
  const ping = (b: ReturnType<typeof request.agent>, path: string, body: Record<string, unknown> = {}) => b.post(path).set(H).send(body);
  const reads = (b: ReturnType<typeof request.agent>, q = '?owner=Ed') => read(b, 'group', q).then((r) => r.body.adminReads as { admin: string; startedAt: number; lastSeenAt: number; kind: string }[]);
  const groupLive = async (b: ReturnType<typeof request.agent>) => ((await b.get(CH)).body.channels as { id: string; adminReading: unknown }[]).find((c) => c.id === 'group')!.adminReading;
  const dmLive = async (b: ReturnType<typeof request.agent>) => ((await b.get(CH)).body.directs as { adminReading: unknown[] }[]).map((d) => d.adminReading);
  const store = (w: W) => w.fleet.chat.core.store.adminReads;
  const MSG = 'Please look at the build, Alex.';

  async function crossWorld() {
    const w = await world();
    await say(w.edB, 'general', `@review@alex-box ${MSG}`);
    return w;
  }
  const CROSS = `${CH}/dm/person:ed/sess-alex`;

  it('records a reading of a person\'s group, tells that person, and shows no one else anything', async () => {
    const w = await world();
    await say(w.edB, 'group', 'for the admin');
    expect(await groupLive(w.edB)).toEqual([]);
    expect(await reads(w.edB, '')).toEqual([]);
    const admin = await signedIn(w, 'Admin', SECRET);
    expect(texts(await read(admin, 'group', '?owner=Ed'))).toEqual(['for the admin']);
    const start = w.now();
    expect(await groupLive(w.edB)).toEqual([{ admin: 'Admin secret', since: start, until: start + 30_000 }]);
    expect(await reads(w.edB, '')).toEqual([{ admin: 'Admin secret', startedAt: start, lastSeenAt: start, kind: 'read' }]);
    // The Admin reads the record too; another person sees nothing of Ed's group.
    expect(await reads(admin)).toHaveLength(1);
    expect(await groupLive(w.alexB)).toEqual([]);
    expect(JSON.stringify((await w.alexB.get(CH)).body)).not.toContain('Admin secret');
    expect((await read(w.alexB, 'group', '?owner=Ed')).status).toBe(403);
    // The record carries no text.
    expect(JSON.stringify(await store(w).list('group:ed'))).not.toContain('for the admin');
  });

  it('puts reads within 30 minutes in one record and starts a second one after a longer gap', async () => {
    const w = await world();
    const admin = await signedIn(w, 'Admin', SECRET);
    const t0 = w.now();
    await read(admin, 'group', '?owner=Ed');
    w.tick(29 * MIN);
    await read(admin, 'group', '?owner=Ed');
    w.tick(29 * MIN);
    await read(admin, 'group', '?owner=Ed');
    expect(await reads(w.edB, '')).toEqual([{ admin: 'Admin secret', startedAt: t0, lastSeenAt: t0 + 58 * MIN, kind: 'read' }]);
    w.tick(31 * MIN);
    const ed = await signedIn(w, 'Ed', w.ed.token);
    await read(admin, 'group', '?owner=Ed');
    expect(await reads(ed, '')).toEqual([
      { admin: 'Admin secret', startedAt: t0, lastSeenAt: t0 + 58 * MIN, kind: 'read' },
      { admin: 'Admin secret', startedAt: t0 + 89 * MIN, lastSeenAt: t0 + 89 * MIN, kind: 'read' },
    ]);
  });

  it('is live for 30 seconds after the last read, and the overview never reports one whose time has passed', async () => {
    const w = await world();
    const admin = await signedIn(w, 'Admin', SECRET);
    const t0 = w.now();
    await read(admin, 'group', '?owner=Ed');
    w.tick(29_000);
    expect(await groupLive(w.edB)).toEqual([{ admin: 'Admin secret', since: t0, until: t0 + 30_000 }]);
    await read(admin, 'group', '?owner=Ed');
    expect(await groupLive(w.edB)).toEqual([{ admin: 'Admin secret', since: t0, until: t0 + 59_000 }]);
    w.tick(30_000);
    expect(await groupLive(w.edB)).toEqual([]);
    w.tick(1_000);
    expect(await groupLive(w.edB)).toEqual([]);
    // The record stays.
    expect(await reads(w.edB, '')).toHaveLength(1);
  });

  it('records an Admin who is a person under that person\'s name', async () => {
    const w = await world();
    const admins = (await w.people.allGroups()).find((g) => g.name === 'Administrators')!;
    const root = await w.people.createPerson('Root', admins.id);
    const rootB = await signedIn(w, 'Root', root.token);
    await read(rootB, 'group', '?owner=Ed');
    expect((await reads(w.edB, ''))[0]).toMatchObject({ admin: 'Root' });
    expect(await groupLive(w.edB)).toMatchObject([{ admin: 'Root' }]);
    // Their own group, named or not, is not a reading of someone else's.
    await say(rootB, 'group', 'mine');
    await read(rootB, 'group');
    await read(rootB, 'group', '?owner=Root');
    expect(await store(w).list('group:root')).toEqual([]);
  });

  it('never records General, nor a person reading their own group, nor a person who may not read another\'s', async () => {
    const w = await world();
    await say(w.edB, 'general', 'hello all');
    const admin = await signedIn(w, 'Admin', SECRET);
    expect((await read(admin, 'general')).status).toBe(200);
    expect((await read(w.edB, 'general')).status).toBe(200);
    expect((await read(w.edB, 'group')).status).toBe(200);
    expect((await read(w.edB, 'group', '?owner=Ed')).status).toBe(200);
    expect((await read(w.alexB, 'group', '?owner=Ed')).status).toBe(403);
    expect(await store(w).threads('')).toEqual([]);
    expect((await ping(admin, `${CH}/channels/general/reading`)).status).toBe(400);
    expect(await store(w).threads('')).toEqual([]);
    await settle();
    expect(await logKinds(w)).not.toContain('chat_admin_read');
  });

  it('records an Admin reading a conversation between a person\'s two agents, for that person', async () => {
    const w = await world();
    await linkedConversation(w);
    const admin = await signedIn(w, 'Admin', SECRET);
    expect(await dmLive(w.edB)).toEqual([[]]);
    expect((await admin.get(`${AB}/messages`)).body.adminReads).toHaveLength(1);
    const t0 = w.now();
    expect(await dmLive(w.edB)).toEqual([[{ admin: 'Admin secret', since: t0, until: t0 + 30_000 }]]);
    const thread = (await w.edB.get(`${AB}/messages`)).body;
    expect(thread.adminReads).toEqual([{ admin: 'Admin secret', startedAt: t0, lastSeenAt: t0, kind: 'read' }]);
    expect(await dmLive(w.alexB)).toEqual([]);
    expect((await w.alexB.get(`${AB}/messages`)).status).toBe(403);
  });

  it('tells both owners of a conversation across owners, an Admin reads it too, and a third person sees nothing', async () => {
    const w = await crossWorld();
    const zed = await signedIn(w, 'Zed', (await w.people.createPerson('Zed')).token);
    const admin = await signedIn(w, 'Admin', SECRET);
    expect((await admin.get(`${CROSS}/messages`)).status).toBe(200);
    const t0 = w.now();
    const live = { admin: 'Admin secret', since: t0, until: t0 + 30_000 };
    expect(await dmLive(w.edB)).toEqual([[live]]);
    expect(await dmLive(w.alexB)).toEqual([[live]]);
    expect((await w.edB.get(`${CROSS}/messages`)).body.adminReads).toEqual([{ admin: 'Admin secret', startedAt: t0, lastSeenAt: t0, kind: 'read' }]);
    expect((await w.alexB.get(`${CROSS}/messages`)).body.adminReads).toHaveLength(1);
    expect(await dmLive(zed)).toEqual([]);
    expect(JSON.stringify((await zed.get(CH)).body)).not.toContain('Admin secret');
    expect((await zed.get(`${CROSS}/messages`)).status).toBe(403);
    expect((await ping(zed, `${CROSS}/reading`)).status).toBe(403);
    // Neither owner's reading of it is recorded.
    await w.alexB.get(`${CROSS}/messages`);
    await w.edB.get(`${CROSS}/messages`);
    expect((await w.edB.get(`${CROSS}/messages`)).body.adminReads).toHaveLength(1);
    expect(await store(w).threads('dm:')).toHaveLength(1);
  });

  it('writes one chat_admin_read per reading session to the Admin log, with no text', async () => {
    const w = await world();
    await say(w.edB, 'group', 'PRIVATE-GROUP-TEXT');
    const admin = await signedIn(w, 'Admin', SECRET);
    await read(admin, 'group', '?owner=Ed');
    w.tick(MIN);
    await read(admin, 'group', '?owner=Ed');
    await ping(admin, `${CH}/channels/group/reading`, { owner: 'Ed' });
    await settle();
    expect((await logKinds(w)).filter((k) => k === 'chat_admin_read')).toHaveLength(1);
    w.tick(31 * MIN);
    await read(admin, 'group', '?owner=Ed');
    await settle();
    const rows = (await logRows(w)).filter((r) => r.kind === 'chat_admin_read');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.detail).toMatch(/Admin secret.*ed/i);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE-GROUP-TEXT');
  });

  it('sends only a revision and a scope on the stream when a reading starts', async () => {
    const w = await world();
    await say(w.edB, 'group', 'STREAM-SECRET-TEXT');
    await linkedConversation(w);
    const admin = await signedIn(w, 'Admin', SECRET);
    const sse: string[] = [];
    w.fleet.hub.add({ write: (c: string) => sse.push(c) });
    const chats = () => sse.join('').split('\n\n').filter((c) => c.includes('event: chat'));
    await read(admin, 'group', '?owner=Ed');
    const first = chats().length;
    expect(first).toBeGreaterThan(0);
    await read(admin, 'group', '?owner=Ed');
    expect(chats()).toHaveLength(first);
    await admin.get(`${AB}/messages`);
    expect(chats().length).toBeGreaterThan(first);
    // A reading that went stale and starts again within the session is told again.
    const before = chats().length;
    w.tick(31_000);
    await ping(admin, `${CH}/channels/group/reading`, { owner: 'Ed' });
    expect(chats().length).toBeGreaterThan(before);
    for (const c of chats()) expect(Object.keys(JSON.parse(c.split('data: ')[1]!)).sort()).toEqual(['rev', 'scope']);
    expect(sse.join('')).not.toMatch(/STREAM-SECRET-TEXT|Admin secret/);
  });

  it('lets only an Admin ping a reading, and answers it with nothing but ok', async () => {
    const w = await world();
    await linkedConversation(w);
    const admin = await signedIn(w, 'Admin', SECRET);
    for (const b of [w.edB, w.alexB]) {
      expect((await ping(b, `${CH}/channels/group/reading`, { owner: 'Ed' })).status).toBe(403);
      expect((await ping(b, `${AB}/reading`)).status).toBe(403);
    }
    expect(await store(w).threads('')).toEqual([]);
    const t0 = w.now();
    const g = await ping(admin, `${CH}/channels/group/reading`, { owner: 'Ed' });
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ ok: true });
    w.tick(15_000);
    const d = await ping(admin, `${AB}/reading`);
    expect(d.status).toBe(200);
    expect(d.body).toEqual({ ok: true });
    // A ping keeps a reading live.
    expect(await groupLive(w.edB)).toMatchObject([{ since: t0, until: t0 + 30_000 }]);
    await ping(admin, `${CH}/channels/group/reading`, { owner: 'Ed' });
    expect(await groupLive(w.edB)).toMatchObject([{ since: t0, until: t0 + 45_000 }]);
    expect((await ping(admin, `${CH}/channels/group/reading`)).status).toBe(400);
    expect((await ping(admin, `${CH}/dm/sess-dev/sess-nope/reading`)).status).toBe(404);
    expect((await request(w.app).post(`${AB}/reading`).send({})).status).toBe(403);
  });

  it('deletes the records with the conversation, with Remove all messages, and by the retention days', async () => {
    const w = await crossWorld();
    await linkedConversation(w);
    await say(w.edB, 'group', 'g');
    const admin = await signedIn(w, 'Admin', SECRET);
    await admin.get(`${CROSS}/messages`);
    await admin.get(`${AB}/messages`);
    await read(admin, 'group', '?owner=Ed');
    expect((await store(w).threads('')).length).toBe(3);
    // Delete conversation.
    expect((await w.edB.delete(AB).set(H)).status).toBe(200);
    expect(await store(w).threads('dm:')).toHaveLength(1);
    expect((await w.edB.delete(CROSS).set(H)).status).toBe(200);
    expect(await store(w).threads('dm:')).toEqual([]);
    // Remove all messages by the person does not erase the evidence of who read them (#1034).
    expect(await reads(w.edB, '')).toHaveLength(1);
    expect((await w.edB.delete(`${CH}/channels/group/messages`).set(H).send({})).status).toBe(200);
    expect(await reads(w.edB, '')).toMatchObject([{ admin: 'Admin secret', kind: 'read' }]);
    // Retention: a record older than the Admin's days goes with the hourly job.
    w.tick(29 * 86_400_000);
    await w.fleet.retain();
    expect(await store(w).threads('')).toHaveLength(1);
    w.tick(2 * 86_400_000);
    await w.fleet.retain();
    expect(await store(w).threads('')).toEqual([]);
  });

  it('deletes the records of a hidden conversation when its grace period ends', async () => {
    const w = await world();
    await linkedConversation(w);
    const admin = await signedIn(w, 'Admin', SECRET);
    await admin.get(`${AB}/messages`);
    await tester(w, { status: 'done', waitReason: null });
    await dev(w, { status: 'done', waitReason: null });
    w.tick(10_000);
    await w.fleet.sweep();
    w.tick(23 * 3_600_000);
    await w.fleet.retain();
    expect(await store(w).threads('dm:')).toHaveLength(1);
    w.tick(2 * 3_600_000);
    await w.fleet.retain();
    expect(await store(w).threads('dm:')).toEqual([]);
  });

  it('names every Admin who is reading at once, each with their own record', async () => {
    const w = await crossWorld();
    const admins = (await w.people.allGroups()).find((g) => g.name === 'Administrators')!;
    const root = await w.people.createPerson('Root', admins.id);
    const rootB = await signedIn(w, 'Root', root.token);
    const secret = await signedIn(w, 'Admin', SECRET);
    await read(secret, 'group', '?owner=Ed');
    w.tick(5_000);
    await read(rootB, 'group', '?owner=Ed');
    await secret.get(`${CROSS}/messages`);
    w.tick(5_000);
    await rootB.get(`${CROSS}/messages`);
    const names = (a: { admin: string }[]) => a.map((x) => x.admin).sort();
    expect(names((await groupLive(w.edB)) as { admin: string }[])).toEqual(['Admin secret', 'Root']);
    for (const b of [w.edB, w.alexB]) expect(names(((await dmLive(b)) as { admin: string }[][])[0]!)).toEqual(['Admin secret', 'Root']);
    expect((await reads(w.edB, '')).map((r) => r.admin).sort()).toEqual(['Admin secret', 'Root']);
    // One stops reading: the other stays named.
    w.tick(26_000);
    await read(rootB, 'group', '?owner=Ed');
    expect(await groupLive(w.edB)).toMatchObject([{ admin: 'Root' }]);
  });

  // ---- Pausing a Direct Message link as an Admin ---------------------------------------------------------------------------

  const linkOp = (b: ReturnType<typeof request.agent>, op: string, path = `${AB}/link`) => b.put(path).set(H).send({ op });
  const dmInfo = async (b: ReturnType<typeof request.agent>) => ((await b.get(CH)).body.directs as { paused: boolean; pausedBy: string | null; state: string }[])[0]!;

  it('lets an Admin pause and resume a conversation between one person\'s agents, which that person cannot undo', async () => {
    const w = await world();
    await linkedConversation(w);
    const admin = await signedIn(w, 'Admin', SECRET);
    // The owner has no pause or resume of their own here: they change it on My reporters.
    expect((await linkOp(w.edB, 'pause')).status).toBe(404);
    expect(await dmInfo(w.edB)).toMatchObject({ paused: false, pausedBy: null });
    expect((await linkOp(admin, 'pause')).body).toMatchObject({ ok: true, link: 'paused' });
    expect(await dmInfo(w.edB)).toMatchObject({ paused: true, pausedBy: 'admin', pausedByAdmin: 'Admin secret', state: 'paused' });
    expect((await w.edB.get(`${AB}/messages`)).body).toMatchObject({ paused: true, pausedBy: 'admin', pausedByAdmin: 'Admin secret' });
    // Ed cannot resume it, by the page or by My reporters.
    const mac = (await w.edB.get(`${AB}/messages`)).body;
    const keys = [mac.a.reporterKey, mac.b.reporterKey];
    const mine = await w.edB.put('/api/fleet/respond/peers/links').set(H).send({ a: keys[0], b: keys[1], paused: false });
    expect(mine.status).toBe(403);
    expect(await dmInfo(w.edB)).toMatchObject({ paused: true, pausedBy: 'admin' });
    // The Admin resumes it.
    expect((await linkOp(admin, 'resume')).body).toMatchObject({ ok: true, link: 'open' });
    expect(await dmInfo(w.edB)).toMatchObject({ paused: false, pausedBy: null, pausedByAdmin: null });
    // Ed may pause and resume it on My reporters as before.
    expect((await w.edB.put('/api/fleet/respond/peers/links').set(H).send({ a: keys[0], b: keys[1], paused: true })).status).toBe(200);
    expect(await dmInfo(w.edB)).toMatchObject({ paused: true, pausedBy: null });
    expect((await w.edB.put('/api/fleet/respond/peers/links').set(H).send({ a: keys[0], b: keys[1], paused: false })).status).toBe(200);
    await settle();
    const kinds = await logKinds(w);
    expect(kinds).toEqual(expect.arrayContaining(['peer_right_paused', 'peer_right_resumed']));
    const rows = (await logRows(w)).filter((r) => r.kind === 'peer_right_paused');
    expect(rows.map((r) => r.actor)).toContain('Admin secret');
  });

  it('lets an Admin pause and resume a conversation across owners, and neither remove its link, nor delete it, nor write to it', async () => {
    const w = await crossWorld();
    await answerAllow(w);
    const admin = await signedIn(w, 'Admin', SECRET);
    expect((await linkOp(admin, 'pause', `${CROSS}/link`)).body).toMatchObject({ ok: true, link: 'paused' });
    expect((await w.edB.get(CH)).body.directs[0].cross).toMatchObject({ pausedBy: 'admin', pausedByAdmin: 'Admin secret', canResume: false });
    expect((await linkOp(w.alexB, 'resume', `${CROSS}/link`)).status).toBe(403);
    expect((await linkOp(admin, 'resume', `${CROSS}/link`)).body).toMatchObject({ ok: true, link: 'open' });
    for (const op of ['remove', 'allow']) expect((await linkOp(admin, op, `${CROSS}/link`)).status, op).toBe(403);
    expect((await admin.delete(CROSS).set(H)).status).toBe(403);
    expect((await admin.post(`${CROSS}/messages`).set(H).send({ text: 'admin tries' })).status).toBe(403);
    expect((await w.edB.get(CH)).body.directs[0].cross).toMatchObject({ link: 'open', pausedByAdmin: null });
  });
  it('names the Admin who paused a link by their own name, when that Admin is a person, and keeps the pause theirs', async () => {
    const w = await world();
    await linkedConversation(w);
    const admins = (await w.people.allGroups()).find((g) => g.name === 'Administrators')!;
    const rootB = await signedIn(w, 'Root', (await w.people.createPerson('Root', admins.id)).token);
    expect((await linkOp(rootB, 'pause')).body).toMatchObject({ ok: true, link: 'paused' });
    expect(await dmInfo(w.edB)).toMatchObject({ pausedBy: 'admin', pausedByAdmin: 'Root' });
    // Ed pausing again does not take the pause over from the Admin.
    const mac = (await w.edB.get(`${AB}/messages`)).body;
    expect((await w.edB.put('/api/fleet/respond/peers/links').set(H).send({ a: mac.a.reporterKey, b: mac.b.reporterKey, paused: true })).status).toBe(200);
    expect(await dmInfo(w.edB)).toMatchObject({ pausedBy: 'admin', pausedByAdmin: 'Root' });
    expect((await w.edB.put('/api/fleet/respond/peers/links').set(H).send({ a: mac.a.reporterKey, b: mac.b.reporterKey, paused: false })).status).toBe(403);
    expect((await linkOp(rootB, 'resume')).body).toMatchObject({ ok: true, link: 'open' });
  });

  it('names the Admin who paused a person\'s group, and lets only an Admin resume it', async () => {
    const w = await world();
    const admin = await signedIn(w, 'Admin', SECRET);
    const info = async (b: ReturnType<typeof request.agent>) => ((await b.get(CH)).body.channels as { id: string; paused: boolean; pausedByAdmin?: string | null }[]).find((c) => c.id === 'group')!;
    expect(await info(w.edB)).toMatchObject({ paused: false, pausedByAdmin: null });
    expect((await w.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: true })).status).toBe(200);
    expect(await info(w.edB)).toMatchObject({ paused: true, pausedByAdmin: null });
    expect((await w.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: false })).status).toBe(200);
    expect((await admin.put(`${CH}/channels/group/pause`).set(H).send({ owner: 'Ed', paused: true })).status).toBe(200);
    expect(await info(w.edB)).toMatchObject({ paused: true, pausedByAdmin: 'Admin secret' });
    expect((await w.edB.put(`${CH}/channels/group/pause`).set(H).send({ paused: false })).status).toBe(403);
    expect(await info(w.edB)).toMatchObject({ paused: true, pausedByAdmin: 'Admin secret' });
    expect((await admin.put(`${CH}/channels/group/pause`).set(H).send({ owner: 'Ed', paused: false })).status).toBe(200);
    expect(await info(w.edB)).toMatchObject({ paused: false, pausedByAdmin: null });
  });

  it('refuses an Admin\'s remove, delete and send on a conversation between one person\'s agents', async () => {
    const w = await world();
    await linkedConversation(w);
    const admin = await signedIn(w, 'Admin', SECRET);
    expect((await linkOp(admin, 'remove')).status).toBe(403);
    expect((await linkOp(admin, 'allow')).status).toBe(403);
    expect((await admin.delete(AB).set(H)).status).toBe(403);
    expect((await admin.post(`${AB}/messages`).set(H).send({ text: 'admin tries' })).status).toBe(403);
    expect((await linkOp(w.alexB, 'pause')).status).toBe(403);
    expect((await w.edB.get(CH)).body.directs).toHaveLength(1);
  });

  /** Alex opens the link Ed's message asked for. */
  async function answerAllow(w: W) {
    const reqs = ((await w.alexB.get('/api/fleet/respond/peers')).body.requests ?? []) as { id: string }[];
    expect((await w.alexB.post(`/api/fleet/respond/peers/requests/${reqs[0]!.id}`).set(H).send({ answer: 'deliver' })).status).toBe(200);
  }
});

describe('the callout an Admin\'s reading or stopping shows the person in podium-reporter (#1034)', () => {
  const AB = `${CH}/dm/sess-dev/sess-tester`;
  const CROSS = `${CH}/dm/person:ed/sess-alex`;
  const SECRET_TEXT = 'a private line about the build';
  const noticesOf = async (w: W, who: 'dev' | 'tester' | 'alex') => {
    const r = who === 'dev' ? await dev(w, { status: 'running', waitReason: null }) : who === 'tester' ? await tester(w) : await alexOne(w);
    return (r.body.adminNotices ?? []) as { id: string; at: number; text: string }[];
  };
  const kinds = async (b: ReturnType<typeof request.agent>, channel: string, q = '') => ((await read(b, channel, q)).body.adminReads as { admin: string; kind: string }[]).map((r) => `${r.admin}:${r.kind}`);
  const linkOp = (b: ReturnType<typeof request.agent>, op: string, path = `${AB}/link`) => b.put(path).set(H).send({ op });

  it('tells every reporter session of the person when an Admin starts reading their group, once, and no one else\'s', async () => {
    const w = await world();
    await say(w.edB, 'group', SECRET_TEXT);
    expect(await noticesOf(w, 'dev')).toEqual([]);
    const admin = await signedIn(w, 'Admin', SECRET);
    await read(admin, 'group', '?owner=Ed');
    const dn = await noticesOf(w, 'dev');
    expect(dn).toHaveLength(1);
    expect(dn[0]!.text).toBe('Admin secret (an Admin) is reading your Podium group.');
    expect(await noticesOf(w, 'tester')).toHaveLength(1);
    expect(await noticesOf(w, 'alex')).toEqual([]);
    // The same reading session, and its keep-alive pings, add nothing; the id stays so the reporter shows it once.
    w.tick(15_000);
    await admin.post(`${CH}/channels/group/reading`).set(H).send({ owner: 'Ed' });
    await read(admin, 'group', '?owner=Ed');
    expect((await noticesOf(w, 'dev')).map((n) => n.id)).toEqual(dn.map((n) => n.id));
    // A callout carries no message text, and lapses after a few minutes.
    expect(JSON.stringify(await noticesOf(w, 'dev'))).not.toContain(SECRET_TEXT);
    w.tick(6 * 60_000);
    expect(await noticesOf(w, 'dev')).toEqual([]);
  });

  it('says nothing to the reporter when a person, or an Admin, reads their own group', async () => {
    const w = await world();
    await read(w.edB, 'group');
    await read(w.edB, 'group', '?owner=Ed');
    expect(await noticesOf(w, 'dev')).toEqual([]);
  });

  it('names the other end in the callout of a conversation between a person\'s agents, and tells only the agent\'s reporter across owners', async () => {
    const w = await world();
    await linkedConversation(w);
    const admin = await signedIn(w, 'Admin', SECRET);
    await admin.get(`${AB}/messages`);
    expect((await noticesOf(w, 'dev')).map((n) => n.text)).toEqual(['Admin secret (an Admin) is reading your Podium conversation with Tester.']);
    expect((await noticesOf(w, 'tester')).map((n) => n.text)).toEqual(['Admin secret (an Admin) is reading your Podium conversation with dev.']);
    const x = await world();
    await say(x.edB, 'general', '@review@alex-box ' + SECRET_TEXT);
    const adminX = await signedIn(x, 'Admin', SECRET);
    await adminX.get(`${CROSS}/messages`);
    expect((await noticesOf(x, 'alex')).map((n) => n.text)).toEqual(['Admin secret (an Admin) is reading your Podium conversation with Ed.']);
    expect(await noticesOf(x, 'dev')).toEqual([]);
    expect(await noticesOf(x, 'tester')).toEqual([]);
  });

  it('uses the Admin\'s own name when the Admin is a person', async () => {
    const w = await world();
    const admins = (await w.people.allGroups()).find((g) => g.name === 'Administrators')!;
    const rootB = await signedIn(w, 'Root', (await w.people.createPerson('Root', admins.id)).token);
    await read(rootB, 'group', '?owner=Ed');
    expect((await noticesOf(w, 'dev'))[0]!.text).toBe('Root (an Admin) is reading your Podium group.');
  });

  it('keeps an Admin\'s Remove all messages on the record for good, tells the person, and leaves a person\'s own removal unrecorded', async () => {
    const w = await world();
    const admin = await signedIn(w, 'Admin', SECRET);
    await say(w.edB, 'group', SECRET_TEXT);
    await read(admin, 'group', '?owner=Ed');
    expect((await admin.delete(`${CH}/channels/group/messages`).set(H).send({ owner: 'Ed' })).status).toBe(200);
    expect(await kinds(w.edB, 'group')).toEqual(['Admin secret:read', 'Admin secret:cleared']);
    expect((await noticesOf(w, 'dev')).map((n) => n.text)).toEqual(['Admin secret (an Admin) is reading your Podium group.', 'Admin secret (an Admin) removed all messages in your Podium group.']);
    // The person removing their own does not add a line, and keeps the Admin's.
    await say(w.edB, 'group', 'again');
    expect((await w.edB.delete(`${CH}/channels/group/messages`).set(H).send({})).status).toBe(200);
    expect(await kinds(w.edB, 'group')).toEqual(['Admin secret:read', 'Admin secret:cleared']);
  });

  it('keeps an Admin\'s Remove all messages of General on the record, shown on General, and tells every session', async () => {
    const w = await world();
    const admin = await signedIn(w, 'Admin', SECRET);
    await say(w.edB, 'general', 'hello all');
    expect(await kinds(w.edB, 'general')).toEqual([]);
    expect((await admin.delete(`${CH}/channels/general/messages`).set(H).send({})).status).toBe(200);
    expect(await kinds(w.alexB, 'general')).toEqual(['Admin secret:cleared']);
    for (const who of ['dev', 'alex'] as const) expect((await noticesOf(w, who)).map((n) => n.text)).toEqual(['Admin secret (an Admin) removed all messages in General.']);
    // The record is not erased by a person's removal in their own group, nor by the next clear; each is its own line.
    expect((await admin.delete(`${CH}/channels/general/messages`).set(H).send({})).status).toBe(200);
    expect(await kinds(w.edB, 'general')).toEqual(['Admin secret:cleared', 'Admin secret:cleared']);
  });

  it('records and announces an Admin\'s pause and resume of a group and of General for everyone, once each', async () => {
    const w = await world();
    const admin = await signedIn(w, 'Admin', SECRET);
    const put = (b: ReturnType<typeof request.agent>, ch: string, body: Record<string, unknown>) => b.put(`${CH}/channels/${ch}/pause`).set(H).send(body);
    expect((await put(admin, 'group', { owner: 'Ed', paused: true })).status).toBe(200);
    await put(admin, 'group', { owner: 'Ed', paused: true });
    expect((await noticesOf(w, 'dev')).map((n) => n.text)).toEqual(['Admin secret (an Admin) paused your Podium group.']);
    expect((await put(admin, 'group', { owner: 'Ed', paused: false })).status).toBe(200);
    expect(await kinds(w.edB, 'group', '')).toEqual(['Admin secret:paused', 'Admin secret:resumed']);
    // The person's own pause is the person's: no line.
    await put(w.edB, 'group', { paused: true });
    await put(w.edB, 'group', { paused: false });
    expect(await kinds(w.edB, 'group')).toEqual(['Admin secret:paused', 'Admin secret:resumed']);
    // General for everyone.
    expect((await put(admin, 'general', { paused: true, everyone: true })).status).toBe(200);
    expect(await kinds(w.alexB, 'general')).toEqual(['Admin secret:paused']);
    expect((await noticesOf(w, 'alex')).map((n) => n.text).pop()).toBe('Admin secret (an Admin) paused General for everyone.');
    await put(admin, 'general', { paused: false, everyone: true });
    expect(await kinds(w.alexB, 'general')).toEqual(['Admin secret:paused', 'Admin secret:resumed']);
  });

  it('records and announces an Admin\'s disconnect and reconnect of a group that is not theirs, once each, and leaves a person\'s own off the record', async () => {
    const w = await world();
    const admin = await signedIn(w, 'Admin', SECRET);
    const put = (b: ReturnType<typeof request.agent>, body: Record<string, unknown>) => b.put(`${CH}/channels/group/disconnect`).set(H).send(body);
    expect((await put(admin, { owner: 'Ed', disconnected: true })).status).toBe(200);
    expect((await noticesOf(w, 'dev')).map((n) => n.text)).toEqual(['Admin secret (an Admin) disconnected your Podium group.']);
    expect((await put(admin, { owner: 'Ed', disconnected: false })).status).toBe(200);
    expect((await noticesOf(w, 'dev')).map((n) => n.text).pop()).toBe('Admin secret (an Admin) reconnected your Podium group.');
    expect(await kinds(w.edB, 'group', '')).toEqual(['Admin secret:disconnected', 'Admin secret:reconnected']);
    // The person's own disconnect is the person's: no line.
    await put(w.edB, { disconnected: true });
    await put(w.edB, { disconnected: false });
    expect(await kinds(w.edB, 'group')).toEqual(['Admin secret:disconnected', 'Admin secret:reconnected']);
  });

  it('records an Admin\'s pause and resume of a link between a person\'s agents, tells both agents\' reporters, and leaves the people\'s own pauses off the record', async () => {
    const w = await world();
    await linkedConversation(w);
    const admin = await signedIn(w, 'Admin', SECRET);
    expect((await linkOp(admin, 'pause')).body).toMatchObject({ ok: true, link: 'paused' });
    for (const who of ['dev', 'tester'] as const) expect((await noticesOf(w, who)).map((n) => n.text)).toEqual(['Admin secret (an Admin) paused the link between dev and Tester.']);
    expect((await linkOp(admin, 'resume')).body).toMatchObject({ ok: true, link: 'open' });
    const thread = (await w.edB.get(`${AB}/messages`)).body;
    expect(thread.adminReads.map((r: { admin: string; kind: string }) => r.kind)).toEqual(['paused', 'resumed']);
    const mac = thread;
    await w.edB.put('/api/fleet/respond/peers/links').set(H).send({ a: mac.a.reporterKey, b: mac.b.reporterKey, paused: true });
    expect(((await w.edB.get(`${AB}/messages`)).body.adminReads as unknown[]).length).toBe(2);
  });

  it('records an Admin\'s pause and resume of a link across owners, and tells the agent\'s reporter only', async () => {
    const w = await world();
    await say(w.edB, 'general', '@review@alex-box ' + SECRET_TEXT);
    const reqs = ((await w.alexB.get('/api/fleet/respond/peers')).body.requests ?? []) as { id: string }[];
    await w.alexB.post(`/api/fleet/respond/peers/requests/${reqs[0]!.id}`).set(H).send({ answer: 'deliver' });
    const admin = await signedIn(w, 'Admin', SECRET);
    await linkOp(admin, 'pause', `${CROSS}/link`);
    expect((await noticesOf(w, 'alex')).map((n) => n.text)).toEqual(['Admin secret (an Admin) paused the link between Ed and review.']);
    expect(await noticesOf(w, 'dev')).toEqual([]);
    await linkOp(admin, 'pause', `${CROSS}/link`);
    await linkOp(admin, 'resume', `${CROSS}/link`);
    const kindsOf = ((await w.edB.get(`${CROSS}/messages`)).body.adminReads as { kind: string }[]).map((r) => r.kind);
    expect(kindsOf).toEqual(['paused', 'resumed']);
  });
});

describe('an Admin browsing a person\'s Chat (#1034)', () => {
  const BROWSE = `${CH}?owner=`;
  const TEXTS = ['ed group secret text', 'agent hello', 'alex general line'];

  async function browseWorld() {
    const w = await world();
    await linkedConversation(w);
    await say(w.edB, 'group', TEXTS[0]!);
    await say(w.alexB, 'general', TEXTS[2]!);
    return w;
  }
  const allText = (b: unknown) => JSON.stringify(b);

  it('gives a signed-in Administrator and the admin secret the same overview, about that person and with no message text', async () => {
    const w = await browseWorld();
    await say(w.edB, 'general', `@review@alex-box ${TEXTS[1]}`);
    const admins = (await w.people.allGroups()).find((g) => g.name === 'Administrators')!;
    const root = await w.people.createPerson('Root', admins.id);
    const rootB = await signedIn(w, 'Root', root.token);
    const secretB = await signedIn(w, 'Admin', SECRET);
    for (const b of [rootB, secretB]) {
      const res = await b.get(`${BROWSE}ed`);
      expect(res.status).toBe(200);
      expect(res.body.me).toMatchObject({ admin: true });
      expect(res.body.channels.map((c: { id: string }) => c.id)).toEqual(['general', 'group']);
      expect(res.body.channels[1]).toMatchObject({ thread: 'group:ed', unread: 0, mentions: 0, messages: 1, can: { pause: true, disconnect: true, removeAll: true } });
      expect(res.body.directs.length).toBeGreaterThan(0);
      for (const d of res.body.directs) expect(d).toMatchObject({ unread: 0, mentions: 0 });
      expect(res.body.people.map((p: { name: string; you: boolean; directs: number }) => [p.name, p.you]).sort()).toEqual([['Alex', false], ['Ed', false], ['Root', false]]);
      expect(res.body.people.find((p: { name: string }) => p.name === 'Ed').directs).toBe(res.body.directs.length);
      for (const t of TEXTS) expect(allText(res.body)).not.toContain(t);
      expect(res.body.agents.map((a: { address: string }) => a.address).sort()).toEqual(['Tester@ci-runner-01', 'dev@ed-mbp']);
    }
    expect(((await rootB.get(`${BROWSE}ed`)).body.me)).toMatchObject({ name: 'Root', actor: 'Root' });
    expect(((await secretB.get(`${BROWSE}ed`)).body.me)).toMatchObject({ name: 'Admin', actor: 'Admin secret' });
  });

  it('includes a cross-person conversation Ed takes part in, and counts it for both people', async () => {
    const w = await browseWorld();
    await say(w.edB, 'general', `@review@alex-box ${TEXTS[1]}`);
    const a = await signedIn(w, 'Admin', SECRET);
    const res = await a.get(`${BROWSE}Ed`);
    expect(res.body.directs.some((d: { cross: unknown }) => d.cross !== null)).toBe(true);
    const alex = await a.get(`${BROWSE}Alex`);
    expect(alex.body.directs.some((d: { cross: unknown }) => d.cross !== null)).toBe(true);
    expect(allText(alex.body)).not.toContain(TEXTS[1]!);
  });

  it('does not clear or reveal the person\'s unread counts', async () => {
    const w = await browseWorld();
    const before = (await w.edB.get(CH)).body;
    const unread = before.channels.find((c: { id: string }) => c.id === 'general').unread;
    expect(unread).toBeGreaterThan(0);
    const a = await signedIn(w, 'Admin', SECRET);
    const res = await a.get(`${BROWSE}Ed`);
    expect(res.body.channels.find((c: { id: string }) => c.id === 'general')).toMatchObject({ unread: 0, mentions: 0 });
    expect((await w.edB.get(CH)).body.channels.find((c: { id: string }) => c.id === 'general').unread).toBe(unread);
  });

  it('records no Admin read, tells no one in the person\'s group, and writes chat_admin_browse with who and whose', async () => {
    const w = await browseWorld();
    const a = await signedIn(w, 'Admin', SECRET);
    await a.get(`${BROWSE}Ed`);
    await a.get(`${BROWSE}Ed`);
    await settle();
    expect(await w.fleet.chat.core.store.adminReads.list('group:ed')).toEqual([]);
    expect((await w.edB.get(CH)).body.channels.find((c: { id: string }) => c.id === 'group').adminReading).toEqual([]);
    const rows = (await logRows(w)).filter((r) => r.kind === 'chat_admin_browse');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('Admin secret');
    expect(rows[0]!.detail).toContain('Ed');
    for (const t of TEXTS) expect(JSON.stringify(rows)).not.toContain(t);
    expect(await logKinds(w)).not.toContain('chat_admin_read');
  });

  it('names an Admin who is a signed-in person by their own name in the log', async () => {
    const w = await browseWorld();
    const admins = (await w.people.allGroups()).find((g) => g.name === 'Administrators')!;
    const root = await w.people.createPerson('Root', admins.id);
    const rootB = await signedIn(w, 'Root', root.token);
    await rootB.get(`${BROWSE}Ed`);
    await settle();
    expect((await logRows(w)).find((r) => r.kind === 'chat_admin_browse')!.actor).toBe('Root');
  });

  it('refuses everyone who is not an Admin, answers a missing person in words, and treats the Admin themself as the normal overview', async () => {
    const w = await browseWorld();
    const denied = await w.alexB.get(`${BROWSE}Ed`);
    expect(denied.status).toBe(403);
    expect((await w.edB.get(`${BROWSE}Ed`)).status).toBe(403);
    expect(allText(denied.body)).not.toContain('ed group secret');
    const a = await signedIn(w, 'Admin', SECRET);
    const none = await a.get(`${BROWSE}Nobody`);
    expect(none.status).toBe(404);
    expect(none.body.error).toBe('There is no person named Nobody.');
    expect((await a.get(`${BROWSE}`)).status).toBe(400);
    const admins = (await w.people.allGroups()).find((g) => g.name === 'Administrators')!;
    const root = await w.people.createPerson('Root', admins.id);
    const rootB = await signedIn(w, 'Root', root.token);
    const own = await rootB.get(`${BROWSE}root`);
    expect(own.body).toEqual((await rootB.get(CH)).body);
    await settle();
    expect(await logKinds(w)).not.toContain('chat_admin_browse');
    expect((await request(w.app).get(`${BROWSE}Ed`)).status).toBe(403);
  });

  it('never shows a third person\'s Direct Messages in Ed\'s overview', async () => {
    const w = await browseWorld();
    const ALEX_PRIVATE = 'alex private note';
    const sent = await w.alexB.post(`${CH}/dm/me/sess-alex/messages`).set(H).send({ text: ALEX_PRIVATE });
    expect(sent.status).toBeLessThan(300);
    const a = await signedIn(w, 'Admin', SECRET);
    expect((await a.get(`${BROWSE}Alex`)).body.directs.length).toBe(1);
    const ed = await a.get(`${BROWSE}Ed`);
    expect(ed.body.directs.some((d: { owner: string }) => d.owner === 'Alex')).toBe(false);
    expect(ed.body.directs.every((d: { owner: string; a: { sessionId: string }; b: { sessionId: string } }) => d.owner === 'Ed' || d.a.sessionId === 'person:ed' || d.b.sessionId === 'person:ed')).toBe(true);
    expect(allText(ed.body)).not.toContain(ALEX_PRIVATE);
  });
});

describe("an agent answering its own owner's Chat message (#1034)", () => {
  const TT = `${CH}/dm/me/sess-tester/messages`;
  const ASK = 'what is the state of the build?';
  const ANSWER = 'The build is green.';
  const reply = (w: W, text: string, to = 'person:ed', session = 'sess-tester', token = w.ed.token) => request(w.app).post(`/api/fleet/sessions/${session}/peers/messages`).set('X-Podium-Token', token).send({ to, text });
  const asked = async (w: W) => {
    expect((await w.edB.post(TT).set(H).send({ text: ASK })).status).toBe(202);
    await w.fleet.flush();
  };
  const dmCounts = async (b: ReturnType<typeof request.agent>) => ((await b.get(CH)).body.directs as { thread: string; unread: number; mentions: number }[]).map((d) => ({ thread: d.thread, unread: d.unread, mentions: d.mentions }));

  it('stores the answer in the same conversation as delivered, read by the owner and an Admin, with the content-free chat event', async () => {
    const w = await world();
    await asked(w);
    const sse: string[] = [];
    w.fleet.hub.add({ write: (c: string) => sse.push(c) });
    const before = await dmCounts(w.edB);
    const sent = await reply(w, ANSWER);
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    expect(sent.body).toMatchObject({ ok: true, person: true, to: { name: 'Ed' } });
    await w.fleet.flush();
    await settle();
    for (const b of [w.edB, await signedIn(w, 'Admin', SECRET)]) {
      const t = await b.get(TT.replace('/dm/me/', '/dm/person:ed/'));
      expect(t.status).toBe(200);
      expect(t.body.messages.map((m: { author: string; text: string }) => [m.author, m.text])).toEqual([['person', ASK], ['agent', ANSWER]]);
      expect(t.body.messages[1]).toMatchObject({ from: { kind: 'agent', sessionId: 'sess-tester' }, to: [{ sessionId: 'person:ed', state: 'delivered' }] });
    }
    const after = await dmCounts(w.edB);
    expect(after[0]!.unread).toBe(before[0]!.unread + 1);
    expect(after[0]!.mentions).toBe(before[0]!.mentions + 1);
    expect(sse.join('')).not.toContain(ANSWER);
    expect(sse.join('')).toContain('event: chat');
    // Nothing to approve, nothing handed to any reporter: only the person's own text went out, by the console path.
    expect(((await tester(w)).body.peerDeliveries ?? []).map((d: { text: string }) => d.text)).not.toContain(ANSWER);
    expect(JSON.stringify(await logRows(w))).not.toContain(ANSWER);
  });

  it("marks the delivery of the owner's own Chat message so the reporter adds where to answer, and no other console message", async () => {
    const w = await world();
    await w.edB.post(TT).set(H).send({ text: ASK });
    expect(await deliveriesFor(w, 'tester')).toEqual([expect.objectContaining({ kind: 'message', text: ASK, chat: true })]);
    const w2 = await world();
    // The wall's own message box is not the Chat thread: no hint, because an answer there would find no message to answer.
    expect((await w2.edB.post('/api/fleet/respond/sessions/sess-tester/messages').set(H).send({ text: 'from the wall' })).status).toBe(202);
    expect(await deliveriesFor(w2, 'tester')).toEqual([expect.not.objectContaining({ chat: true })]);
  });

  it('never returns the answer from a channel, to another person, or from the agent routes', async () => {
    const w = await world();
    await asked(w);
    await reply(w, ANSWER);
    for (const b of [w.edB, w.alexB]) {
      for (const path of ['/channels/general/messages', '/channels/group/messages']) expect(JSON.stringify((await b.get(`${CH}${path}`)).body)).not.toContain(ANSWER);
      expect(JSON.stringify((await b.get('/api/fleet/respond/peers/conversations')).body ?? '')).not.toContain(ANSWER);
    }
    expect((await w.alexB.get(`${CH}/dm/person:ed/sess-tester/messages`)).status).toBe(403);
  });

  it('refuses an answer from an agent the owner never wrote to, to another person, and after the conversation is removed, in the generic words', async () => {
    const w = await world();
    await dev(w, { status: 'running', waitReason: null });
    const none = await reply(w, ANSWER);
    expect(none.status).toBe(404);
    expect(none.body.error).toBe('You cannot see an orchestrator called person:ed. Run podium_peers for the list.');
    await asked(w);
    // The owner wrote to Tester only: another agent of theirs holds no such message.
    expect((await reply(w, ANSWER, 'person:ed', 'sess-dev')).status).toBe(404);
    expect((await reply(w, ANSWER, 'person:alex')).status).toBe(404);
    expect((await reply(w, ' ')).status).toBe(400);
    expect((await reply(w, ANSWER)).status).toBe(202);
    expect((await w.edB.delete(`${CH}/dm/person:ed/sess-tester`).set(H)).body).toMatchObject({ ok: true });
    expect((await reply(w, 'late')).status).toBe(404);
  });

  it('limits how fast an agent can answer, and lists the owner for podium_peers only once the owner wrote', async () => {
    const w = await world();
    const peers = () => request(w.app).get('/api/fleet/sessions/sess-tester/peers').set('X-Podium-Token', w.ed.token);
    expect((await peers()).body.people).toEqual([]);
    await asked(w);
    expect((await peers()).body.people).toEqual([{ address: 'person:ed', name: 'Ed', paused: false }]);
    let limited = 0;
    for (let i = 0; i < 40; i++) if ((await reply(w, `flood ${i}`)).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});
