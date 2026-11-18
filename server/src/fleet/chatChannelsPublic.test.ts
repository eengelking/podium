// Public channels in Chat's server (#1035): opening, describing and removing one, posting and reading in one as a person and as an agent (the agent's read pages
// through the whole history, 30,000 characters a call), the Admin who edits or removes a channel telling its opener, the privacy rule (a group's or a Direct
// Message's text is never reachable through a public channel route), and the picker for a new Direct Message. The rest of Chat is `chatRoutes.test.ts`.
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

const SECRET = 'admin-secret-for-the-public-channel-tests';
const H = { 'X-Podium-Respond': '1' };
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
  return { app, fleet, storage, people, ed, alex, lines, tick: (ms: number) => (clock += ms), now };
}
type S = Awaited<ReturnType<typeof setup>>;

const ACCEPTS = ['message', 'command', 'question', 'plan-approve', 'plan-feedback', 'permission'] as const;
const MAC = { name: 'ed-mbp', id: 'macmacmac001' };
const LINUX = { name: 'ci-runner-01', id: 'lnxlnxlnx001' };
const BOX = { name: 'alex-box', id: 'alxalxalx001' };

function report(userName: string, sid: string, name: string, machine: { name: string; id: string }, over: Partial<Report['session']> = {}): Report {
  const r = fixtureReport();
  r.session = { ...r.session, id: sid, name, status: 'waiting', waitReason: 'input', peers: true, respond: { level: 'everything', accepts: [...ACCEPTS], limits: [] }, ...over };
  r.userName = userName;
  r.machine = { ...machine, os: 'macOS 27.0.1' };
  r.adminNotices = true;
  return r;
}
const post = (s: S, token: string, r: Report) => request(s.app).post('/api/fleet/report').set('X-Podium-Token', token).send(r);
const dev = (s: S, over: Partial<Report['session']> = {}) => post(s, s.ed.token, report('Ed', 'sess-dev', 'dev', MAC, over));
const tester = (s: S, over: Partial<Report['session']> = {}) => post(s, s.ed.token, report('Ed', 'sess-tester', 'Tester', LINUX, over));
const alexOne = (s: S, over: Partial<Report['session']> = {}) => post(s, s.alex.token, report('Alex', 'sess-alex', 'review', BOX, over));

type B = ReturnType<typeof request.agent>;
async function signedIn(s: S, name: string, token: string): Promise<B> {
  const agent = request.agent(s.app);
  expect((await agent.post('/api/fleet/respond/sign-in').set(H).send({ name, token })).status).toBe(200);
  return agent;
}

/** Ed's two orchestrators and Alex's, all reporting, with Ed and Alex signed in, and Root, an Administrator, who is not the admin secret. */
async function world() {
  const s = await setup();
  expect((await dev(s, { status: 'running', waitReason: null })).status).toBe(200);
  expect((await tester(s)).status).toBe(200);
  expect((await alexOne(s)).status).toBe(200);
  const edB = await signedIn(s, 'Ed', s.ed.token);
  const alexB = await signedIn(s, 'Alex', s.alex.token);
  const admins = (await s.people.allGroups()).find((g) => g.name === 'Administrators')!;
  const rootB = await signedIn(s, 'Root', (await s.people.createPerson('Root', admins.id)).token);
  const secretB = await signedIn(s, 'Admin', SECRET);
  return { ...s, edB, alexB, rootB, secretB };
}
type W = Awaited<ReturnType<typeof world>>;

const open = (b: B, body: Record<string, unknown>) => b.post(`${CH}/channels`).set(H).send(body);
const describe_ = (b: B, channel: string, body: Record<string, unknown>) => b.patch(`${CH}/channels/${encodeURIComponent(channel)}`).set(H).send(body);
const remove = (b: B, channel: string) => b.delete(`${CH}/channels/${encodeURIComponent(channel)}`).set(H).send({});
const say = (b: B, channel: string, text: string, extra: Record<string, unknown> = {}) => b.post(`${CH}/channels/${encodeURIComponent(channel)}/messages`).set(H).send({ text, ...extra });
const read = (b: B, channel: string, q = '') => b.get(`${CH}/channels/${encodeURIComponent(channel)}/messages${q}`);
const texts = (res: { body: { messages: { text: string }[] } }) => res.body.messages.map((m) => m.text);
const settle = () => new Promise((r) => setTimeout(r, 20));
const logKinds = async (s: S) => (await s.people.listLog({ page: 1, pageSize: 200 })).rows.map((r) => r.kind);
const noticesOf = async (w: W, who: 'dev' | 'tester' | 'alex') => {
  const r = who === 'dev' ? await dev(w, { status: 'running', waitReason: null }) : who === 'tester' ? await tester(w) : await alexOne(w);
  return ((r.body.adminNotices ?? []) as { text: string }[]).map((n) => n.text);
};
const agentPost = (s: S, sid: string, channel: string, body: Record<string, unknown>, token?: string) =>
  request(s.app).post(`/api/fleet/sessions/${sid}/chat/channels/${encodeURIComponent(channel)}/messages`).set('X-Podium-Token', token ?? s.ed.token).send(body);
const agentRead = (s: S, sid: string, channel: string, q = '', token?: string) =>
  request(s.app).get(`/api/fleet/sessions/${sid}/chat/channels/${encodeURIComponent(channel)}/messages${q}`).set('X-Podium-Token', token ?? s.ed.token);

