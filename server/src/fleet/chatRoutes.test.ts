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

  it('does not deliver a mention of another person\'s agent, and says why; the agent hears nothing', async () => {
    const s = await world();
    const res = await say(s.edB, 'general', '@review@alex-box can you check');
    expect(res.status).toBe(201);
    expect(res.body.message.mentions[0]).toMatchObject({ sessionId: 'sess-alex', state: 'not-delivered' });
    expect(res.body.message.mentions[0].why).toMatch(/another person's agent/);
    const alexReply = await alexOne(s);
    expect(alexReply.body.deliveries ?? []).toEqual([]);
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

  it('refuses a send to another person\'s agent', async () => {
    const s = await world();
    expect((await s.edB.post(`${CH}/dm/me/sess-alex/messages`).set(H).send({ text: 'hi' })).status).toBe(404);
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
  it('sends a chat event with counts and no text when a message changes what a person has unread', async () => {
    const s = await world();
    const sse: string[] = [];
    s.fleet.hub.add({ write: (c: string) => sse.push(c) });
    await say(s.alexB, 'general', 'SECRET-STREAM-TEXT for @Ed@console');
    await s.fleet.flush();
    const chats = sse.join('').split('\n\n').filter((c) => c.includes('event: chat'));
    expect(chats.length).toBeGreaterThan(0);
    const data = JSON.parse(chats.at(-1)!.split('data: ')[1]!);
    expect(data).toMatchObject({ scope: 'public', rev: expect.any(Number) });
    expect(sse.join('')).not.toContain('SECRET-STREAM-TEXT');
    const edCounts = chats.map((c) => JSON.parse(c.split('data: ')[1]!)).find((d) => d.owner === 'ed');
    expect(edCounts).toMatchObject({ unread: 1, mentions: 1 });
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