describe('opening a public channel', () => {
  it('opens a channel for a person, folds its name and answers the entry the overview lists', async () => {
    const w = await world();
    const res = await open(w.edB, { name: 'Issue-1035', description: 'Everything about the channels issue.', link: { kind: 'issue', ref: ' #1035 ' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      channel: {
        id: 'issue-1035', name: 'issue-1035', kind: 'public', thread: 'public:issue-1035', description: 'Everything about the channels issue.', link: { kind: 'issue', ref: '#1035' }, openedBy: 'Ed',
        unread: 0, mentions: 0, messages: 0, paused: false, pausedByAdmin: null, pausedForEveryone: false, disconnected: false,
        can: { pause: true, pauseEveryone: false, disconnect: true, removeAll: false, editDescription: true, removeChannel: false },
      },
    });
    const ed = await w.edB.get(CH);
    expect(ed.body.channels.map((c: { id: string }) => c.id)).toEqual(['general', 'issue-1035', 'group']);
    expect(ed.body.channels[0]).toMatchObject({ id: 'general', kind: 'public', description: '', link: null, openedBy: null, can: { editDescription: false, removeChannel: false } });
    expect(ed.body.channels[2]).toMatchObject({ id: 'group', kind: 'group', can: { editDescription: false, removeChannel: false } });
    const alex = await w.alexB.get(CH);
    expect(alex.body.channels.find((c: { id: string }) => c.id === 'issue-1035')).toMatchObject({ openedBy: 'Ed', can: { pause: true, editDescription: false, removeChannel: false } });
    const root = await w.rootB.get(CH);
    expect(root.body.channels.find((c: { id: string }) => c.id === 'issue-1035').can).toMatchObject({ pauseEveryone: true, removeAll: true, editDescription: true, removeChannel: true });
    const secret = await w.secretB.get(CH);
    expect(secret.body.channels.map((c: { id: string }) => c.id)).toEqual(['general', 'issue-1035']);
    expect(secret.body.channels[1].can).toMatchObject({ pause: false, editDescription: true, removeChannel: true });
    await settle();
    expect(await logKinds(w)).toContain('channel_opened');
  });

  it('lists the channels by name between General and My group, and lets the admin secret open one', async () => {
    const w = await world();
    for (const name of ['zeta', 'alpha', 'milestone-v1-7']) expect((await open(name === 'zeta' ? w.alexB : w.edB, { name })).status).toBe(201);
    const made = await open(w.secretB, { name: 'ops', description: 'Opened with the admin secret.' });
    expect(made.status).toBe(201);
    expect(made.body.channel).toMatchObject({ openedBy: 'Admin', can: { editDescription: true, removeChannel: true } });
    expect((await w.edB.get(CH)).body.channels.map((c: { id: string }) => c.id)).toEqual(['general', 'alpha', 'milestone-v1-7', 'ops', 'zeta', 'group']);
  });

  it('is refused while messaging is off and without a sign-in', async () => {
    const off = await setup({ flag: false });
    await dev(off);
    expect((await request(off.app).post(`${CH}/channels`).set(H).send({ name: 'x' })).status).toBe(403);
    const w = await world();
    expect((await request(w.app).post(`${CH}/channels`).set(H).send({ name: 'x' })).status).toBe(403);
    expect((await request(w.app).patch(`${CH}/channels/x`).set(H).send({ description: 'x' })).status).toBe(403);
    expect((await request(w.app).delete(`${CH}/channels/x`).set(H).send({})).status).toBe(403);
  });

  it('refuses a name that is not valid, reserved, taken or linked, with the reason for the form', async () => {
    const w = await world();
    expect((await open(w.edB, { name: 'staging', link: { kind: 'issue', ref: '#12' } })).status).toBe(201);
    const bad = async (body: Record<string, unknown>, status: number, reason: string, words: RegExp) => {
      const r = await open(w.alexB, body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(r.body, JSON.stringify(body)).toMatchObject({ ok: false, reason });
      expect(r.body.error).toMatch(words);
    };
    await bad({ name: 'has space' }, 422, 'invalid', /lowercase letters, digits or hyphens/);
    await bad({ name: '-leading' }, 422, 'invalid', /starts with a letter or digit/);
    await bad({ name: 'x'.repeat(41) }, 422, 'invalid', /1 to 40/);
    await bad({ name: '' }, 422, 'invalid', /1 to 40/);
    await bad({ name: 'general' }, 422, 'reserved', /reserved/);
    await bad({ name: 'GROUP' }, 422, 'reserved', /reserved/);
    await bad({ name: 'STAGING' }, 409, 'name-taken', /There is already a channel called staging\. Open it, or pick another name\./);
    await bad({ name: 'other', link: { kind: 'issue', ref: '#12' } }, 409, 'link-taken', /There is already a channel for issue #12: staging\. Open it instead\./);
    await bad({ name: 'other', link: { kind: 'planet', ref: '#12' } }, 422, 'invalid', /issue, milestone or project/);
    await bad({ name: 'other', link: { kind: 'issue', ref: '   ' } }, 422, 'invalid', /issue, milestone or project/);
    await bad({ name: 'other', description: 'd'.repeat(281) }, 422, 'invalid', /280/);
    expect((await open(w.alexB, { name: 'other', link: { kind: 'milestone', ref: '#12' } })).status).toBe(201);
    const types = async (body: unknown) => expect((await open(w.alexB, body as Record<string, unknown>)).status, JSON.stringify(body)).toBe(400);
    await types({});
    await types({ name: 12 });
    await types({ name: 'typed', description: 12 });
    await types({ name: 'typed', link: 'issue #1' });
    await types({ name: 'typed', link: { kind: 12, ref: 'x' } });
    expect((await w.edB.get(CH)).body.channels.map((c: { id: string }) => c.id)).toEqual(['general', 'other', 'staging', 'group']);
  });

  it('keeps at most 50 channels besides General, answering the 51st with the limit and the way out', async () => {
    const w = await world();
    for (let i = 0; i < 50; i++) expect((await open(w.edB, { name: `c${i}` })).status, `c${i}`).toBe(201);
    const over = await open(w.alexB, { name: 'one-too-many' });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ ok: false, reason: 'limit-reached', error: 'This server has 50 channels, the most it keeps. An Admin can remove one that is no longer used.' });
    expect((await remove(w.rootB, 'c7')).status).toBe(200);
    expect((await open(w.alexB, { name: 'one-too-many' })).status).toBe(201);
  });

  it('cleans and redacts the description and the link', async () => {
    const w = await world();
    const r = await open(w.edB, { name: 'secrets', description: 'key sk-abcdefghijklmnopqrstuvwxyz123456 here‮', link: { kind: 'project', ref: 'podium' } });
    expect(r.status).toBe(201);
    expect(r.body.channel.description).toContain('[redacted]');
    expect(r.body.channel.description).not.toContain('sk-abcdef');
    expect(r.body.channel.description).not.toContain('‮');
  });
});

describe('describing and removing a public channel', () => {
  it('lets the opener and an Admin edit the description, and no one else', async () => {
    const w = await world();
    await open(w.edB, { name: 'topic', description: 'first', link: { kind: 'issue', ref: '#1' } });
    expect((await describe_(w.alexB, 'topic', { description: 'hijacked' })).status).toBe(403);
    const mine = await describe_(w.edB, 'topic', { description: 'by the opener' });
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ ok: true, channel: { id: 'topic', description: 'by the opener', link: { kind: 'issue', ref: '#1' }, openedBy: 'Ed' } });
    expect((await describe_(w.rootB, 'topic', { description: 'by an Administrator' })).body.channel.description).toBe('by an Administrator');
    expect((await describe_(w.secretB, 'topic', { description: 'by the secret' })).status).toBe(200);
    expect((await describe_(w.edB, 'topic', { description: '' })).body.channel.description).toBe('');
    expect((await describe_(w.edB, 'topic', { description: 'd'.repeat(281) })).status).toBe(422);
    expect((await describe_(w.edB, 'topic', {})).status).toBe(400);
    expect((await describe_(w.edB, 'topic', { description: 12 })).status).toBe(400);
    expect((await describe_(w.edB, 'topic', { description: 'sk-abcdefghijklmnopqrstuvwxyz123456' })).body.channel.description).toBe('[redacted]');
    expect((await describe_(w.edB, 'nowhere', { description: 'x' })).status).toBe(404);
    expect((await describe_(w.edB, 'general', { description: 'x' })).status).toBe(403);
    expect((await describe_(w.edB, 'group', { description: 'x' })).status).toBe(403);
    await settle();
    expect(await logKinds(w)).toContain('channel_edited');
  });

  it('lets only an Admin remove a channel, with its messages, flags and counts', async () => {
    const w = await world();
    await open(w.edB, { name: 'gone-soon' });
    await say(w.alexB, 'gone-soon', 'first');
    await say(w.alexB, 'gone-soon', 'second');
    expect((await w.edB.put(`${CH}/channels/gone-soon/pause`).set(H).send({ paused: true })).status).toBe(200);
    expect((await w.edB.put(`${CH}/channels/gone-soon/disconnect`).set(H).send({ disconnected: true })).status).toBe(200);
    expect((await w.rootB.put(`${CH}/channels/gone-soon/pause`).set(H).send({ paused: true, everyone: true })).status).toBe(200);
    expect((await w.edB.get(CH)).body.channels.find((c: { id: string }) => c.id === 'gone-soon')).toMatchObject({ unread: 2, messages: 2, paused: true, disconnected: true });
    expect((await remove(w.alexB, 'gone-soon')).status).toBe(403);
    expect((await remove(w.edB, 'gone-soon')).status).toBe(403);
    const flags = () => w.fleet.chat.core.store.settings.allFlags();
    expect(Object.keys(await flags()).filter((k) => k.includes('gone-soon')).length).toBeGreaterThan(0);
    const gone = await remove(w.rootB, 'gone-soon');
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({ ok: true, removed: 2 });
    expect((await read(w.edB, 'gone-soon')).status).toBe(404);
    expect((await say(w.edB, 'gone-soon', 'late')).status).toBe(404);
    expect((await remove(w.rootB, 'gone-soon')).status).toBe(404);
    expect((await w.edB.get(CH)).body.channels.map((c: { id: string }) => c.id)).toEqual(['general', 'group']);
    // Nothing is left behind: not the flags, not the counts, not a record.
    expect(Object.keys(await flags()).filter((k) => k.includes('gone-soon'))).toEqual([]);
    expect(await w.fleet.chat.core.store.readState.threads('public:')).toEqual([]);
    expect(await w.fleet.chat.core.store.channels.count()).toBe(0);
    // The name can be opened again, empty and with no flags.
    const again = await open(w.alexB, { name: 'gone-soon' });
    expect(again.status).toBe(201);
    expect(again.body.channel).toMatchObject({ messages: 0, paused: false, disconnected: false, openedBy: 'Alex' });
    expect(texts(await read(w.edB, 'gone-soon'))).toEqual([]);
    expect((await remove(w.rootB, 'general')).status).toBe(403);
    expect((await remove(w.rootB, 'group')).status).toBe(403);
    await settle();
    expect(await logKinds(w)).toContain('channel_removed');
  });

  it('tells the opener, in every live session of theirs and no one else\'s, when an Admin edits or removes their channel', async () => {
    const w = await world();
    await open(w.edB, { name: 'mine' });
    // The opener editing their own channel, or an Admin editing their own, tells no one.
    await describe_(w.edB, 'mine', { description: 'own edit' });
    expect(await noticesOf(w, 'dev')).toEqual([]);
    await describe_(w.rootB, 'mine', { description: 'an Admin edits it' });
    expect(await noticesOf(w, 'dev')).toEqual(['Root (an Admin) edited the description of the channel mine you opened.']);
    expect(await noticesOf(w, 'tester')).toEqual(['Root (an Admin) edited the description of the channel mine you opened.']);
    expect(await noticesOf(w, 'alex')).toEqual([]);
    await describe_(w.secretB, 'mine', { description: 'the secret edits it' });
    expect((await noticesOf(w, 'dev')).at(-1)).toBe('Admin secret (an Admin) edited the description of the channel mine you opened.');
    expect((await remove(w.rootB, 'mine')).status).toBe(200);
    expect((await noticesOf(w, 'dev')).at(-1)).toBe('Root (an Admin) removed the channel mine you opened.');
    expect((await noticesOf(w, 'tester')).at(-1)).toBe('Root (an Admin) removed the channel mine you opened.');
    expect(await noticesOf(w, 'alex')).toEqual([]);
    // An Admin who opened the channel and removes it tells no one; a channel opened by the admin secret has no person to tell.
    await open(w.rootB, { name: 'roots' });
    await remove(w.rootB, 'roots');
    await open(w.secretB, { name: 'secrets' });
    await remove(w.rootB, 'secrets');
    w.tick(6 * 60_000);
    for (const who of ['dev', 'tester', 'alex'] as const) expect(await noticesOf(w, who), who).toEqual([]);
  });

  it('tells every session of everyone when an Admin pauses or empties a public channel for all, as for General, and the opener of the removal count', async () => {
    const w = await world();
    await open(w.edB, { name: 'busy' });
    await say(w.alexB, 'busy', 'one');
    await say(w.alexB, 'busy', 'two');
    expect((await w.rootB.put(`${CH}/channels/busy/pause`).set(H).send({ paused: true, everyone: true })).body).toMatchObject({ paused: true, pausedForEveryone: true, pausedByAdmin: 'Root' });
    for (const who of ['dev', 'alex'] as const) expect(await noticesOf(w, who), who).toEqual(['Root (an Admin) paused busy for everyone.']);
    expect((await w.edB.put(`${CH}/channels/busy/pause`).set(H).send({ paused: false })).body).toMatchObject({ paused: true, pausedByAdmin: 'Root' });
    expect((await w.rootB.put(`${CH}/channels/busy/pause`).set(H).send({ paused: false, everyone: true })).body).toMatchObject({ paused: false });
    expect((await w.edB.delete(`${CH}/channels/busy/messages`).set(H).send({})).status).toBe(403);
    const cleared = await w.rootB.delete(`${CH}/channels/busy/messages`).set(H).send({});
    expect(cleared.body).toEqual({ ok: true, removed: 2 });
    expect((await noticesOf(w, 'dev')).at(-1)).toBe('Root (an Admin) removed all messages in busy.');
    expect((await remove(w.rootB, 'busy')).status).toBe(200);
    expect((await noticesOf(w, 'dev')).at(-1)).toBe('Root (an Admin) removed the channel busy you opened.');
  });

  it('records no Admin read when an Admin reads a public channel, tells no one, and says so in the reads it answers', async () => {
    const w = await world();
    await open(w.edB, { name: 'open-air' });
    await say(w.edB, 'open-air', 'PUBLIC-LINE for everyone');
    const res = await read(w.rootB, 'open-air');
    expect(texts(res)).toEqual(['PUBLIC-LINE for everyone']);
    expect(res.body.adminReads).toEqual([]);
    expect(texts(await read(w.secretB, 'open-air'))).toEqual(['PUBLIC-LINE for everyone']);
    expect((await w.rootB.post(`${CH}/channels/open-air/reading`).set(H).send({})).status).toBe(400);
    expect(await w.fleet.chat.adminReads.list('public:open-air')).toEqual([]);
    expect(await w.fleet.chat.adminReads.unseenFor('ed')).toEqual([]);
    for (const who of ['dev', 'tester', 'alex'] as const) expect(await noticesOf(w, who), who).toEqual([]);
    await settle();
    expect(await logKinds(w)).not.toContain('chat_admin_read');
  });
});

describe('posting and reading in a public channel', () => {
  it('shows a person\'s post and an agent\'s post to every signed-in person, the agent with its owner', async () => {
    const w = await world();
    await open(w.edB, { name: 'shared' });
    const sent = await say(w.alexB, 'shared', 'from Alex');
    expect(sent.status).toBe(201);
    expect(sent.body.message).toMatchObject({ authorKind: 'person', authorName: 'Alex', mine: true, authorOwner: null });
    const agent = await agentPost(w, 'sess-dev', 'shared', { text: 'from the dev agent' });
    expect(agent.status).toBe(201);
    expect(agent.body).toMatchObject({ ok: true, id: expect.any(String), createdAt: expect.any(Number) });
    for (const b of [w.edB, w.alexB, w.rootB, w.secretB]) {
      const r = await read(b, 'shared');
      expect(texts(r)).toEqual(['from Alex', 'from the dev agent']);
      expect(r.body.messages[1]).toMatchObject({ authorKind: 'orchestrator', authorName: 'dev', authorOwner: 'Ed', mine: false });
      expect(r.body).toMatchObject({ ok: true, channel: 'shared', total: 2, older: null });
    }
    // General and My group are untouched.
    expect(texts(await read(w.edB, 'general'))).toEqual([]);
    expect(texts(await read(w.edB, 'group'))).toEqual([]);
    expect(await w.fleet.chat.core.store.public.count('general')).toBe(0);
    expect(await w.fleet.chat.core.store.public.count('shared')).toBe(2);
    await settle();
    const kinds = await logKinds(w);
    expect(kinds.filter((k) => k === 'channel_sent')).toHaveLength(2);
  });

  it('redacts a person\'s text and an agent\'s text, and counts unread and mentions per channel', async () => {
    const w = await world();
    await open(w.edB, { name: 'counts' });
    await open(w.edB, { name: 'other' });
    expect((await say(w.alexB, 'counts', 'use sk-abcdefghijklmnopqrstuvwxyz123456 now')).body.message.text).toContain('[redacted]');
    const agent = await agentPost(w, 'sess-alex', 'counts', { text: 'agent token=hunter2hunter2 here', replyTo: undefined }, w.alex.token);
    expect(agent.status).toBe(201);
    expect(JSON.stringify((await read(w.edB, 'counts')).body)).not.toMatch(/hunter2|sk-abcdef/);
    const overview = async () => (await w.edB.get(CH)).body.channels as { id: string; unread: number; mentions: number }[];
    // Both posts count for Ed (a person's own post never counts against them, an agent's does), and only in the channel they were made in.
    expect((await overview()).find((c) => c.id === 'counts')).toMatchObject({ unread: 2, mentions: 0 });
    expect((await overview()).find((c) => c.id === 'other')).toMatchObject({ unread: 0 });
    expect((await w.edB.post(`${CH}/read`).set(H).send({ thread: 'public:counts', upTo: null })).body).toMatchObject({ ok: true, unread: 0 });
    expect((await overview()).find((c) => c.id === 'counts')).toMatchObject({ unread: 0 });
    await say(w.alexB, 'counts', 'hello @Ed@console');
    expect((await overview()).find((c) => c.id === 'counts')).toMatchObject({ unread: 1, mentions: 1 });
    expect((await w.edB.post(`${CH}/read`).set(H).send({ thread: 'public:nowhere', upTo: null })).status).toBe(403);
    expect((await w.edB.post(`${CH}/read`).set(H).send({ thread: 'public:COUNTS', upTo: null })).status).toBe(403);
    expect((await w.edB.post(`${CH}/read`).set(H).send({ thread: 'public:counts', upTo: null })).status).toBe(200);
  });

  it('delivers an @ of the person\'s own agent and asks the owner for another person\'s, with the channel named', async () => {
    const w = await world();
    await open(w.edB, { name: 'calls' });
    const own = await say(w.edB, 'calls', '@Tester@ci-runner-01 please look');
    expect(own.status).toBe(201);
    expect(own.body.message.mentions[0]).toMatchObject({ state: 'waiting' });
    const delivered = ((await tester(w)).body.deliveries ?? []) as { text?: string }[];
    expect(delivered.map((d) => d.text)).toEqual(['From Podium Chat, calls, Ed wrote:\n@Tester@ci-runner-01 please look']);
    const across = await say(w.edB, 'calls', '@review@alex-box and you?');
    expect(across.body.message.mentions[0]).toMatchObject({ state: 'approval', why: 'Waiting for Alex to approve' });
    expect((await w.edB.get(`${CH}/addresses?channel=calls`)).body.addresses.map((a: { typed: string }) => a.typed)).toEqual(expect.arrayContaining(['dev@ed-mbp', 'review@alex-box', 'Alex@console']));
  });

  it('holds and disconnects per channel: one channel\'s pause never touches General or another channel', async () => {
    const w = await world();
    await open(w.edB, { name: 'quiet' });
    await open(w.edB, { name: 'loud' });
    expect((await w.edB.put(`${CH}/channels/quiet/pause`).set(H).send({ paused: true })).body).toMatchObject({ ok: true, paused: true, pausedForEveryone: false });
    const flags = async () => Object.fromEntries(((await w.edB.get(CH)).body.channels as { id: string; paused: boolean; disconnected: boolean }[]).map((c) => [c.id, [c.paused, c.disconnected]]));
    expect(await flags()).toMatchObject({ general: [false, false], quiet: [true, false], loud: [false, false] });
    const held = await say(w.edB, 'quiet', '@Tester@ci-runner-01 later');
    expect(held.body.message.mentions[0]).toMatchObject({ state: 'held', why: 'quiet is paused' });
    expect((await agentPost(w, 'sess-dev', 'quiet', { text: 'agent?' })).status).toBe(409);
    expect((await agentPost(w, 'sess-dev', 'loud', { text: 'agent!' })).status).toBe(201);
    const back = await w.edB.put(`${CH}/channels/quiet/pause`).set(H).send({ paused: false });
    expect(back.body).toMatchObject({ paused: false, delivered: 1 });
    expect(((await tester(w)).body.deliveries ?? []).map((d: { text?: string }) => d.text)).toEqual(['From Podium Chat, quiet, Ed wrote:\n@Tester@ci-runner-01 later']);
    expect((await w.edB.put(`${CH}/channels/loud/disconnect`).set(H).send({ disconnected: true })).body).toMatchObject({ disconnected: true });
    expect(await flags()).toMatchObject({ general: [false, false], quiet: [false, false], loud: [false, true] });
    const refused = await agentPost(w, 'sess-dev', 'loud', { text: 'agent again' });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/loud is disconnected for your agents/);
    expect((await agentRead(w, 'sess-dev', 'loud')).status).toBe(403);
    expect((await agentPost(w, 'sess-dev', 'general', { text: 'not called in' })).status).toBe(403);
  });

  it('tells the console a channel changed, with only a revision and a scope', async () => {
    const w = await world();
    const sse: string[] = [];
    w.fleet.hub.add({ write: (c: string) => sse.push(c) });
    const chats = () => sse.join('').split('\n\n').filter((c) => c.includes('event: chat')).map((c) => JSON.parse(c.split('data: ')[1]!) as Record<string, unknown>);
    await open(w.edB, { name: 'live' });
    await w.fleet.flush();
    const afterOpen = chats().length;
    expect(afterOpen).toBeGreaterThan(0);
    await describe_(w.edB, 'live', { description: 'changed' });
    await say(w.alexB, 'live', 'SECRET-STREAM-LINE');
    await remove(w.rootB, 'live');
    await w.fleet.flush();
    expect(chats().length).toBeGreaterThanOrEqual(afterOpen + 3);
    for (const c of chats()) expect(Object.keys(c).sort()).toEqual(['rev', 'scope']);
    expect(chats().every((c) => c.scope === 'public')).toBe(true);
    expect(sse.join('')).not.toMatch(/SECRET-STREAM-LINE|"live"/);
  });

  it('purges every public channel with the retention days', async () => {
    const w = await world();
    await open(w.edB, { name: 'old' });
    await say(w.edB, 'old', 'ancient');
    s_tick(w, 31 * 86_400_000);
    const ed = await signedIn(w, 'Ed', w.ed.token);
    await say(ed, 'old', 'recent');
    await w.fleet.retain();
    expect(texts(await read(ed, 'old'))).toEqual(['recent']);
    expect((await ed.get(CH)).body.channels.find((c: { id: string }) => c.id === 'old')).toMatchObject({ messages: 1 });
  });
});

const s_tick = (w: { tick: (ms: number) => number }, ms: number) => w.tick(ms);

describe('an agent reads a public channel (#1035)', () => {
  const pageAll = async (w: W, sid: string, channel: string) => {
    const pages: { messages: { text: string }[]; older: string | null; more: boolean }[] = [];
    let before: string | null = null;
    for (let i = 0; i < 30; i++) {
      const r: request.Response = await agentRead(w, sid, channel, before ? `?before=${encodeURIComponent(before)}` : '');
      expect(r.status).toBe(200);
      pages.push(r.body);
      if (!r.body.more) break;
      before = r.body.older;
    }
    return pages;
  };

  it('needs no call into the channel and no hour window, and reads what a person and another agent posted', async () => {
    const w = await world();
    await open(w.edB, { name: 'history' });
    await say(w.alexB, 'history', 'from Alex');
    await agentPost(w, 'sess-alex', 'history', { text: 'from Alex\'s agent' }, w.alex.token);
    w.tick(3 * 3_600_000);
    await say(w.edB, 'history', 'from Ed, three hours later');
    for (const [sid, token] of [['sess-dev', w.ed.token], ['sess-alex', w.alex.token]] as const) {
      const r = await agentRead(w, sid, 'history', '', token);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, channel: 'history', more: false, older: null });
      expect(r.body.messages.map((m: { text: string }) => m.text)).toEqual(['from Alex', "from Alex's agent", 'from Ed, three hours later']);
      expect(r.body.messages[1]).toMatchObject({ authorKind: 'orchestrator', authorName: 'review', authorOwner: 'Alex' });
      expect(Object.keys(r.body.messages[0]).sort()).toEqual(['authorKind', 'authorName', 'authorOwner', 'createdAt', 'id', 'replyTo', 'text']);
    }
  });

  it('pages back by a cursor, about 30,000 characters a call, whole messages only, oldest first, and says when there is more', async () => {
    const w = await world();
    await open(w.edB, { name: 'long' });
    const store = w.fleet.chat.core.store.public;
    const input = (text: string) => ({ authorKind: 'person' as const, authorRef: 'Ed', authorName: 'Ed', text });
    for (let i = 0; i < 70; i++) await store.post('long', input(`m${String(i).padStart(2, '0')} ${'x'.repeat(996)}`));
    const pages = await pageAll(w, 'sess-dev', 'long');
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      expect(p.messages.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(30_000);
      for (const m of p.messages) expect(m.text).toMatch(/^m\d\d x{996}$/);
    }
    expect(pages.at(-1)!.more).toBe(false);
    expect(pages.at(-1)!.older).toBeNull();
    for (const p of pages.slice(0, -1)) expect(p).toMatchObject({ more: true, older: expect.any(String) });
    // Newest page first, each page oldest first, so reading them back to front gives the channel in order, each message once.
    const all = pages.reverse().flatMap((p) => p.messages.map((m) => m.text.slice(0, 3)));
    expect(all).toEqual(Array.from({ length: 70 }, (_, i) => `m${String(i).padStart(2, '0')}`));
    expect((await agentRead(w, 'sess-dev', 'long', '?before=junk')).status).toBe(400);
  });

  it('shortens one message that is longer than a call with a marker, and still pages past it', async () => {
    const w = await world();
    await open(w.edB, { name: 'huge' });
    const store = w.fleet.chat.core.store.public;
    await store.post('huge', { authorKind: 'person', authorRef: 'Ed', authorName: 'Ed', text: 'older line' });
    await store.post('huge', { authorKind: 'person', authorRef: 'Ed', authorName: 'Ed', text: `HEAD${'y'.repeat(60_000)}TAIL` });
    await store.post('huge', { authorKind: 'person', authorRef: 'Ed', authorName: 'Ed', text: 'newest line' });
    const first = await agentRead(w, 'sess-dev', 'huge');
    expect(first.body.messages.map((m: { text: string }) => m.text)).toEqual(['newest line']);
    expect(first.body).toMatchObject({ more: true });
    const second = await agentRead(w, 'sess-dev', 'huge', `?before=${encodeURIComponent(first.body.older)}`);
    expect(second.body.messages).toHaveLength(1);
    const cut: string = second.body.messages[0].text;
    expect(cut.startsWith('HEAD')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(30_000);
    expect(cut).toMatch(/\[cut: this message is 60,008 characters; the first \d[\d,]* are shown\]$/);
    expect(second.body).toMatchObject({ more: true });
    const third = await agentRead(w, 'sess-dev', 'huge', `?before=${encodeURIComponent(second.body.older)}`);
    expect(texts(third)).toEqual(['older line']);
    expect(third.body).toMatchObject({ more: false, older: null });
  });

  it('refuses a public channel\'s agent read to anyone but the person\'s own live agent: the admin secret, another person\'s agent, an ended agent, a browser sign-in and no credential', async () => {
    const w = await world();
    await open(w.edB, { name: 'closed' });
    expect((await agentRead(w, 'sess-dev', 'closed', '', w.alex.token)).status).toBe(403);
    expect((await agentRead(w, 'sess-dev', 'closed', '', SECRET)).status).toBe(403);
    // A non-agent has no way in: a request with no token, and a browser's sign-in cookie (even an Administrator's), are refused and read nothing.
    const bare = await request(w.app).get('/api/fleet/sessions/sess-dev/chat/channels/closed/messages');
    expect([401, 403]).toContain(bare.status);
    for (const b of [w.rootB, w.secretB, w.edB]) {
      const viaCookie = await b.get('/api/fleet/sessions/sess-dev/chat/channels/closed/messages');
      expect([401, 403]).toContain(viaCookie.status);
      expect(viaCookie.body).not.toHaveProperty('messages');
    }
    expect(bare.body).not.toHaveProperty('messages');
    expect((await agentPost(w, 'sess-dev', 'closed', { text: 'x' }, w.alex.token)).status).toBe(403);
    expect((await agentRead(w, 'sess-dev', 'nowhere')).status).toBe(404);
    expect((await agentPost(w, 'sess-dev', 'nowhere', { text: 'x' })).status).toBe(404);
    expect((await agentRead(w, 'sess-unknown', 'closed')).status).toBe(404);
    expect((await dev(w, { status: 'done', waitReason: null, endReason: 'other' })).status).toBe(200);
    w.tick(DEFAULT_CONFIG.lingerMs + 1000);
    await w.fleet.sweep();
    expect((await agentRead(w, 'sess-dev', 'closed')).status).toBe(404);
  });

  it('keeps the posting rules for an agent: empty and long refused, the rate limit applies, and a reply must point at a message of the channel', async () => {
    const w = await world();
    await open(w.edB, { name: 'rules' });
    expect((await agentPost(w, 'sess-dev', 'rules', { text: '  ' })).status).toBe(400);
    expect((await agentPost(w, 'sess-dev', 'rules', { text: 'x'.repeat(4001) })).status).toBe(422);
    const first = await agentPost(w, 'sess-dev', 'rules', { text: 'first' });
    expect((await agentPost(w, 'sess-dev', 'rules', { text: 'a reply', replyTo: first.body.id })).status).toBe(201);
    expect((await agentPost(w, 'sess-dev', 'rules', { text: 'a stray reply', replyTo: 'no-such-message' })).status).toBe(404);
    // The stray reply was counted against the rate before it was refused, so three more make six.
    for (let i = 0; i < 3; i++) expect((await agentPost(w, 'sess-dev', 'rules', { text: `n${i}` })).status).toBe(201);
    const over = await agentPost(w, 'sess-dev', 'rules', { text: 'too many' });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/6 messages a minute/);
    expect(texts(await read(w.alexB, 'rules'))).toEqual(['first', 'a reply', 'n0', 'n1', 'n2']);
  });

  it('leaves General\'s and My group\'s agent read as it was: only what called the agent in, inside the hour', async () => {
    const w = await world();
    await say(w.edB, 'general', 'plain');
    expect((await agentRead(w, 'sess-dev', 'general')).status).toBe(403);
    await say(w.edB, 'general', 'hey @dev@ed-mbp');
    const r = await agentRead(w, 'sess-dev', 'general');
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('more');
    expect(Object.keys(r.body.messages[0]).sort()).toEqual(['authorKind', 'authorName', 'createdAt', 'id', 'replyTo', 'text']);
    w.tick(2 * 3_600_000);
    expect((await agentRead(w, 'sess-dev', 'general')).status).toBe(403);
  });
});

describe('the privacy rule: a private message is never reachable through a public channel (#1035)', () => {
  const PRIVATE = ['ED-GROUP-SECRET', 'ALEX-GROUP-SECRET', 'AGENT-DM-SECRET', 'PERSON-DM-SECRET'];

  /** A world with private text in every private place, and one public channel with its own text. */
  async function seeded() {
    const w = await world();
    await say(w.edB, 'group', 'ED-GROUP-SECRET');
    await say(w.alexB, 'group', 'ALEX-GROUP-SECRET');
    const link = await w.edB.put('/api/fleet/respond/peers/rights').set(H).send({ from: MAC.id, to: LINUX.id, level: 'send' });
    expect(link.status).toBe(200);
    const sent = await request(w.app).post('/api/fleet/sessions/sess-dev/peers/messages').set('X-Podium-Token', w.ed.token).send({ to: 'Tester@ci-runner-01', text: 'AGENT-DM-SECRET' });
    expect(sent.status).toBe(202);
    expect((await w.edB.post(`${CH}/dm/me/sess-dev/messages`).set(H).send({ text: 'PERSON-DM-SECRET' })).status).toBe(202);
    expect((await open(w.edB, { name: 'x', description: 'public text' })).status).toBe(201);
    expect((await say(w.alexB, 'x', 'PUBLIC-X-LINE')).status).toBe(201);
    return w;
  }
  const dmTotal = async (w: W) => ((await w.edB.get(CH)).body.directs as { messages: number }[]).reduce((n, d) => n + d.messages, 0);
  const groupTotal = async (w: W) => (await w.fleet.chat.core.store.group.count({ owner: 'ed', groupId: 'ed' })) + (await w.fleet.chat.core.store.group.count({ owner: 'alex', groupId: 'alex' }));
  const none = (body: unknown) => { for (const p of PRIVATE) expect(JSON.stringify(body)).not.toContain(p); };

  it('returns no private text from any public channel route, for any name that is not a channel, and only the channel\'s own text for the one that is', async () => {
    const w = await seeded();
    // Each name is what a request could carry in the `:channel` slot. `X` is the channel's own name in another case: it is the same public channel.
    const names = ['Group', 'GROUP', 'group ', ' group', 'grou%70', 'group\u0000', 'x ', ' x', 'x\t', 'x%00', 'public', 'public:x', 'dm', 'person:ed', 'sess-dev', 'ed', 'x/../group', '../group', '..', 'x?owner=Ed', 'x#', 'g'.repeat(300), 'x\u0000group', 'x\nx', 'General', 'GENERAL', 'general '];
    for (const name of names) {
      for (const [who, b] of [['ed', w.edB], ['alex', w.alexB], ['root', w.rootB], ['secret', w.secretB]] as const) {
        const url = `${CH}/channels/${encodeURIComponent(name)}/messages`;
        for (const q of ['', '?owner=Ed', '?owner=Alex', '?limit=100']) {
          const r = await b.get(url + q);
          none(r.body);
          expect(r.status, `${who} GET ${name}${q}`).toBe(404);
        }
        const p = await b.post(url).set(H).send({ text: 'must not land', owner: 'Ed' });
        expect(p.status, `${who} POST ${name}`).toBe(404);
        none(p.body);
        for (const op of ['pause', 'disconnect']) expect((await b.put(`${CH}/channels/${encodeURIComponent(name)}/${op}`).set(H).send({ paused: true, disconnected: true, owner: 'Ed' })).status, `${who} PUT ${name} ${op}`).toBe(404);
        expect((await b.delete(url).set(H).send({ owner: 'Ed' })).status, `${who} DELETE ${name}`).toBe(404);
        expect((await b.post(`${CH}/channels/${encodeURIComponent(name)}/reading`).set(H).send({ owner: 'Ed' })).status, `${who} reading ${name}`).toBe(404);
      }
      for (const [sid, token] of [['sess-dev', w.ed.token], ['sess-alex', w.alex.token]] as const) {
        const r = await agentRead(w, sid, name, '', token);
        expect(r.status, `agent read ${name}`).toBe(404);
        none(r.body);
        expect((await agentPost(w, sid, name, { text: 'must not land' }, token)).status, `agent post ${name}`).toBe(404);
      }
      expect((await w.edB.patch(`${CH}/channels/${encodeURIComponent(name)}`).set(H).send({ description: 'no' })).status).toBeGreaterThanOrEqual(403);
      expect((await w.rootB.delete(`${CH}/channels/${encodeURIComponent(name)}`).set(H).send({})).status, `remove ${name}`).toBeGreaterThanOrEqual(403);
    }
    // The one real channel, by its own name or the same name in another case, holds only its own text.
    for (const name of ['x', 'X']) {
      for (const b of [w.edB, w.alexB, w.rootB, w.secretB]) {
        const r = await read(b, name, '?owner=Ed');
        expect(r.status).toBe(200);
        expect(texts(r)).toEqual(['PUBLIC-X-LINE']);
        none(r.body);
      }
      for (const [sid, token] of [['sess-dev', w.ed.token], ['sess-alex', w.alex.token]] as const) {
        const r = await agentRead(w, sid, name, '', token);
        expect(texts(r)).toEqual(['PUBLIC-X-LINE']);
        none(r.body);
      }
    }
    // `group` itself is My group's own route, not a public channel's: it answers the viewer's own group and no one else's, and a public channel's cursor or owner changes nothing.
    expect(texts(await read(w.alexB, 'group'))).toEqual(['ALEX-GROUP-SECRET']);
    expect((await read(w.alexB, 'group', '?owner=Ed')).status).toBe(403);
    expect((await w.fleet.chat.core.store.public.count('group'))).toBe(0);
    expect((await w.edB.get(`${CH}/addresses?channel=x`)).status).toBe(200);
    none((await w.alexB.get(CH)).body);
    expect((await w.fleet.chat.core.store.public.count('general'))).toBe(0);
    expect(texts(await read(w.edB, 'group'))).toEqual(['ED-GROUP-SECRET']);
    expect(texts(await read(w.alexB, 'group'))).toEqual(['ALEX-GROUP-SECRET']);
  });

  it('never writes a public channel\'s post to a group or a conversation, and never reads a reply target from one', async () => {
    const w = await seeded();
    const groups = await groupTotal(w);
    const dms = await dmTotal(w);
    const ownGroup = (await read(w.edB, 'group')).body.messages[0].id as string;
    expect((await say(w.edB, 'x', 'a person posts and calls @dev@ed-mbp')).status).toBe(201);
    expect((await agentPost(w, 'sess-dev', 'x', { text: 'an agent posts' })).status).toBe(201);
    expect(await groupTotal(w)).toBe(groups);
    expect(await dmTotal(w)).toBe(dms);
    // An @ of another person's agent is the one thing that reaches a conversation: the request for its owner's approval is stored as a conversation row (the
    // existing flow), holding the person's own public text, and nothing of any private place goes the other way.
    expect((await say(w.edB, 'x', 'and @review@alex-box too')).status).toBe(201);
    expect(await groupTotal(w)).toBe(groups);
    expect(await dmTotal(w)).toBe(dms + 1);
    // A reply to a private message's id is refused: a public channel never holds a pointer into a private one.
    const stray = await say(w.edB, 'x', 'reply into My group', { replyTo: ownGroup });
    expect(stray.status).toBe(404);
    expect((await agentPost(w, 'sess-dev', 'x', { text: 'reply into My group', replyTo: ownGroup })).status).toBe(404);
    expect(texts(await read(w.alexB, 'x')).some((t) => t.includes('reply into My group'))).toBe(false);
    // The other way round: a post to My group never lands in a public channel.
    await say(w.edB, 'group', 'GROUP-ONLY-AFTER');
    expect(texts(await read(w.alexB, 'x')).join(' ')).not.toContain('GROUP-ONLY-AFTER');
    expect(await w.fleet.chat.core.store.public.count('x')).toBe(4);
  });

  it('keeps a person\'s group from another person who opens, edits or removes channels', async () => {
    const w = await seeded();
    expect((await describe_(w.alexB, 'group', { description: 'no' })).status).toBe(403);
    expect((await remove(w.rootB, 'group')).status).toBe(403);
    expect(texts(await read(w.edB, 'group'))).toEqual(['ED-GROUP-SECRET']);
  });
});

describe('starting a Direct Message from the picker (#1035)', () => {
  const targets = (b: B, q = '') => b.get(`${CH}/direct-targets${q}`);
  type T = { sessionId: string; name: string; machine: string; address: string; owner: string; own: boolean; status: string; canMessage: boolean; why: string | null; needsApproval: boolean; link: string | null; thread: string };

  it('lists the person\'s own orchestrators and other people\'s live ones, with who owns them and whether an approval is needed', async () => {
    const w = await world();
    const r = await targets(w.edB);
    expect(r.status).toBe(200);
    const list = r.body.targets as T[];
    expect(list.map((t) => t.address)).toEqual(['dev@ed-mbp', 'Tester@ci-runner-01', 'review@alex-box']);
    expect(list[0]).toEqual({ sessionId: 'sess-dev', name: 'dev', machine: 'ed-mbp', address: 'dev@ed-mbp', owner: 'Ed', own: true, status: 'running', waitReason: null, canMessage: true, why: null, needsApproval: false, link: null, thread: 'dm:person:ed|sess-dev' });
    expect(list[2]).toMatchObject({ sessionId: 'sess-alex', owner: 'Alex', own: false, canMessage: true, needsApproval: true, link: 'none', thread: 'dm:person:ed|sess-alex' });
    const alex = (await targets(w.alexB)).body.targets as T[];
    expect(alex.map((t) => `${t.address}:${t.own}`)).toEqual(['review@alex-box:true', 'dev@ed-mbp:false', 'Tester@ci-runner-01:false']);
  });

  it('narrows by what is typed, omits an ended agent and a reporter with messaging off, and says why an agent cannot be written to', async () => {
    const w = await world();
    expect(((await targets(w.edB, '?q=ALEX')).body.targets as T[]).map((t) => t.address)).toEqual(['review@alex-box']);
    expect(((await targets(w.edB, '?q=ci-runner')).body.targets as T[]).map((t) => t.address)).toEqual(['Tester@ci-runner-01']);
    expect(((await targets(w.edB, '?q=zzz')).body.targets as T[])).toEqual([]);
    // Another person's agent whose reporter has messaging off cannot take part, so it is not offered; the person's own is, and says why it cannot take a message.
    expect((await alexOne(w, { peers: false })).status).toBe(200);
    expect((await targets(w.edB)).body.targets.map((t: T) => t.address)).toEqual(['dev@ed-mbp', 'Tester@ci-runner-01']);
    expect((await dev(w, { respond: { level: 'off', accepts: [], limits: [] } })).status).toBe(200);
    const dm = ((await targets(w.edB)).body.targets as T[])[0]!;
    expect(dm).toMatchObject({ address: 'dev@ed-mbp', canMessage: false });
    expect(dm.why).toMatch(/respond/i);
    expect((await alexOne(w)).status).toBe(200);
    expect((await dev(w, { status: 'done', waitReason: null, endReason: 'other' })).status).toBe(200);
    w.tick(DEFAULT_CONFIG.lingerMs + 1000);
    await w.fleet.sweep();
    expect(((await targets(w.edB)).body.targets as T[]).map((t) => t.address)).toEqual(['Tester@ci-runner-01', 'review@alex-box']);
  });

  it('answers an empty list to the admin secret, which has no person to write as, and is gated like Chat', async () => {
    const w = await world();
    expect((await targets(w.secretB)).body).toEqual({ ok: true, targets: [] });
    expect((await request(w.app).get(`${CH}/direct-targets`)).status).toBe(403);
    const off = await setup({ flag: false });
    expect((await request(off.app).get(`${CH}/direct-targets`)).status).toBe(403);
  });

  it('starts a conversation with one of the person\'s own orchestrators through the existing route, and reuses it for the next message', async () => {
    const w = await world();
    const first = await w.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: 'hello Tester' });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ ok: true, message: { author: 'person', text: 'hello Tester' }, skipped: [], errors: [] });
    const listed = (await w.edB.get(CH)).body.directs as { thread: string; messages: number }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ thread: 'dm:person:ed|sess-tester', messages: 1 });
    expect(((await tester(w)).body.deliveries ?? []).map((d: { text?: string }) => d.text)).toEqual(['hello Tester']);
    expect((await w.edB.post(`${CH}/dm/me/sess-tester/messages`).set(H).send({ text: 'and again' })).status).toBe(202);
    expect(((await w.edB.get(CH)).body.directs as unknown[]).length).toBe(1);
  });

  it('starts a conversation with another person\'s orchestrator through the same route, and it waits for its owner', async () => {
    const w = await world();
    const first = await w.edB.post(`${CH}/dm/me/sess-alex/messages`).set(H).send({ text: 'a question for review' });
    expect(first.status).toBe(202);
    expect(first.body.message).toMatchObject({ author: 'person', state: 'approval', waitingFor: 'Alex', text: 'a question for review' });
    const cross = ((await w.edB.get(CH)).body.directs as { cross: { link: string; owner: string } | null }[])[0]!.cross;
    expect(cross).toMatchObject({ link: 'waiting', owner: 'Alex' });
    expect((await w.alexB.get(CH)).body.approvals).toBe(1);
    // Nothing reaches the agent before its owner allows it.
    expect(((await alexOne(w)).body.deliveries ?? [])).toEqual([]);
    // A subagent, a fork or an ended session is not a conversation to start: there is no such live orchestrator.
    expect((await w.edB.post(`${CH}/dm/me/sess-nobody/messages`).set(H).send({ text: 'hi' })).status).toBe(404);
  });
});

describe('an agent lists the channels (#1035)', () => {
  const list = (s: S, sid: string, token?: string) => request(s.app).get(`/api/fleet/sessions/${sid}/chat/channels`).set('X-Podium-Token', token ?? s.ed.token);

  it('answers General first and then every public channel by name, with metadata and counts and never a message', async () => {
    const w = await world();
    await open(w.edB, { name: 'zeta', description: 'Last by name.' });
    await open(w.alexB, { name: 'issue-1035', description: 'The channels issue.', link: { kind: 'issue', ref: '#1035' } });
    await say(w.edB, 'issue-1035', 'SECRET-BODY-TEXT');
    await say(w.edB, 'issue-1035', 'second');
    await say(w.edB, 'general', 'hello everyone');
    const r = await list(w, 'sess-dev');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.channels.map((c: { name: string }) => c.name)).toEqual(['general', 'issue-1035', 'zeta']);
    expect(r.body.channels[0]).toEqual({ name: 'general', description: '', link: null, openedBy: null, messages: 1, paused: false, disconnected: false });
    expect(r.body.channels[1]).toEqual({ name: 'issue-1035', description: 'The channels issue.', link: { kind: 'issue', ref: '#1035' }, openedBy: 'Alex', messages: 2, paused: false, disconnected: false });
    expect(JSON.stringify(r.body)).not.toContain('SECRET-BODY-TEXT');
    expect(JSON.stringify(r.body)).not.toMatch(/group/i);
  });

  it('flags a channel disconnected or paused for this person only', async () => {
    const w = await world();
    await open(w.edB, { name: 'quiet' });
    expect((await w.edB.put(`${CH}/channels/quiet/disconnect`).set(H).send({ disconnected: true })).status).toBe(200);
    expect((await w.edB.put(`${CH}/channels/quiet/pause`).set(H).send({ paused: true })).status).toBe(200);
    const mine = (await list(w, 'sess-dev')).body.channels.find((c: { name: string }) => c.name === 'quiet');
    expect(mine).toMatchObject({ disconnected: true, paused: true });
    const theirs = (await list(w, 'sess-alex', w.alex.token)).body.channels.find((c: { name: string }) => c.name === 'quiet');
    expect(theirs).toMatchObject({ disconnected: false, paused: false });
  });

  it('lists only General when nobody has opened a channel', async () => {
    const w = await world();
    expect((await list(w, 'sess-dev')).body.channels.map((c: { name: string }) => c.name)).toEqual(['general']);
  });

  it('refuses the admin secret, another person\'s agent, a browser sign-in, no credential, an unknown session and messaging off', async () => {
    const w = await world();
    expect((await list(w, 'sess-dev', SECRET)).status).toBe(403);
    expect((await list(w, 'sess-dev', w.alex.token)).status).toBe(403);
    expect((await list(w, 'sess-unknown')).status).toBe(404);
    const bare = await request(w.app).get('/api/fleet/sessions/sess-dev/chat/channels');
    expect([401, 403]).toContain(bare.status);
    const viaCookie = await w.edB.get('/api/fleet/sessions/sess-dev/chat/channels');
    expect([401, 403]).toContain(viaCookie.status);
    expect(viaCookie.body).not.toHaveProperty('channels');
    const off = await setup({ flag: false });
    expect((await list(off, 'sess-dev')).status).toBe(403);
  });

  it('refuses a session whose reporter has messaging off', async () => {
    const w = await world();
    expect((await dev(w, { status: 'running', waitReason: null, peers: false })).status).toBe(200);
    expect((await list(w, 'sess-dev')).status).toBe(403);
  });
});
