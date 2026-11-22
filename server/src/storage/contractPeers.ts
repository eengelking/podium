// Contract cases for orchestrator messaging (#890): the rights between reporters, the owners' defaults and limits, requests for
// access, and the messages, answers, retention and views built on them. Each runs one scenario over every adapter
// (`sameOnAll`). Ids of messages and requests are generated, so they are scrubbed from what is compared and used as they come.
import { it, expect } from 'vitest';
import { onEachAdapter, sameOnAll, type Openers } from './contractSame.js';
import type { Report } from '../fleet/protocol.js';
import { personKeyOf, type Actor, type MessageRow, type PeerChange } from '../fleet/peerTypes.js';
import type { ReporterSeen } from './rows.js';
import type { PeerStoreApi, Storage } from './types.js';
import { session } from './contract.js';
import type { SessionRow } from './rows.js';
/** A stored session of ed (or eve), bound to the person's id as a report from their token binds it (#1284). */
const sess = (over: Partial<SessionRow> & { id: string }): SessionRow => session({ owner_id: over.owner === 'eve' ? EVE_ID : ED_ID, ...over });

const T0 = 1_800_000_000_000;
const ED: Actor = { name: 'ed', admin: false };
const ADMIN: Actor = { name: 'Admin', admin: true };
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The `people.id` of two people (#1269): the ids the server gives, which a direct message keeps as its author. */
const ED_ID = 11;
const EVE_ID = 12;
/** A person's end of a link is `person:<people.id>` (#1284). */
const ED_KEY = personKeyOf(ED_ID);
const EVE_KEY = personKeyOf(EVE_ID);
const asRow = (v: unknown): MessageRow => v as MessageRow;
const SERVER_LIMITS = { roundTrips: 10, perMinute: 6, maxChars: 20_000 };

/** The ids of the two people a scenario has: by default the fixed ones, and a scenario that creates real people passes theirs. */
export interface Ids { ed: number; eve: number }
const IDS: Ids = { ed: ED_ID, eve: EVE_ID };
const seen = (id: string, name: string, owner: string, sessionId: string, ids: Ids = IDS): ReporterSeen => ({
  kind: 'mod', machineId: id, machineName: name, source: '127.0.0.1', owner, ownerId: owner === 'ed' ? ids.ed : ids.eve, credential: 'person', version: '1.2.0', engineVersion: null, sessionId, os: 'macOS', peers: true,
});
const waiting = (name: string, machine: string): Report =>
  ({ session: { name, status: 'waiting', waitReason: 'input', peers: true, repoName: null, projectRoot: '~/dev' }, machine: { name: machine, os: 'macOS' } }) as unknown as Report;
const working = (name: string, machine: string, waitReason: 'permission' | null = null): Report =>
  ({ session: { name, status: waitReason ? 'waiting' : 'running', waitReason, peers: true, repoName: null, projectRoot: '~/dev' }, machine: { name: machine, os: 'macOS' } }) as unknown as Report;
const done = (name: string, machine: string): Report =>
  ({ session: { name, status: 'done', waitReason: null, peers: true, repoName: null, projectRoot: '~/dev' }, machine: { name: machine, os: 'macOS' } }) as unknown as Report;

/** Three reporters of `ed` (each with a waiting orchestrator), one of another owner and one that reports with the admin secret. */
export async function setUp(s: Storage, clock: { now: number }, ids: Ids = IDS): Promise<{ peers: PeerStoreApi; a: string; b: string; c: string; eve: string }> {
  const peers = s.peers({ now: () => clock.now, flagOn: () => true, startedAt: T0 });
  const a = await s.reporters.record(seen('a', 'box-a', 'ed', 'sa', ids), T0);
  const b = await s.reporters.record(seen('b', 'box-b', 'ed', 'sb', ids), T0);
  const c = await s.reporters.record(seen('c', 'box-c', 'ed', 'sc', ids), T0);
  const eve = await s.reporters.record(seen('e', 'box-e', 'eve', 'se', ids), T0);
  for (const [id, owner] of [['sa', 'ed'], ['sb', 'ed'], ['sc', 'ed'], ['se', 'eve']] as const) await s.fleet.upsertSession(sess({ id, owner, owner_id: owner === 'ed' ? ids.ed : ids.eve }));
  await peers.note('sa', a, 'ed', ids.ed, waiting('alpha', 'box-a'));
  await peers.note('sb', b, 'ed', ids.ed, waiting('beta', 'box-b'));
  await peers.note('sc', c, 'ed', ids.ed, waiting('gamma', 'box-c'));
  await peers.note('se', eve, 'eve', ids.eve, waiting('delta', 'box-e'));
  return { peers, a, b, c, eve };
}

export function peerCases(o: Openers): void {
  it('agrees on every adapter for rights: setting, pausing, removing, proposing and the refusals between owners', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c, eve } = await setUp(s, clock);
      const r = peers.rights;
      await rec('effective (none)', r.effective(a, b));
      await rec('set a to b: send', r.setRight(ED_ID, a, b, 'send', ED));
      await rec('set b to a: see', r.setRight(ED_ID, b, a, 'see', ED));
      await rec('set a to c: ask', r.setRight(ED_ID, a, c, 'ask', ED));
      await rec('set across owners', r.setRight(ED_ID, a, eve, 'see', ED));
      await rec('effective', r.effective(a, b));
      await rec('effective (other way)', r.effective(b, a));
      await rec('rights of ed', r.rightsOf(ED_ID));
      await rec('rights of eve', r.rightsOf(EVE_ID));
      await rec('pause link', r.pauseLink(ED_ID, a, b, true, ED));
      await rec('effective (paused)', r.effective(a, b));
      await rec('pause unknown link', r.pauseLink(ED_ID, a, 'nope', true, ED));
      await rec('resume link', r.pauseLink(ED_ID, a, b, false, ED));
      await rec('admin pauses the link', r.pauseLink(null, a, b, true, { name: 'Root', admin: true }));
      await rec('effective (an Admin\'s pause)', r.effective(a, b));
      await rec('rights (an Admin\'s pause)', r.rightsOf(ED_ID));
      await rec('owner pauses it again', r.pauseLink(ED_ID, a, b, true, ED));
      await rec('effective (still the Admin\'s)', r.effective(b, a));
      await rec('owner resumes (refused)', r.pauseLink(ED_ID, a, b, false, ED));
      await rec('owner resumes the reporter (the Admin\'s pause stays)', r.pauseReporter(a, false, ED));
      await rec('effective (after the reporter resume)', r.effective(a, b));
      await rec('admin resumes the link', r.pauseLink(null, a, b, false, { name: 'Root', admin: true }));
      await rec('effective (resumed)', r.effective(a, b));
      await rec('pause reporter', r.pauseReporter(a, true, ADMIN));
      await rec('effective (the Admin\'s bulk pause)', r.effective(a, b));
      await rec('effective (the Admin\'s bulk pause, the reporter itself)', r.effective(a, a));
      await rec('pause reporter (not admin)', r.pauseReporter(a, true, ED));
      await rec('rights (paused)', r.rightsOf(ED_ID));
      await rec('owner resumes the reporter (the bulk pause stays)', r.pauseReporter(a, false, ED));
      await rec('effective (after the owner\'s resume of the bulk pause)', r.effective(a, b));
      await rec('resume reporter', r.pauseReporter(a, false, ADMIN));
      await rec('effective (after the Admin\'s bulk resume)', r.effective(a, b));
      await rec('propose', r.propose(b, c, 'see', ADMIN));
      await rec('propose (not admin)', r.propose(b, c, 'see', ED));
      await rec('propose none', r.propose(b, c, 'none', ADMIN));
      await rec('open requests', r.openRequests(ED_ID));
      await rec('open requests about a', r.openRequests(ED_ID, a));
      await rec('set none', r.setRight(ED_ID, b, a, 'none', ED));
      await rec('rights (after none)', r.rightsOf(ED_ID));
      await rec('remove link', peers.removeLink(ED_ID, a, b, ED));
      await rec('rights (removed)', r.rightsOf(ED_ID));
      clock.now += 1;
    });
    expect((t.get('set across owners') as { ok: boolean }).ok).toBe(false);
    expect(t.get('effective (an Admin\'s pause)')).toMatchObject({ paused: true, pausedBy: 'admin', pausedByAdmin: 'Root' });
    expect(t.get('effective (still the Admin\'s)')).toMatchObject({ paused: true, pausedBy: 'admin', pausedByAdmin: 'Root' });
    expect(t.get('owner resumes (refused)')).toMatchObject({ ok: false, status: 403 });
    expect(t.get('effective (after the reporter resume)')).toMatchObject({ paused: true, pausedBy: 'admin', pausedByAdmin: 'Root' });
    expect(t.get('effective (resumed)')).toEqual({ level: 'send', paused: false });
    // A bulk pause is the Admin's, named, like a pause of one link (#1077); only an Admin lifts it.
    expect(t.get('effective (the Admin\'s bulk pause)')).toMatchObject({ paused: true, pausedBy: 'admin', pausedByAdmin: 'Admin' });
    expect(t.get('effective (the Admin\'s bulk pause, the reporter itself)')).toMatchObject({ paused: true, pausedBy: 'admin', pausedByAdmin: 'Admin' });
    expect(t.get('effective (after the owner\'s resume of the bulk pause)')).toMatchObject({ paused: true, pausedBy: 'admin', pausedByAdmin: 'Admin' });
    expect(t.get('effective (after the Admin\'s bulk resume)')).toEqual({ level: 'send', paused: false });
  });

  it('agrees on every adapter for owner defaults and limits, and for requests for access in the order they were opened', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c } = await setUp(s, clock);
      const r = peers.rights;
      await rec('defaults (fresh)', r.defaults(ED_ID));
      await rec('limits (fresh)', r.limits(ED_ID, SERVER_LIMITS));
      await rec('set defaults', peers.setDefaults(ED_ID, { roundTrips: 3 }, ED));
      await rec('set defaults over the server limit', peers.setDefaults(ED_ID, { roundTrips: 99 }, ED));
      await rec('set defaults unknown key', peers.setDefaults(ED_ID, { nope: 1 }, ED));
      await rec('defaults', r.defaults(ED_ID));
      await rec('limits (stricter)', r.limits(ED_ID, SERVER_LIMITS));
      await rec('limits (another owner)', r.limits(EVE_ID, SERVER_LIMITS));
      // three requests in the same millisecond, then one later: oldest first, the tie decided by one rule
      await rec('request 1', r.requestAccess({ ownerId: ED_ID, fromKey: a, toKey: b, right: 'see', reason: 'one', by: 'alpha', fromSession: 'sa' }));
      await rec('request 2', r.requestAccess({ ownerId: ED_ID, fromKey: a, toKey: c, right: 'send', reason: 'two', by: 'alpha', fromSession: 'sa' }));
      await rec('request 3', r.requestAccess({ ownerId: ED_ID, fromKey: b, toKey: c, right: 'see', reason: 'three', by: 'beta', fromSession: 'sb' }));
      clock.now += 5;
      await rec('request 4', r.requestAccess({ ownerId: ED_ID, fromKey: c, toKey: a, right: 'see', reason: 'four', by: 'gamma', fromSession: 'sc' }));
      await rec('request again (same pair)', r.requestAccess({ ownerId: ED_ID, fromKey: a, toKey: b, right: 'see', reason: 'one more', by: 'alpha', fromSession: 'sa' }));
      await rec('request across owners', r.requestAccess({ ownerId: ED_ID, fromKey: a, toKey: 'e', right: 'see', reason: 'x', by: 'alpha', fromSession: 'sa' }));
      await rec('open', r.openRequests(ED_ID));
      await rec('open about c', r.openRequests(ED_ID, c));
      await rec('open (other owner)', r.openRequests(EVE_ID));
    });
    expect(((t.get('open') as { reason?: string }[]) ?? []).length).toBeGreaterThan(0);
  });

  it('lists open requests made in the same millisecond in the order they were made, whatever their pair, kind, reason or id', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c } = await setUp(s, clock);
      const r = peers.rights;
      // five requests at one moment, in an order that neither the reporters' keys, the reasons nor the generated ids would give
      const asks: [string, string, 'see' | 'send', string][] = [[c, a, 'see', 'zulu'], [a, b, 'send', 'mike'], [a, b, 'see', 'alpha'], [b, c, 'see', 'yankee'], [a, c, 'see', 'bravo']];
      for (const [from, to, right, reason] of asks) await rec(`request ${reason}`, r.requestAccess({ ownerId: ED_ID, fromKey: from, toKey: to, right, reason, by: 'x', fromSession: 'sa' }));
      await rec('open', r.openRequests(ED_ID));
      await rec('open about a', r.openRequests(ED_ID, a));
      clock.now += 1;
      await rec('request later', r.requestAccess({ ownerId: ED_ID, fromKey: b, toKey: a, right: 'see', reason: 'later', by: 'x', fromSession: 'sb' }));
      await rec('open (with a later one)', r.openRequests(ED_ID));
    });
    const reasons = (t.get('open') as { reason: string }[]).map((x) => x.reason);
    expect(reasons).toEqual(['zulu', 'mike', 'alpha', 'yankee', 'bravo']);
    expect((t.get('open (with a later one)') as { reason: string }[]).map((x) => x.reason).at(-1)).toBe('later');
  });

  it('agrees on every adapter for sending, listing, results and the order of a conversation, through approval and decline', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight(ED_ID, from, to, 'send', ED);
      await peers.rights.setRight(ED_ID, a, c, 'ask', ED);
      await rec('list for alpha', peers.messages.list('sa'));
      await rec('live', peers.messages.live('sa'));
      await rec('live (unknown)', peers.messages.live('nope'));
      const one = await peers.messages.send('sa', 'beta@box-b', 'one');
      await rec('send', (one));
      await rec('message by id', peers.messages.message((one as { id: string }).id));
      await rec('message by an unknown id', peers.messages.message('nope'));
      await rec('send to an unknown name', peers.messages.send('sa', 'nobody@box-x', 'hi'));
      await rec('send too long', peers.messages.send('sa', 'beta@box-b', 'x'.repeat(20_001)));
      const ask = await peers.messages.send('sa', 'gamma@box-c', 'may I?');
      await rec('send (needs approval)', (ask));
      await rec('result for the first', peers.messages.result('sb', (one as { id: string }).id, 'took'));
      await rec('result again', peers.messages.result('sb', (one as { id: string }).id, 'took'));
      await rec('result unknown', peers.messages.result('sb', 'nope', 'took'));
      await rec('conversation', (await peers.messages.conversation('sa', 'sb')));
      await rec('conversations', (await peers.messages.conversations({})));
      await rec('conversations (owner)', (await peers.messages.conversations({ ownerId: ED_ID })));
      await rec('conversations (other owner)', (await peers.messages.conversations({ ownerId: EVE_ID })));
      await rec('conversations (live only)', (await peers.messages.conversations({ liveOnly: true })));
      await rec('conversations (since)', (await peers.messages.conversations({ since: T0 + 1 })));
      await rec('open requests', (await peers.rights.openRequests(ED_ID)));
    });
    expect((t.get('send') as { ok: boolean }).ok).toBe(true);
    expect((t.get('send too long') as { ok: boolean }).ok).toBe(false);
  });

  it('agrees on every adapter that a message is handed over to an agent in the middle of a turn, and held only while a permission prompt is open (#1252)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight(ED_ID, from, to, 'send', ED);
      await peers.note('sb', b, 'ed', ED_ID, working('beta', 'box-b'));
      await rec('send to a running agent', peers.messages.send('sa', 'beta@box-b', 'the runners are down'));
      await rec('running agent reports', peers.replyFor('sb', true));
      await peers.note('sb', b, 'ed', ED_ID, working('beta', 'box-b', 'permission'));
      await rec('send to an agent at a permission prompt', peers.messages.send('sa', 'beta@box-b', 'after the prompt'));
      await rec('prompt open: nothing handed over', peers.replyFor('sb', true));
      await peers.note('sb', b, 'ed', ED_ID, working('beta', 'box-b'));
      await rec('prompt answered: handed over', peers.replyFor('sb', true));
    });
    expect(t.get('send to a running agent')).toMatchObject({ ok: true, state: 'sent' });
    expect((t.get('running agent reports') as { peerDeliveries: { text: string }[] }).peerDeliveries.map((d) => d.text)).toEqual(['the runners are down']);
    expect(t.get('send to an agent at a permission prompt')).toMatchObject({ ok: true, state: 'turn' });
    expect((t.get('prompt open: nothing handed over') as { peerDeliveries: unknown[] }).peerDeliveries).toEqual([]);
    expect((t.get('prompt answered: handed over') as { peerDeliveries: { text: string }[] }).peerDeliveries.map((d) => d.text)).toEqual(['the runners are down', 'after the prompt']); // the first was handed and no result came, so it is handed again
  });

  it('agrees on every adapter for answering a request, a paused answer, replying to a session and what ended or deleted sessions drop', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c } = await setUp(s, clock);
      await peers.rights.setRight(ED_ID, a, b, 'send', ED);
      await peers.rights.setRight(ED_ID, a, c, 'ask', ED);
      const waits = (await peers.messages.send('sa', 'gamma@box-c', 'needs approval')) as { id: string; state: string };
      await rec('send (waits)', (waits));
      const request = await peers.rights.requestAccess({ ownerId: ED_ID, fromKey: b, toKey: c, right: 'see', reason: 'look', by: 'beta', fromSession: 'sb' });
      await rec('access', (request));
      const open = await peers.rights.openRequests(ED_ID);
      await rec('open', (open));
      const [first, second] = open;
      await rec('answer: not the owner', peers.answer(first!.id, EVE_ID, 'allow', ED));
      await rec('answer: unknown id', peers.answer('nope', ED_ID, 'allow', ED));
      await rec('answer: wrong kind', peers.answer(first!.id, ED_ID, first!.kind === 'message' ? 'allow' : 'deliver', ED));
      await rec('answer first', (await peers.answer(first!.id, ED_ID, first!.kind === 'message' ? 'deliver' : 'allow', ED)));
      await rec('answer again', peers.answer(first!.id, ED_ID, 'allow', ED));
      if (second) await rec('answer second (paused)', (await peers.answerPaused(second.id, ED_ID, 'decline', ED)));
      await rec('open (after)', (await peers.rights.openRequests(ED_ID)));
      await rec('reply for a (allowed)', (await peers.replyFor('sa', true)));
      await rec('reply for a (not allowed)', (await peers.replyFor('sa', false)));
      await rec('reply for c', (await peers.replyFor('sc', true)));
      await rec('reply for unknown', (await peers.replyFor('nope', true)));
      await peers.note('sb', b, 'ed', ED_ID, done('beta', 'box-b'));
      await rec('live after done', peers.messages.live('sb'));
      await peers.ended('sa');
      await rec('live after ended', peers.messages.live('sa'));
      await rec('conversations', (await peers.messages.conversations({})));
      await peers.deleted(['sc', 'nope']);
      await rec('open (deleted)', (await peers.rights.openRequests(ED_ID)));
      await rec('conversations (deleted)', (await peers.messages.conversations({})));
    });
    expect(t.get('live after ended')).toBeNull();
  });

  it('agrees on every adapter for the owner and admin views, retention, and dropping every held message', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c } = await setUp(s, clock);
      await peers.rights.setRight(ED_ID, a, b, 'send', ED);
      await peers.rights.setRight(ED_ID, b, a, 'send', ED);
      await peers.messages.send('sa', 'beta@box-b', 'hello');
      await peers.messages.send('sb', 'alpha@box-a', 'hi back');
      await peers.rights.requestAccess({ ownerId: ED_ID, fromKey: c, toKey: a, right: 'see', reason: 'look', by: 'gamma', fromSession: 'sc' });
      await rec('owner view', (await peers.ownerView(ED_ID, T0 + 10)));
      await rec('owner view (nobody)', (await peers.ownerView(999, T0 + 10)));
      await rec('admin view', (await peers.adminView(a)));
      await rec('admin view (unknown)', peers.adminView('nope'));
      await rec('retain (nothing old)', peers.retain());
      await rec('conversation (before)', (await peers.messages.conversation('sa', 'sb')));
      clock.now += 400 * 86_400_000;
      await rec('retain (a year on)', peers.retain());
      await rec('conversation (after)', (await peers.messages.conversation('sa', 'sb')));
      await peers.messages.send('sa', 'beta@box-b', 'fresh');
      await peers.dropAll();
      await rec('conversation (after drop all)', (await peers.messages.conversation('sa', 'sb')));
    });
    expect(t.has('owner view')).toBe(true);
  });

  it('sweeps a message from a session id that only looks like a person end, and keeps a real person end, the same on every adapter (#1051)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b } = await setUp(s, clock);
      await peers.rights.setRight(ED_ID, a, b, 'send', ED);
      await peers.rights.setRight(ED_ID, b, a, 'send', ED);
      // A live orchestrator whose id has no sessions row, and whose id differs from the prefix only in case.
      await peers.note('Person:ghost', a, 'ed', ED_ID, waiting('ghost', 'box-a'));
      await rec('send from the look-alike', peers.messages.send('Person:ghost', 'beta@box-b', 'who am I'));
      await rec('person writes', peers.messages.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'from the person' }));
      await rec('retain', peers.retain());
      await rec('look-alike conversation', peers.messages.conversation('Person:ghost', 'sb'));
      await rec('person conversation', peers.messages.conversation(ED_KEY, 'sb'));
    });
    expect((t.get('send from the look-alike') as { ok: boolean }).ok).toBe(true);
    expect((t.get('retain') as { messages: number }).messages).toBe(1);
    expect(t.get('look-alike conversation')).toEqual([]);
    expect((t.get('person conversation') as unknown[]).length).toBe(1);
  });

  it('agrees on every adapter for who wrote a message, the pages of a conversation, a person adding to it, hiding it and deleting it (#1034)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight(ED_ID, from, to, 'send', ED);
      const m = peers.messages;
      // The first two share a moment, so the insertion number decides their order.
      await rec('send 1', m.send('sa', 'beta@box-b', 'one'));
      await rec('send 2', m.send('sb', 'alpha@box-a', 'two'));
      clock.now += 5;
      await rec('send 3', m.send('sa', 'beta@box-b', 'three'));
      await rec('person adds to it', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', withSession: 'sa', text: 'from ed' }));
      await rec('person to one agent', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'just you' }));
      await rec('person: nobody by that id', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'nope', text: 'hi' }));
      await rec('person: another owner\'s agent', m.sendFromPerson({ ownerId: EVE_ID, person: 'Eve', toSession: 'sb', text: 'hi' }));
      await rec('person: empty', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: '  ' }));
      await rec('person: too long', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'x'.repeat(20_001) }));
      await rec('person: no conversation with that agent', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', withSession: 'sc', text: 'hi' }));
      const p1 = await rec('page 1', m.page(ED_ID, 'sa', 'sb', { limit: 2 }));
      await rec('page 2', m.page(ED_ID, 'sa', 'sb', { before: p1.older, limit: 2 }));
      await rec('page (everything, the pair the other way)', m.page(ED_ID, 'sb', 'sa', { limit: 50 }));
      await rec('page with the person alone', m.page(ED_ID, ED_KEY, 'sb', { limit: 50 }));
      await rec('page (another owner)', m.page(EVE_ID, 'sa', 'sb', { limit: 50 }));
      await rec('page (bad cursor)', m.page(ED_ID, 'sa', 'sb', { before: 'junk', limit: 2 }));
      await rec('conversation', m.conversation('sa', 'sb'));
      await rec('deliveries to beta', m.conversation('sb', 'sa'));
      await rec('owner conversations', m.ownerConversations(ED_ID));
      await rec('owner conversations (another owner)', m.ownerConversations(EVE_ID));
      await rec('conversation of the pair', m.conversationOf('sa', 'sb'));
      await rec('conversation of the pair (the other way)', m.conversationOf('sb', 'sa'));
      await rec('conversation of a pair with no messages', m.conversationOf('sa', 'sc'));
      await rec('counts', m.conversationCounts([ED_ID, EVE_ID, 999]));
      // The agents leave: the conversation is hidden and kept, not deleted.
      await peers.ended('sa');
      await peers.ended('sb');
      await rec('person: the agent has ended', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'anyone?' }));
      clock.now += 10;
      await rec('hide (another owner)', m.hideConversation(EVE_ID, 'sa', 'sb'));
      await rec('hide', m.hideConversation(ED_ID, 'sa', 'sb'));
      await rec('hide again', m.hideConversation(ED_ID, 'sa', 'sb'));
      await rec('owner conversations (hidden left out)', m.ownerConversations(ED_ID));
      await rec('owner conversations (hidden included)', m.ownerConversations(ED_ID, { includeHidden: true }));
      await rec('owner conversations (hidden, that pair)', m.ownerConversations(ED_ID, { includeHidden: true, pairs: ['sa|sb'] }));
      await rec('owner conversations (hidden, another pair)', m.ownerConversations(ED_ID, { includeHidden: true, pairs: ['sa|sc'] }));
      expect(await m.ownerConversations(ED_ID, { includeHidden: true, pairs: [] })).toEqual([]);
      expect((await m.ownerConversations(ED_ID, { includeHidden: true, pairs: ['sa|sb'] })).map((c) => c.hiddenAt)).toEqual([expect.any(Number)]);
      expect(await m.ownerConversations(ED_ID, { includeHidden: true, pairs: ['sa|sc'] })).toEqual([]);
      await rec('counts (hidden left out)', m.conversationCounts([ED_ID, EVE_ID]));
      await rec('conversation of the pair (hidden)', m.conversationOf('sa', 'sb'));
      await rec('page (hidden, still readable)', m.page(ED_ID, 'sa', 'sb', { limit: 1 }));
      await rec('purge (not yet old enough)', m.purgeHidden(clock.now, 10));
      await rec('show', m.showConversation(ED_ID, 'sa', 'sb'));
      await rec('owner conversations (shown)', m.ownerConversations(ED_ID));
      await rec('purge (nothing hidden)', m.purgeHidden(clock.now + DAY, 0));
      clock.now += 100;
      await m.hideConversation(ED_ID, 'sa', 'sb');
      await rec('purge (a day on)', m.purgeHidden(clock.now + 1, 0));
      await rec('conversation (purged)', m.conversation('sa', 'sb'));
      await rec('owner conversations (purged)', m.ownerConversations(ED_ID, { includeHidden: true }));
    });
    const everything = t.get('page (everything, the pair the other way)') as { messages: { text: string; author: string; fromName: string }[]; older: string | null };
    expect(everything.messages.map((x) => [x.text, x.author])).toEqual([['one', 'agent'], ['two', 'agent'], ['three', 'agent'], ['from ed', 'person']]);
    expect(everything.older).toBeNull();
    expect((t.get('page 1') as { messages: { text: string }[] }).messages.map((x) => x.text)).toEqual(['three', 'from ed']);
    expect((t.get('page 2') as { messages: { text: string }[] }).messages.map((x) => x.text)).toEqual(['one', 'two']);
    expect((t.get('page with the person alone') as { messages: { text: string }[] }).messages.map((x) => x.text)).toEqual(['just you']);
    expect((t.get('page (another owner)') as { messages: unknown[] }).messages).toEqual([]);
    expect(t.get('page (bad cursor)')).toEqual({ threw: 'The cursor is not one this server gave out.' });
    expect(t.get('person: nobody by that id')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('person: another owner\'s agent')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('person: empty')).toMatchObject({ ok: false, status: 400 });
    expect(t.get('person: too long')).toMatchObject({ ok: false, status: 422 });
    expect(t.get('person: no conversation with that agent')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('person: the agent has ended')).toMatchObject({ ok: false, status: 409 });
    expect(t.get('person adds to it')).toMatchObject({ author: 'person', fromName: 'Ed', toSession: 'sb', fromSession: 'sa', state: 'ready', approved: false });
    expect(t.get('person to one agent')).toMatchObject({ author: 'person', fromName: 'Ed', toSession: 'sb', fromSession: ED_KEY });
    expect((t.get('owner conversations') as unknown[]).length).toBe(2);
    expect(t.get('conversation of the pair')).toEqual(t.get('conversation of the pair (the other way)'));
    expect(t.get('conversation of the pair')).toMatchObject({ a: { sessionId: 'sa' }, b: { sessionId: 'sb' }, owner: 'ed', messages: 4 });
    expect(t.get('conversation of a pair with no messages')).toBeNull();
    expect(t.get('counts')).toEqual({ [ED_ID]: 2, [EVE_ID]: 0, 999: 0 });
    expect(t.get('counts (hidden left out)')).toEqual({ [ED_ID]: 1, [EVE_ID]: 0 });
    expect((t.get('conversation of the pair (hidden)') as { a: { sessionId: string } }).a.sessionId).toBe('sa');
    expect(t.get('owner conversations (another owner)')).toEqual([]);
    expect(t.get('hide (another owner)')).toBe(0);
    expect(t.get('hide')).toBe(4);
    expect(t.get('hide again')).toBe(0);
    expect((t.get('owner conversations (hidden left out)') as { a: { sessionId: string } }[]).map((c) => c.a.sessionId)).toEqual([ED_KEY]);
    expect((t.get('owner conversations (hidden included)') as { hiddenAt: number | null }[]).map((c) => c.hiddenAt).sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b))).toEqual([T0 + 15, null]);
    expect(t.get('purge (not yet old enough)')).toBe(0);
    expect(t.get('show')).toBe(4);
    expect((t.get('owner conversations (shown)') as { hiddenAt: number | null }[]).map((c) => c.hiddenAt)).toEqual([null, null]);
    expect(t.get('purge (nothing hidden)')).toBe(0);
    expect(t.get('purge (a day on)')).toBe(4);
    expect(t.get('conversation (purged)')).toEqual([]);
    expect((t.get('owner conversations (purged)') as { a: { sessionId: string } }[]).map((c) => c.a.sessionId)).toEqual([ED_KEY]);
  });

  it('keeps a hidden conversation for the longest resume window of its agents, and for the grace period when no window is known (#1113)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight(ED_ID, from, to, 'send', ED);
      const m = peers.messages;
      const windows = async (sa: number | null, sb: number | null) => {
        await s.fleet.upsertSession(sess({ id: 'sa', owner: 'ed', resume_window_days: sa }));
        await s.fleet.upsertSession(sess({ id: 'sb', owner: 'ed', resume_window_days: sb }));
      };
      // The agents' harnesses let a person resume them for 7 and 3 days, so the conversation stays 7 days, whatever the grace period says.
      await windows(7, 3);
      await m.send('sa', 'beta@box-b', 'one');
      await m.hideConversation(ED_ID, 'sa', 'sb');
      await rec('purge: 2 days on, grace one hour', m.purgeHidden(T0 + 2 * DAY, HOUR));
      await rec('purge: 6 days on', m.purgeHidden(T0 + 6 * DAY, HOUR));
      await rec('conversation kept', m.conversation('sa', 'sb'));
      await rec('purge: past 7 days', m.purgeHidden(T0 + 7 * DAY + 1, HOUR));
      await rec('conversation purged', m.conversation('sa', 'sb'));
      // No window known (a session stored before it was reported): the grace period decides, as before.
      clock.now = T0 + 10 * DAY;
      await windows(null, null);
      await m.send('sa', 'beta@box-b', 'two');
      await m.hideConversation(ED_ID, 'sa', 'sb');
      await rec('purge: half the grace period on', m.purgeHidden(clock.now + HOUR / 2, HOUR));
      await rec('purge: past the grace period', m.purgeHidden(clock.now + 2 * HOUR, HOUR));
      await rec('conversation purged by the grace period', m.conversation('sa', 'sb'));
    });
    expect(t.get('purge: 2 days on, grace one hour')).toBe(0);
    expect(t.get('purge: 6 days on')).toBe(0);
    expect((t.get('conversation kept') as unknown[]).length).toBeGreaterThan(0);
    expect(t.get('purge: past 7 days')).toBeGreaterThan(0);
    expect(t.get('conversation purged')).toEqual([]);
    expect(t.get('purge: half the grace period on')).toBe(0);
    expect(t.get('purge: past the grace period')).toBeGreaterThan(0);
    expect(t.get('conversation purged by the grace period')).toEqual([]);
  });

  it('does not count a person\'s message as a round trip, nor let it reset the cap', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight(ED_ID, from, to, 'send', ED);
      const m = peers.messages;
      await m.send('sa', 'beta@box-b', 'one');
      await rec('after one', m.conversations({ ownerId: ED_ID }));
      await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sa', withSession: 'sb', text: 'from ed' });
      await rec('after the person', m.conversations({ ownerId: ED_ID }));
      await m.send('sb', 'alpha@box-a', 'two');
      await rec('after the answer', m.conversations({ ownerId: ED_ID }));
    });
    const trips = (label: string): number => (t.get(label) as { roundTrips: { used: number } }[])[0]!.roundTrips.used;
    expect([trips('after one'), trips('after the person'), trips('after the answer')]).toEqual([0, 0, 1]);
  });

  it('tells a live agent in Podium\'s voice and not one that is not live, and still says an agent ended once its conversation is deleted, the same on every adapter (#1283)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers } = await setUp(s, clock);
      const m = peers.messages;
      await rec('person writes to beta', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'hello' }));
      await m.notice('sa', 'beta ended. This direct message has been concluded.');
      await rec('reply for alpha carries the notice', peers.replyFor('sa', true));
      await m.notice('sx', 'told to nobody');
      await rec('no reply for a session that is not live', peers.replyFor('sx', true));
      await peers.ended('sb');
      await rec('the conversation is deleted', m.deleteConversation(ED_ID, `person:${ED_ID}`, 'sb'));
      await rec('no conversation is left', m.ownerConversations(ED_ID, { includeHidden: true }));
      await rec('the ended agent is still known, so it is refused as ended', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'anyone?' }));
      await rec('an id no session ever had is not known', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'nope', text: 'anyone?' }));
    });
    expect(t.get('the ended agent is still known, so it is refused as ended')).toMatchObject({ status: 409 });
    expect(t.get('an id no session ever had is not known')).toMatchObject({ status: 404 });
    expect(t.get('no conversation is left')).toEqual([]);
    expect(JSON.stringify(t.get('reply for alpha carries the notice'))).toContain('has been concluded');
    expect(JSON.stringify(t.get('no reply for a session that is not live'))).not.toContain('told to nobody');
  });

  it('deletes one conversation\'s messages and no other, and a page cursor outlives the deletion (#1034)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a], [a, c], [c, a]] as const) await peers.rights.setRight(ED_ID, from, to, 'send', ED);
      const m = peers.messages;
      for (const text of ['one', 'two', 'three']) {
        await m.send('sa', 'beta@box-b', text);
        clock.now += 1;
      }
      await m.send('sa', 'gamma@box-c', 'to gamma');
      const p1 = await rec('page 1', m.page(ED_ID, 'sa', 'sb', { limit: 2 }));
      await rec('delete (another owner)', m.deleteConversation(EVE_ID, 'sa', 'sb'));
      await rec('delete', m.deleteConversation(ED_ID, 'sb', 'sa'));
      await rec('page 2 after the delete', m.page(ED_ID, 'sa', 'sb', { before: p1.older, limit: 2 }));
      await rec('delete again', m.deleteConversation(ED_ID, 'sa', 'sb'));
      await rec('the other conversation', m.conversation('sa', 'sc'));
      await rec('conversations', m.ownerConversations(ED_ID));
    });
    expect(t.get('delete (another owner)')).toBe(0);
    expect(t.get('delete')).toBe(3);
    expect(t.get('page 2 after the delete')).toEqual({ messages: [], older: null });
    expect(t.get('delete again')).toBe(0);
    expect((t.get('the other conversation') as { text: string }[]).map((x) => x.text)).toEqual(['to gamma']);
    expect((t.get('conversations') as unknown[]).length).toBe(1);
  });
  it('lists a hidden conversation with the time it was hidden, however many messages it holds (#1051)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers } = await setUp(s, clock);
      const m = peers.messages;
      // The count stays small because every message is a database call; the largest a list can hold without throwing is held by `peerText.test.ts` (`latestOf`).
      for (let i = 0; i < 60; i++) await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sa', text: `m${i}`, state: 'queued' });
      clock.now += 5;
      await rec('hide', m.hideConversation(ED_ID, ED_KEY, 'sa'));
      clock.now += 5;
      await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'another conversation', state: 'queued' });
      const list = await rec('with the hidden one', m.ownerConversations(ED_ID, { includeHidden: true }));
      await rec('hidden at', Promise.resolve(list.map((c) => [c.a.sessionId, c.b.sessionId, c.messages, c.hiddenAt])));
      await rec('without the hidden one', m.ownerConversations(ED_ID).then((l) => l.map((c) => [c.a.sessionId, c.b.sessionId])));
    });
    expect(t.get('hide')).toBe(60);
    expect(t.get('hidden at')).toEqual([[ED_KEY, 'sb', 1, null], [ED_KEY, 'sa', 60, T0 + 5]]);
    expect(t.get('without the hidden one')).toEqual([[ED_KEY, 'sb']]);
  });

  it("agrees on every adapter for a person writing to another person's agent: the request, the link it opens, pausing, removing and the refusals (#1034)", async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c } = await setUp(s, clock);
      // Three more agents of ed on box-a, so a flood can pass the cap on what one person may have waiting.
      for (const n of [1, 2, 3, 4]) {
        await s.fleet.upsertSession(sess({ id: `sx${n}`, owner: 'ed' }));
        await peers.note(`sx${n}`, a, 'ed', ED_ID, waiting(`extra${n}`, 'box-a'));
      }
      const m = peers.messages;
      await rec('empty', m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sb', text: ' ' }));
      await rec('nobody by that id', m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'nope', text: 'hi' }));
      await rec('too long', m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sb', text: 'x'.repeat(20_001) }));
      await rec("the person's own agent", m.sendAcross({ person: 'Ed', personId: ED_ID, toSession: 'sb', text: 'hi' }));
      const first = await rec('first message waits for approval', m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sb', text: 'hello beta' }));
      await rec('the same agent again while it waits', m.sendAcross({ person: 'EVE', personId: EVE_ID, toSession: 'sb', text: 'hello again' }));
      await rec('a request is open', peers.rights.openRequests(ED_ID));
      await rec('nothing is handed over yet', peers.replyFor('sb', true));
      await rec('eve list', m.ownerConversations(EVE_ID));
      await rec('ed list', m.ownerConversations(ED_ID));
      await rec('a third person list', m.ownerConversations(999));
      await rec('owner read', m.page(ED_ID, EVE_KEY, 'sb', { limit: 10 }));
      await rec('reporters grid leaves the person out', peers.rights.rightsOf(ED_ID));
      // The flood: five waiting at one owner, then refused.
      for (const to of ['sa', 'sc', 'sx1', 'sx2']) await rec(`waiting for ${to}`, m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: to, text: `hi ${to}` }));
      await rec('past the cap', m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sx3', text: 'one too many' }));
      // A decline stores no link and tells the person's side only through the message.
      const toC = (await peers.rights.openRequests(ED_ID)).find((r) => r.toKey === c)!;
      await rec('decline', peers.answer(toC.id, ED_ID, 'decline', ED));
      await rec('no link after a decline', peers.rights.personLink(EVE_KEY, c));
      // An agent that ends with a request open drops it.
      await peers.ended('sa');
      await rec('after the agent ended', m.page(ED_ID, EVE_KEY, 'sa', { limit: 10 }));
      await rec('requests after the end', peers.rights.openRequests(ED_ID));
      // An allow opens the link and delivers.
      const toB = (await peers.rights.openRequests(ED_ID)).find((r) => r.toKey === b)!;
      await rec('request view', peers.ownerView(ED_ID, T0));
      await rec('allow', peers.answer(toB.id, ED_ID, 'deliver', ED));
      await rec('the link', peers.rights.personLink(EVE_KEY, b));
      await rec('effective', peers.rights.effective(EVE_KEY, b));
      await rec('handed over, framed as a person', peers.replyFor('sb', true));
      await rec('taken', m.result('sb', (first as { id: string }).id, 'took'));
      await rec('sent over the open link', m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sb', text: 'second' }));
      await rec('pause', peers.setPersonLink(EVE_KEY, b, 'pause', ED, 'sender'));
      await rec('the link paused by the sender', peers.rights.personLink(EVE_KEY, b));
      await rec('paused: refused', m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sb', text: 'third' }));
      await rec('paused: nothing handed over', peers.replyFor('sb', true));
      await rec('resume', peers.setPersonLink(EVE_KEY, b, 'resume', ED));
      await rec('resumed: handed over', peers.replyFor('sb', true));
      await rec('the link after a resume', peers.rights.personLink(EVE_KEY, b));
      await rec('pause by the owner', peers.setPersonLink(EVE_KEY, b, 'pause', ED, 'owner'));
      await rec('the link paused by the owner', peers.rights.personLink(EVE_KEY, b));
      await rec('pause by an Admin', peers.setPersonLink(EVE_KEY, b, 'pause', ED, 'admin'));
      await rec('the link paused by an Admin', peers.rights.personLink(EVE_KEY, b));
      await rec('pause with no pauser', peers.setPersonLink(EVE_KEY, b, 'pause', ED));
      await rec('the link paused by nobody known', peers.rights.personLink(EVE_KEY, b));
      await rec('resume again', peers.setPersonLink(EVE_KEY, b, 'resume', ED));
      await rec('remove', peers.setPersonLink(EVE_KEY, b, 'remove', ED));
      await rec('removed: refused', m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sb', text: 'fourth' }));
      await rec('remove again', peers.setPersonLink(EVE_KEY, b, 'remove', ED));
      await rec('pause a removed link', peers.setPersonLink(EVE_KEY, b, 'pause', ED));
      await rec('a link to ones own agent', peers.setPersonLink(ED_KEY, b, 'allow', ED));
      await rec('a link to nobody', peers.setPersonLink(EVE_KEY, 'nope', 'allow', ED));
      await rec('not a person', peers.setPersonLink('eve', b, 'allow', ED));
      await rec('open it again', peers.setPersonLink(EVE_KEY, b, 'allow', ED));
      await rec('sent again', m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sb', text: 'fifth' }));
      // The hourly sweep keeps a person's messages and an open request.
      clock.now += 3_600_000;
      await rec('retain', peers.retain());
      await rec('after retain', m.page(ED_ID, EVE_KEY, 'sb', { limit: 10 }));
      await rec('requests after retain', peers.rights.openRequests(ED_ID));
      await rec('delete (the person is not the stored owner)', m.deleteConversation(EVE_ID, EVE_KEY, 'sb'));
      await rec('delete', m.deleteConversation(ED_ID, EVE_KEY, 'sb'));
      await rec('eve list after the delete', m.ownerConversations(EVE_ID));
    });
    const state = (label: string) => (t.get(label) as { state: string }).state;
    expect(t.get('empty')).toMatchObject({ ok: false, status: 400 });
    expect(t.get('nobody by that id')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('too long')).toMatchObject({ ok: false, status: 422 });
    expect(t.get("the person's own agent")).toMatchObject({ ok: false, status: 422 });
    expect(t.get('first message waits for approval')).toMatchObject({ author: 'person', fromName: 'Eve', fromSession: EVE_KEY, fromKey: EVE_KEY, toSession: 'sb', owner: 'ed', state: 'approval' });
    expect(t.get('the same agent again while it waits')).toMatchObject({ ok: false, status: 409 });
    expect(t.get('a request is open') as unknown[]).toHaveLength(1);
    expect(t.get('a request is open')).toMatchObject([{ kind: 'message', owner: 'ed', fromKey: EVE_KEY, by: 'Eve' }]);
    expect((t.get('nothing is handed over yet') as { peerDeliveries: unknown[] }).peerDeliveries).toEqual([]);
    expect((t.get('eve list') as unknown[]).length).toBe(1);
    expect((t.get('ed list') as unknown[]).length).toBe(1);
    expect(t.get('a third person list')).toEqual([]);
    expect((t.get('owner read') as { messages: { text: string }[] }).messages.map((x) => x.text)).toEqual(['hello beta']);
    expect(t.get('reporters grid leaves the person out')).toEqual([]);
    expect(t.get('past the cap')).toMatchObject({ ok: false, status: 429 });
    expect(state('waiting for sx2')).toBe('approval');
    expect(t.get('decline')).toMatchObject({ ok: true });
    expect(t.get('no link after a decline')).toBeNull();
    expect((t.get('after the agent ended') as { messages: { state: string; why: string }[] }).messages.map((x) => [x.state, x.why])).toEqual([['dropped', 'receiver-ended']]);
    expect((t.get('requests after the end') as unknown[]).length).toBe(3);
    expect(t.get('allow')).toMatchObject({ ok: true });
    expect(t.get('the link')).toMatchObject({ from: EVE_KEY, owner: 'ed', level: 'send', paused: false });
    expect(t.get('effective')).toEqual({ level: 'send', paused: false });
    const handed = (t.get('handed over, framed as a person') as { peerDeliveries: { kind: string; text: string; from: { name: string; machine: string; owner: string; person?: boolean } }[] }).peerDeliveries;
    expect(handed.map((d) => [d.text, d.from])).toEqual([['hello beta', { name: 'Eve', machine: '', owner: 'ed', person: true }]]);
    expect(t.get('taken')).toBe('new');
    expect(t.get('sent over the open link')).toMatchObject({ state: 'ready', author: 'person' });
    expect(t.get('the link paused by the sender')).toMatchObject({ paused: true, pausedBy: 'sender' });
    expect(t.get('the link after a resume')).not.toHaveProperty('pausedBy');
    expect(t.get('the link paused by the owner')).toMatchObject({ paused: true, pausedBy: 'owner' });
    expect(t.get('the link paused by the owner')).not.toHaveProperty('pausedByAdmin');
    expect(t.get('the link paused by an Admin')).toMatchObject({ paused: true, pausedBy: 'admin', pausedByAdmin: 'ed' });
    expect(t.get('the link paused by nobody known')).toMatchObject({ paused: true });
    expect(t.get('the link paused by nobody known')).not.toHaveProperty('pausedBy');
    expect(t.get('paused: refused')).toMatchObject({ ok: false, status: 409 });
    expect((t.get('paused: nothing handed over') as { peerDeliveries: unknown[] }).peerDeliveries).toEqual([]);
    expect((t.get('resumed: handed over') as { peerDeliveries: { text: string }[] }).peerDeliveries.map((d) => d.text)).toEqual(['second']);
    expect(t.get('removed: refused')).toMatchObject({ ok: false, status: 403 });
    expect(t.get('remove again')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('pause a removed link')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('a link to ones own agent')).toMatchObject({ ok: false, status: 403 });
    expect(t.get('a link to nobody')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('not a person')).toMatchObject({ ok: false, status: 400 });
    expect(t.get('sent again')).toMatchObject({ state: 'ready' });
    expect((t.get('after retain') as { messages: unknown[] }).messages.length).toBe(3);
    expect((t.get('requests after retain') as unknown[]).length).toBe(2);
    expect(t.get('delete (the person is not the stored owner)')).toBe(0);
    expect(t.get('delete')).toBe(3);
    const left = t.get('eve list after the delete') as { a: { sessionId: string }; b: { sessionId: string } }[];
    expect(left.some((c) => c.a.sessionId === 'sb' || c.b.sessionId === 'sb')).toBe(false);
    expect(left.length).toBeGreaterThan(0);
  });

  it('agrees on every adapter that an allow never lifts a pause on a person\'s link, and that approving a waiting message keeps it paused (#1051)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a } = await setUp(s, clock);
      const m = peers.messages;
      await s.fleet.upsertSession(sess({ id: 'sx1', owner: 'ed' }));
      await peers.note('sx1', a, 'ed', ED_ID, waiting('alpha two', 'box-a'));
      await m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sa', text: 'one' });
      await m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sx1', text: 'two' });
      const [first, second] = (await peers.rights.openRequests(ED_ID)).filter((r) => r.toKey === a);
      await rec('approve the first', peers.answer(first!.id, ED_ID, 'deliver', ED));
      await rec('an Admin pauses the link', peers.setPersonLink(EVE_KEY, a, 'pause', ED, 'admin'));
      await rec('approve the second while paused', peers.answer(second!.id, ED_ID, 'deliver', ED));
      await rec('the link is still paused by the Admin', peers.rights.personLink(EVE_KEY, a));
      await rec('allow while paused', peers.setPersonLink(EVE_KEY, a, 'allow', ED));
      await rec('the link after the allow', peers.rights.personLink(EVE_KEY, a));
      await rec('resume', peers.setPersonLink(EVE_KEY, a, 'resume', ED));
      await rec('allow on an open link', peers.setPersonLink(EVE_KEY, a, 'allow', ED));
      await rec('the sender pauses', peers.setPersonLink(EVE_KEY, a, 'pause', ED, 'sender'));
      await rec('allow after the sender paused', peers.setPersonLink(EVE_KEY, a, 'allow', ED));
      await rec('remove', peers.setPersonLink(EVE_KEY, a, 'resume', ED));
      await rec('removed', peers.setPersonLink(EVE_KEY, a, 'remove', ED));
      await rec('allow after a removal', peers.setPersonLink(EVE_KEY, a, 'allow', ED));
    });
    expect(t.get('approve the first')).toMatchObject({ ok: true });
    expect(t.get('approve the second while paused')).toMatchObject({ ok: true });
    expect(t.get('the link is still paused by the Admin')).toMatchObject({ paused: true, pausedBy: 'admin' });
    expect(t.get('allow while paused')).toMatchObject({ ok: false, status: 409 });
    expect(t.get('the link after the allow')).toMatchObject({ paused: true, pausedBy: 'admin' });
    expect(t.get('allow on an open link')).toMatchObject({ ok: true });
    expect(t.get('allow after the sender paused')).toMatchObject({ ok: false, status: 409 });
    expect(t.get('allow after a removal')).toMatchObject({ ok: true, right: { level: 'send', paused: false } });
  });

  it("agrees on every adapter for an agent answering a person over the link the owner opened: only that link, the same limits, stored delivered (#1034)", async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, b } = await setUp(s, clock);
      const m = peers.messages;
      await rec('nobody wrote yet', m.send('sb', EVE_KEY, 'hi'));
      await m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sb', text: 'hello beta' });
      await rec('while the first message waits for the owner', m.send('sb', EVE_KEY, 'early'));
      const toB = (await peers.rights.openRequests(ED_ID)).find((r) => r.toKey === b)!;
      await peers.answer(toB.id, ED_ID, 'deliver', ED);
      await rec('another agent of the same owner', m.send('sa', EVE_KEY, 'not mine to answer'));
      await rec('a person nobody wrote to', m.send('sb', 'person:zed', 'hi'));
      await rec('empty', m.send('sb', EVE_KEY, ' '));
      await rec('too long', m.send('sb', EVE_KEY, 'x'.repeat(20_001)));
      clock.now += 1;
      await rec('reply', m.send('sb', EVE_KEY, 'here you go'));
      await rec('reply, name in capitals', m.send('sb', 'person:EVE', 'second'));
      await rec('owner read', m.page(ED_ID, EVE_KEY, 'sb', { limit: 10 }));
      await rec('eve list', m.ownerConversations(EVE_ID));
      await rec('nothing is handed to the agent', peers.replyFor('sb', true));
      await rec('requests after the replies', peers.rights.openRequests(ED_ID));
      // A flood of replies reaches the per-minute limit.
      let limited: unknown = null;
      for (let i = 0; i < 40 && !limited; i++) {
        const out = await m.send('sb', EVE_KEY, `flood ${i}`);
        if ('status' in out) limited = out;
      }
      await rec('flood', Promise.resolve(limited));
      clock.now += 120_000;
      await rec('pause', peers.setPersonLink(EVE_KEY, b, 'pause', ED, 'sender'));
      await rec('paused: refused', m.send('sb', EVE_KEY, 'while paused'));
      await rec('resume', peers.setPersonLink(EVE_KEY, b, 'resume', ED));
      await rec('resumed', m.send('sb', EVE_KEY, 'back'));
      await rec('remove', peers.setPersonLink(EVE_KEY, b, 'remove', ED));
      await rec('removed: refused', m.send('sb', EVE_KEY, 'after removal'));
      await rec('open again', peers.setPersonLink(EVE_KEY, b, 'allow', ED));
      // The hourly sweep keeps an answer to a person.
      clock.now += 3_600_000;
      await rec('retain', peers.retain());
      await rec('after retain', m.page(ED_ID, EVE_KEY, 'sb', { limit: 10 }));
      await peers.ended('sb');
      await rec('after the agent ended', m.send('sb', EVE_KEY, 'late'));
      await rec('a conversation read still shows them', m.page(ED_ID, EVE_KEY, 'sb', { limit: 10 }));
    });
    expect(t.get('nobody wrote yet')).toMatchObject({ ok: false, status: 404, error: `You cannot see an orchestrator called ${EVE_KEY}. Run podium_peers for the list.` });
    expect(t.get('while the first message waits for the owner')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('another agent of the same owner')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('a person nobody wrote to')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('empty')).toMatchObject({ ok: false, status: 400 });
    expect(t.get('too long')).toMatchObject({ ok: false, status: 422 });
    expect(t.get('reply')).toMatchObject({ ok: true, state: 'sent', person: true, paused: false, to: { name: 'Eve' } });
    expect(t.get('reply, name in capitals')).toMatchObject({ ok: true });
    const read = t.get('owner read') as { messages: { author: string; state: string; fromSession: string; toSession: string; toKey: string; text: string; owner: string }[] };
    expect(read.messages.map((x) => [x.author, x.state, x.text])).toEqual([['person', 'ready', 'hello beta'], ['agent', 'delivered', 'here you go'], ['agent', 'delivered', 'second']]);
    expect(read.messages[1]).toMatchObject({ fromSession: 'sb', toSession: EVE_KEY, toKey: EVE_KEY, owner: 'ed' });
    expect(t.get('eve list') as unknown[]).toHaveLength(1);
    expect((t.get('nothing is handed to the agent') as { peerDeliveries: { text: string }[] }).peerDeliveries.map((d) => d.text)).toEqual(['hello beta']);
    expect(t.get('requests after the replies') as unknown[]).toHaveLength(0);
    expect(t.get('flood')).toMatchObject({ ok: false, status: 429 });
    expect(t.get('paused: refused')).toMatchObject({ ok: false, status: 409 });
    expect(t.get('resumed')).toMatchObject({ ok: true });
    expect(t.get('removed: refused')).toMatchObject({ ok: false, status: 403 });
    expect(t.get('open again')).toMatchObject({ ok: true });
    expect((t.get('after retain') as { messages: { author: string }[] }).messages.filter((x) => x.author === 'agent').length).toBeGreaterThan(2);
    expect(t.get('after the agent ended')).toMatchObject({ ok: false, status: 403 });
    expect((t.get('a conversation read still shows them') as { messages: unknown[] }).messages.length).toBeGreaterThan(3);
  });

  it("agrees on every adapter that a person's message stored as already delivered is never handed over by the peer path (#1034)", async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers } = await setUp(s, clock);
      const m = peers.messages;
      await rec('stored delivered', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'through the console', state: 'queued' }));
      await rec('idle agent reports: nothing handed over', peers.replyFor('sb', true));
      await rec('stored ready', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'for the peer path' }));
      await rec('idle agent reports: the ready one is handed over', peers.replyFor('sb', true));
    });
    expect(t.get('stored delivered')).toMatchObject({ state: 'queued', text: 'through the console' });
    expect((t.get('idle agent reports: nothing handed over') as { peerDeliveries: unknown[] }).peerDeliveries).toEqual([]);
    expect(t.get('stored ready')).toMatchObject({ state: 'ready' });
    expect((t.get('idle agent reports: the ready one is handed over') as { peerDeliveries: { text: string }[] }).peerDeliveries.map((d) => d.text)).toEqual(['for the peer path']);
  });

  it("agrees on every adapter for an agent answering its own owner's Chat message: only an agent holding one, the same limits, stored delivered in the same conversation (#1034)", async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers } = await setUp(s, clock);
      const m = peers.messages;
      await rec('owner never wrote', m.send('sb', ED_KEY, 'early'));
      await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'status of the build?' });
      await rec('another agent of the owner', m.send('sa', ED_KEY, 'not mine to answer'));
      await rec('a person nobody wrote to', m.send('sb', EVE_KEY, 'hi'));
      await rec('empty', m.send('sb', ED_KEY, ' '));
      await rec('too long', m.send('sb', ED_KEY, 'x'.repeat(20_001)));
      clock.now += 1;
      await rec('reply', m.send('sb', ED_KEY, 'green'));
      await rec('reply, name in capitals', m.send('sb', 'person:ED', 'still green'));
      await rec('owner read', m.page(ED_ID, ED_KEY, 'sb', { limit: 10 }));
      await rec('ed list', m.ownerConversations(ED_ID));
      await rec('the agent lists the owner', m.list('sb'));
      await rec('requests after the replies', peers.rights.openRequests(ED_ID));
      let limited: unknown = null;
      for (let i = 0; i < 40 && !limited; i++) {
        const out = await m.send('sb', ED_KEY, `flood ${i}`);
        if ('status' in out) limited = out;
      }
      await rec('flood', Promise.resolve(limited));
      clock.now += 120_000;
      clock.now += 3_600_000;
      await rec('retain', m.page(ED_ID, ED_KEY, 'sb', { limit: 10 }));
      await rec('deleted', m.deleteConversation(ED_ID, ED_KEY, 'sb'));
      await rec('reply after the conversation was deleted', m.send('sb', ED_KEY, 'late'));
      await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'again' });
      await peers.ended('sb');
      await rec('after the agent ended', m.send('sb', ED_KEY, 'late'));
    });
    expect(t.get('owner never wrote')).toMatchObject({ ok: false, status: 404, error: `You cannot see an orchestrator called ${ED_KEY}. Run podium_peers for the list.` });
    expect(t.get('another agent of the owner')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('a person nobody wrote to')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('empty')).toMatchObject({ ok: false, status: 400 });
    expect(t.get('too long')).toMatchObject({ ok: false, status: 422 });
    expect(t.get('reply')).toMatchObject({ ok: true, state: 'sent', person: true, paused: false, to: { name: 'Ed' } });
    expect(t.get('reply, name in capitals')).toMatchObject({ ok: true });
    const read = t.get('owner read') as { messages: { author: string; state: string; fromSession: string; toSession: string; toKey: string; text: string; owner: string }[] };
    expect(read.messages.map((x) => [x.author, x.state, x.text])).toEqual([['person', 'ready', 'status of the build?'], ['agent', 'delivered', 'green'], ['agent', 'delivered', 'still green']]);
    expect(read.messages[1]).toMatchObject({ fromSession: 'sb', toSession: ED_KEY, toKey: ED_KEY, owner: 'ed' });
    expect(t.get('ed list') as unknown[]).toHaveLength(1);
    expect((t.get('the agent lists the owner') as { people: { address: string; name: string; paused: boolean }[] }).people).toEqual([{ address: ED_KEY, name: 'Ed', paused: false }]);
    expect(t.get('requests after the replies')).toEqual([]);
    expect(t.get('flood')).toMatchObject({ ok: false, status: 429 });
    expect(t.get('retain') as { messages: unknown[] }).toHaveProperty('messages');
    expect(t.get('reply after the conversation was deleted')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('after the agent ended')).toMatchObject({ ok: false });
  });

  // The Chat reads that used to scan every message (#1046): the cost of one pair, or of one person's count, does not grow with the history of the others.
  onEachAdapter(o, 'reads one conversation and the conversation counts without reading the rest of a large history (#1046)', async (s) => {
    const clock = { now: T0 };
    const { peers } = await setUp(s, clock);
    const m = peers.messages;
    const fill = async (to: string, n: number): Promise<void> => {
      for (let i = 0; i < n; i++) await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: to, text: `m ${i}` });
    };
    // The slowest of three rounds of 20 calls is noise; the fastest is the cost.
    const cost = async (): Promise<number> => {
      let best = Infinity;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        for (let i = 0; i < 20; i++) {
          await m.conversationOf(ED_KEY, 'sa');
          await m.conversationCounts([ED_ID, EVE_ID]);
        }
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    await fill('sa', 100);
    const small = await cost();
    await fill('sb', 1500);
    await fill('sc', 1400);
    const large = await cost();
    const one = await m.conversationOf('sa', ED_KEY);
    expect(one).toMatchObject({ messages: 100, owner: 'ed' });
    expect(await m.conversationCounts([ED_ID, EVE_ID])).toEqual({ [ED_ID]: 3, [EVE_ID]: 0 });
    expect((await m.ownerConversations(ED_ID)).length).toBe(3);
    // 30 times the history in other conversations. Reading every message would cost about as many times more; five times is the margin for a slow runner.
    expect(large).toBeLessThan(Math.max(small * 5, 250));
  }, 300_000);

  it('lets a person edit and delete their own direct message while it has not been sent to an agent, whether it waits for approval, is ready, was declined or was dropped, the same on every adapter (#1269)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a } = await setUp(s, clock);
      await s.fleet.upsertSession(sess({ id: 'sd', owner: 'ed' }));
      await peers.note('sd', a, 'ed', ED_ID, waiting('delta2', 'box-a'));
      const m = peers.messages;
      await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'ready one', authorId: ED_ID });
      clock.now += 5;
      const r2 = asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'ready two', authorId: ED_ID }));
      clock.now += 5;
      const r3 = asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'ready three', authorId: ED_ID }));
      const cursor = await rec('page of the newest two, before any change', m.page(ED_ID, ED_KEY, 'sb', { limit: 2 }));
      await rec('edit a ready message', m.editMessage(r2.id, { author: ED_ID, text: 'ready two edited', now: T0 + 100 }));
      await rec('edit it again', m.editMessage(r2.id, { author: ED_ID, text: 'ready two edited again', now: T0 + 200 }));
      await rec('delete a ready message', m.deleteMessage(r3.id, { author: ED_ID, now: T0 + 300 }));
      await rec('the page before the cursor, after the changes', m.page(ED_ID, ED_KEY, 'sb', { before: cursor.older, limit: 2 }));
      await rec('the whole conversation', m.page(ED_ID, ED_KEY, 'sb', { limit: 10 }));
      await rec('the tombstone by id', m.message(r3.id));
      // Waiting for another person's approval: the owner of the agent is asked, and sees the text as it is now.
      const first = asRow(await m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sb', text: 'across one', authorId: EVE_ID }));
      const second = asRow(await m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sa', text: 'across two', authorId: EVE_ID }));
      const third = asRow(await m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sc', text: 'across three', authorId: EVE_ID }));
      const open = await peers.rights.openRequests(ED_ID);
      const requestOf = (id: string): string => open.find((r) => r.messageId === id)!.id;
      await rec('edit a message that waits for approval', m.editMessage(first.id, { author: EVE_ID, text: 'across one edited', now: T0 + 10 }));
      await rec("the owner's view shows the edited text", peers.ownerView(ED_ID, T0 + 11));
      await rec('delete a message that waits for approval', m.deleteMessage(second.id, { author: EVE_ID, now: T0 + 20 }));
      await rec('open requests, the deleted one gone', peers.rights.openRequests(ED_ID));
      await rec('the owner answers the deleted one', peers.answer(requestOf(second.id), ED_ID, 'deliver', ED));
      await rec('the deleted one by id', m.message(second.id));
      // Declined: it never went, so it can still be changed, and it stays declined.
      await rec('decline', peers.answer(requestOf(third.id), ED_ID, 'decline', ED));
      await rec('edit a declined message', m.editMessage(third.id, { author: EVE_ID, text: 'across three edited', now: T0 + 30 }));
      await rec('delete a declined message', m.deleteMessage(third.id, { author: EVE_ID, now: T0 + 40 }));
      // Dropped: its receiver ended first.
      const lost = asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sd', text: 'to a leaver', authorId: ED_ID }));
      await peers.ended('sd');
      await rec('edit a dropped message', m.editMessage(lost.id, { author: ED_ID, text: 'to a leaver edited', now: T0 + 50 }));
      await rec('delete a dropped message', m.deleteMessage(lost.id, { author: ED_ID, now: T0 + 60 }));
      await rec('the conversation with the person (across)', m.page(ED_ID, EVE_KEY, 'sb', { limit: 10 }));
      await rec('the conversation of the leaver', m.conversation(ED_KEY, 'sd'));
    });
    expect(t.get('edit a ready message')).toMatchObject({ ok: true, message: { text: 'ready two edited', editedAt: T0 + 100, deletedAt: null, state: 'ready', sentAt: T0 + 5, authorId: ED_ID, author: 'person', why: null } });
    expect(t.get('edit it again')).toMatchObject({ ok: true, message: { text: 'ready two edited again', editedAt: T0 + 200 } });
    expect(t.get('delete a ready message')).toMatchObject({ ok: true, message: { text: '', deletedAt: T0 + 300, editedAt: null, state: 'dropped', why: 'deleted', sentAt: T0 + 10, authorId: ED_ID, fromName: 'Ed', toSession: 'sb' } });
    const before = t.get('page of the newest two, before any change') as { messages: MessageRow[]; older: string | null };
    const after = t.get('the page before the cursor, after the changes') as { messages: MessageRow[]; older: string | null };
    expect(before.messages.map((x) => x.text)).toEqual(['ready two', 'ready three']);
    expect(after.messages.map((x) => x.text)).toEqual(['ready one']);
    expect((t.get('the whole conversation') as { messages: MessageRow[] }).messages.map((x) => [x.text, x.state, x.editedAt, x.deletedAt])).toEqual([['ready one', 'ready', null, null], ['ready two edited again', 'ready', T0 + 200, null], ['', 'dropped', null, T0 + 300]]);
    expect(t.get('the tombstone by id')).toMatchObject({ text: '', deletedAt: T0 + 300 });
    expect(t.get('edit a message that waits for approval')).toMatchObject({ ok: true, message: { text: 'across one edited', state: 'approval', editedAt: T0 + 10, authorId: EVE_ID, owner: 'ed' } });
    expect((t.get("the owner's view shows the edited text") as { requests: { text: string | null }[] }).requests.map((r) => r.text)).toEqual(['across one edited', 'across two', 'across three']);
    expect(t.get('delete a message that waits for approval')).toMatchObject({ ok: true, message: { text: '', state: 'dropped', why: 'deleted', deletedAt: T0 + 20 } });
    expect((t.get('open requests, the deleted one gone') as { messageId: string }[]).length).toBe(2);
    expect(t.get('the owner answers the deleted one')).toMatchObject({ ok: false, status: 410 });
    expect(t.get('the deleted one by id')).toMatchObject({ text: '', state: 'dropped', why: 'deleted' });
    expect(t.get('edit a declined message')).toMatchObject({ ok: true, message: { text: 'across three edited', state: 'declined', editedAt: T0 + 30 } });
    expect(t.get('delete a declined message')).toMatchObject({ ok: true, message: { text: '', state: 'declined', why: null, deletedAt: T0 + 40, editedAt: T0 + 30 } });
    expect(t.get('edit a dropped message')).toMatchObject({ ok: true, message: { text: 'to a leaver edited', state: 'dropped', why: 'receiver-ended', editedAt: T0 + 50 } });
    expect(t.get('delete a dropped message')).toMatchObject({ ok: true, message: { text: '', state: 'dropped', why: 'receiver-ended', deletedAt: T0 + 60 } });
  });

  it('refuses to change a direct message that is not found, is not the person\'s, is already deleted, or has been sent to an agent, and changes nothing, the same on every adapter (#1269)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight(ED_ID, from, to, 'send', ED);
      const m = peers.messages;
      const change = async (label: string, id: string, who: number): Promise<void> => {
        await rec(`${label}: edit`, m.editMessage(id, { author: who, text: 'changed', now: T0 + 10 }));
        await rec(`${label}: delete`, m.deleteMessage(id, { author: who, now: T0 + 11 }));
      };
      await change('unknown id', 'dlv_000000000000000000000000', ED_ID);
      const mine = asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'mine', authorId: ED_ID }));
      const noId = asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'no author id' }));
      const agent = (await m.send('sa', 'beta@box-b', 'from an agent')) as { id: string };
      const eves = asRow(await m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sc', text: 'from eve', authorId: EVE_ID }));
      await change("another person's id", mine.id, EVE_ID);
      await change('id 0', mine.id, 0);
      await change('an id nobody has', mine.id, 999);
      await change('a person\'s message with no author id (the owner\'s id)', noId.id, ED_ID);
      await change('a person\'s message with no author id (id 0)', noId.id, 0);
      await change("an agent's message", agent.id, ED_ID);
      await change("eve's message, as ed", eves.id, ED_ID);
      await rec('nothing changed', m.conversation(ED_KEY, 'sb'));
      await rec('the agent row is as it was', m.message(agent.id));
      // A tombstone: another change is `deleted`, and someone else's is still `not-yours`.
      await rec('delete mine', m.deleteMessage(mine.id, { author: ED_ID, now: T0 + 20 }));
      await rec('tombstone: edit', m.editMessage(mine.id, { author: ED_ID, text: 'back', now: T0 + 21 }));
      await rec('tombstone: delete', m.deleteMessage(mine.id, { author: ED_ID, now: T0 + 22 }));
      await rec('tombstone of another: edit', m.editMessage(mine.id, { author: EVE_ID, text: 'back', now: T0 + 23 }));
      await rec('tombstone: unchanged', m.message(mine.id));
      // Sent to an agent: queued, handed over, delivered.
      const queued = asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sa', text: 'queued', state: 'queued', authorId: ED_ID }));
      const handed = asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'handed', authorId: ED_ID }));
      await peers.replyFor('sb', true);
      const delivered = asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sc', text: 'delivered', authorId: ED_ID }));
      await peers.replyFor('sc', true);
      await m.result('sc', delivered.id, 'took');
      for (const [label, row] of [['queued', queued], ['handed', handed], ['delivered', delivered]] as const) await change(label, row.id, ED_ID);
      await rec('locked rows are as they were', m.conversation(ED_KEY, 'sa'));
      await rec('locked rows are as they were (handed)', m.message(handed.id));
      await rec('locked rows are as they were (delivered)', m.message(delivered.id));
    });
    const refused = (label: string, reason: string): void => {
      expect(t.get(`${label}: edit`), `${label}: edit`).toEqual({ ok: false, reason });
      expect(t.get(`${label}: delete`), `${label}: delete`).toEqual({ ok: false, reason });
    };
    refused('unknown id', 'not-found');
    refused("another person's id", 'not-yours');
    refused('id 0', 'not-yours');
    refused('an id nobody has', 'not-yours');
    refused("a person's message with no author id (the owner's id)", 'not-yours');
    refused("a person's message with no author id (id 0)", 'not-yours');
    refused("an agent's message", 'not-yours');
    refused("eve's message, as ed", 'not-yours');
    refused('queued', 'locked');
    refused('handed', 'locked');
    refused('delivered', 'locked');
    expect(t.get('delete mine')).toMatchObject({ ok: true });
    expect(t.get('tombstone: edit')).toEqual({ ok: false, reason: 'deleted' });
    expect(t.get('tombstone: delete')).toEqual({ ok: false, reason: 'deleted' });
    expect(t.get('tombstone of another: edit')).toEqual({ ok: false, reason: 'not-yours' });
    expect(t.get('tombstone: unchanged')).toMatchObject({ text: '', deletedAt: T0 + 20, editedAt: null });
    expect((t.get('nothing changed') as MessageRow[]).map((x) => [x.text, x.editedAt, x.deletedAt, x.state])).toEqual([['mine', null, null, 'ready'], ['no author id', null, null, 'ready']]);
    expect(t.get('the agent row is as it was')).toMatchObject({ text: 'from an agent', editedAt: null, deletedAt: null, authorId: null, author: 'agent' });
    expect((t.get('locked rows are as they were') as MessageRow[]).map((x) => [x.text, x.state, x.editedAt, x.deletedAt])).toEqual([['queued', 'queued', null, null]]);
    expect(t.get('locked rows are as they were (handed)')).toMatchObject({ text: 'handed', state: 'handed', editedAt: null, deletedAt: null });
    expect(t.get('locked rows are as they were (delivered)')).toMatchObject({ text: 'delivered', state: 'delivered', editedAt: null, deletedAt: null });
  });

  it('treats a direct message its owner approved as sent to the agent: locked for edit and delete from the approval on, while a ready message that needed no approval can still be changed, the same on every adapter (#1269)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers } = await setUp(s, clock);
      const m = peers.messages;
      const approve = async (id: string): Promise<void> => {
        const request = (await peers.rights.openRequests(ED_ID)).find((r) => r.messageId === id)!.id;
        await peers.answer(request, ED_ID, 'deliver', ED);
      };
      // Approved, not yet fetched by the agent: state ready, approved true.
      const one = asRow(await m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sb', text: 'approved one', authorId: EVE_ID }));
      await rec('edit while waiting for approval', m.editMessage(one.id, { author: EVE_ID, text: 'approved one, edited', now: T0 + 5 }));
      await approve(one.id);
      await rec('approved: the row', m.message(one.id));
      await rec('approved: edit', m.editMessage(one.id, { author: EVE_ID, text: 'a different text', now: T0 + 10 }));
      await rec('approved: delete', m.deleteMessage(one.id, { author: EVE_ID, now: T0 + 11 }));
      await rec('approved: the row afterwards', m.message(one.id));
      // A ready message that needed no approval (the link was already open) can still be changed.
      const open = asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'open link', authorId: ED_ID }));
      await rec('open link: the row', m.message(open.id));
      await rec('open link: edit', m.editMessage(open.id, { author: ED_ID, text: 'open link, edited', now: T0 + 20 }));
      await rec('open link: delete', m.deleteMessage(open.id, { author: ED_ID, now: T0 + 21 }));
    });
    expect(t.get('edit while waiting for approval')).toMatchObject({ ok: true });
    expect(t.get('approved: the row')).toMatchObject({ state: 'ready', approved: true, text: 'approved one, edited' });
    expect(t.get('approved: edit')).toEqual({ ok: false, reason: 'locked' });
    expect(t.get('approved: delete')).toEqual({ ok: false, reason: 'locked' });
    expect(t.get('approved: the row afterwards')).toMatchObject({ state: 'ready', approved: true, text: 'approved one, edited', editedAt: T0 + 5, deletedAt: null });
    expect(t.get('open link: the row')).toMatchObject({ state: 'ready', approved: false });
    expect(t.get('open link: edit')).toMatchObject({ ok: true, message: { text: 'open link, edited', state: 'ready' } });
    expect(t.get('open link: delete')).toMatchObject({ ok: true, message: { text: '', deletedAt: T0 + 21 } });
  });

  it('changes a person\'s message to two agents of a conversation in both of the rows it is stored as, and refuses it as a whole when either has been sent to an agent, the same on every adapter (#1269)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight(ED_ID, from, to, 'send', ED);
      const m = peers.messages;
      const start = (await m.send('sa', 'beta@box-b', 'start')) as { id: string };
      await m.result('sb', start.id, 'took');
      clock.now += 1;
      const both = async (text: string): Promise<[MessageRow, MessageRow]> => [
        asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', withSession: 'sa', text, authorId: ED_ID })),
        asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sa', withSession: 'sb', text, authorId: ED_ID })),
      ];
      const [x1, x2] = await both('both of you');
      await rec('edit by the first row', m.editMessage(x1.id, { author: ED_ID, text: 'both of you, edited', now: T0 + 10 }));
      await rec('after the edit', m.conversation('sa', 'sb'));
      await rec('edit by the second row', m.editMessage(x2.id, { author: ED_ID, text: 'both of you, edited twice', now: T0 + 20 }));
      await rec('edit by someone else', m.editMessage(x2.id, { author: EVE_ID, text: 'x', now: T0 + 21 }));
      await rec('delete by the second row', m.deleteMessage(x2.id, { author: ED_ID, now: T0 + 30 }));
      await rec('after the delete', m.conversation('sa', 'sb'));
      await rec('delete again by the first row', m.deleteMessage(x1.id, { author: ED_ID, now: T0 + 31 }));
      await rec('handed over: neither tombstone', peers.replyFor('sb', true));
      // The same text to two agents more than the window apart is two messages: only the one asked for changes.
      clock.now += 10_000;
      const late1 = asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', withSession: 'sa', text: 'late', authorId: ED_ID }));
      clock.now += 3000;
      await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sa', withSession: 'sb', text: 'late', authorId: ED_ID });
      await rec('edit a message that is two, because of the time between them', m.editMessage(late1.id, { author: ED_ID, text: 'late, edited', now: T0 + 40 }));
      await rec('after the edit of one of two', m.conversation('sa', 'sb'));
      // One of the two rows has been handed over and taken: the message is locked, whichever row is asked for.
      clock.now += 10_000;
      const [y1, y2] = await both('again');
      await peers.replyFor('sb', true);
      await m.result('sb', y1.id, 'took');
      await rec('locked: edit by the row that was taken', m.editMessage(y1.id, { author: ED_ID, text: 'x', now: T0 + 50 }));
      await rec('locked: edit by the other row', m.editMessage(y2.id, { author: ED_ID, text: 'x', now: T0 + 51 }));
      await rec('locked: delete by the other row', m.deleteMessage(y2.id, { author: ED_ID, now: T0 + 52 }));
      await rec('locked: nothing changed', m.conversation('sa', 'sb'));
    });
    const texts = (label: string): unknown[] => (t.get(label) as MessageRow[]).map((x) => [x.text, x.state, x.editedAt, x.deletedAt]);
    expect(t.get('edit by the first row')).toMatchObject({ ok: true, message: { text: 'both of you, edited', editedAt: T0 + 10, toSession: 'sb' } });
    expect(texts('after the edit')).toEqual([['start', 'delivered', null, null], ['both of you, edited', 'ready', T0 + 10, null], ['both of you, edited', 'ready', T0 + 10, null]]);
    expect(t.get('edit by the second row')).toMatchObject({ ok: true, message: { text: 'both of you, edited twice', toSession: 'sa' } });
    expect(t.get('edit by someone else')).toEqual({ ok: false, reason: 'not-yours' });
    expect(t.get('delete by the second row')).toMatchObject({ ok: true, message: { text: '', deletedAt: T0 + 30, state: 'dropped', why: 'deleted', toSession: 'sa' } });
    expect(texts('after the delete')).toEqual([['start', 'delivered', null, null], ['', 'dropped', T0 + 20, T0 + 30], ['', 'dropped', T0 + 20, T0 + 30]]);
    expect(t.get('delete again by the first row')).toEqual({ ok: false, reason: 'deleted' });
    expect((t.get('handed over: neither tombstone') as { peerDeliveries: unknown[] }).peerDeliveries).toEqual([]);
    expect(t.get('edit a message that is two, because of the time between them')).toMatchObject({ ok: true, message: { text: 'late, edited' } });
    expect((t.get('after the edit of one of two') as MessageRow[]).slice(-2).map((x) => [x.text, x.editedAt])).toEqual([['late, edited', T0 + 40], ['late', null]]);
    expect(t.get('locked: edit by the row that was taken')).toEqual({ ok: false, reason: 'locked' });
    expect(t.get('locked: edit by the other row')).toEqual({ ok: false, reason: 'locked' });
    expect(t.get('locked: delete by the other row')).toEqual({ ok: false, reason: 'locked' });
    expect((t.get('locked: nothing changed') as MessageRow[]).slice(-2).map((x) => [x.text, x.state, x.editedAt, x.deletedAt])).toEqual([['again', 'delivered', null, null], ['again', 'ready', null, null]]);
  });

  it('never hands over, asks about or counts a deleted direct message as a new one, lets what it held free its place, and ages it out like any other, the same on every adapter (#1269)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight(ED_ID, from, to, 'send', ED);
      for (const n of [1, 2, 3, 4]) {
        await s.fleet.upsertSession(sess({ id: `sx${n}`, owner: 'ed' }));
        await peers.note(`sx${n}`, a, 'ed', ED_ID, waiting(`extra${n}`, 'box-a'));
      }
      const m = peers.messages;
      const first = (await m.send('sa', 'beta@box-b', 'hello')) as { id: string };
      await m.result('sb', first.id, 'took');
      const secret = asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'secret', authorId: ED_ID }));
      const keep = asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'keep me', authorId: ED_ID }));
      await rec('summary before', m.conversationOf('sa', 'sb'));
      await rec('summary of the person\'s conversation before', m.conversationOf(ED_KEY, 'sb'));
      await m.deleteMessage(secret.id, { author: ED_ID, now: T0 + 5 });
      await rec('summary of the person\'s conversation after', m.conversationOf(ED_KEY, 'sb'));
      await rec('a ready tombstone is not handed over', peers.replyFor('sb', true));
      await rec('result for the tombstone', m.result('sb', secret.id, 'took'));
      await rec('by id', m.message(secret.id));
      await rec('page', m.page(ED_ID, ED_KEY, 'sb', { limit: 10 }));
      await rec('conversations of ed', m.conversations({ ownerId: ED_ID }));
      // Waiting for approval: the request goes with it, and the conversation no longer waits.
      const waits = asRow(await m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sc', text: 'may I?', authorId: EVE_ID }));
      await rec('eve waits', m.ownerConversations(EVE_ID));
      const waitsRequest = (await peers.rights.openRequests(ED_ID)).find((r) => r.messageId === waits.id)!.id;
      await m.deleteMessage(waits.id, { author: EVE_ID, now: T0 + 6 });
      await rec('eve no longer waits', m.ownerConversations(EVE_ID));
      await rec('no request for the owner', peers.rights.openRequests(ED_ID));
      await rec('no request in the owner view', peers.ownerView(ED_ID, T0 + 7));
      await rec('nothing handed over to gamma', peers.replyFor('sc', true));
      await rec('answering the deleted message: deliver', peers.answer(waitsRequest, ED_ID, 'deliver', ED));
      await rec('answering the deleted message: decline', peers.answer(waitsRequest, ED_ID, 'decline', ED));
      await rec('the deleted message is as it was', m.message(waits.id));
      // What a waiting message held is free again: the one waiting message per agent, and the five at one owner.
      const hold = async (to: string, text: string): Promise<unknown> => m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: to, text, authorId: EVE_ID });
      const w1 = asRow(await hold('sa', 'w1'));
      await rec('the same agent again while one waits', hold('sa', 'w1 again'));
      await rec('delete the waiting one', m.deleteMessage(w1.id, { author: EVE_ID, now: T0 + 8 }));
      await rec('the same agent again after the delete', hold('sa', 'w1 again'));
      for (const to of ['sb', 'sc', 'sx1', 'sx2']) await hold(to, `w ${to}`);
      await rec('past the cap of five waiting', hold('sx3', 'one too many'));
      const waiting5 = (await m.page(ED_ID, EVE_KEY, 'sx2', { limit: 5 })).messages[0]!;
      await m.deleteMessage(waiting5.id, { author: EVE_ID, now: T0 + 9 });
      await rec('under the cap after a delete', hold('sx3', 'one too many'));
      // It ages out with the conversation's other messages.
      await rec('conversation before retention', m.conversation(ED_KEY, 'sb'));
      clock.now += 400 * DAY;
      await rec('retain', peers.retain());
      await rec('conversation after retention', m.conversation(ED_KEY, 'sb'));
      await rec('the tombstone after retention', m.message(secret.id));
      await rec('keep me after retention', m.message(keep.id));
    });
    expect(((t.get('a ready tombstone is not handed over') as { peerDeliveries: { text: string }[] }).peerDeliveries).map((d) => d.text)).toEqual(['keep me']);
    expect(t.get('result for the tombstone')).toBe('unknown');
    expect(t.get('by id')).toMatchObject({ text: '', state: 'dropped', why: 'deleted', deletedAt: T0 + 5, authorId: ED_ID });
    const page = t.get('page') as { messages: MessageRow[] };
    expect(page.messages.map((x) => [x.text, x.state])).toEqual([['', 'dropped'], ['keep me', 'handed']]);
    // A tombstone keeps its place in the count of the thread and adds no round trip.
    const was = t.get("summary of the person's conversation before") as { messages: number; roundTrips: { used: number } };
    const now = t.get("summary of the person's conversation after") as { messages: number; roundTrips: { used: number } };
    expect(now.messages).toBe(was.messages);
    expect(now.roundTrips).toEqual(was.roundTrips);
    expect((t.get('eve waits') as { state: string }[]).map((c) => c.state)).toEqual(['waiting']);
    expect((t.get('eve no longer waits') as { state: string }[]).map((c) => c.state)).toEqual(['active']);
    expect(t.get('no request for the owner')).toEqual([]);
    expect((t.get('no request in the owner view') as { requests: unknown[] }).requests).toEqual([]);
    expect((t.get('nothing handed over to gamma') as { peerDeliveries: unknown[] }).peerDeliveries).toEqual([]);
    expect(t.get('answering the deleted message: deliver')).toMatchObject({ ok: false, status: 410 });
    expect(t.get('answering the deleted message: decline')).toMatchObject({ ok: false, status: 410 });
    expect(t.get('the deleted message is as it was')).toMatchObject({ text: '', state: 'dropped', why: 'deleted' });
    expect(t.get('the same agent again while one waits')).toMatchObject({ ok: false, status: 409 });
    expect(t.get('the same agent again after the delete')).toMatchObject({ author: 'person', state: 'approval', text: 'w1 again' });
    expect(t.get('past the cap of five waiting')).toMatchObject({ ok: false, status: 429 });
    expect(t.get('under the cap after a delete')).toMatchObject({ author: 'person', state: 'approval' });
    expect((t.get('retain') as { messages: number }).messages).toBeGreaterThanOrEqual(3);
    expect(t.get('conversation after retention')).toEqual([]);
    expect(t.get('the tombstone after retention')).toBeNull();
    expect(t.get('keep me after retention')).toBeNull();
  });

  it('keeps the id of the person who wrote a direct message, and none for an agent\'s, the same on every adapter (#1269)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight(ED_ID, from, to, 'send', ED);
      const m = peers.messages;
      await rec('with an id', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'with', authorId: ED_ID }));
      await rec('with no id', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'without' }));
      await rec('with a null id', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'null', authorId: null }));
      await rec('across with an id', m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sc', text: 'across', authorId: EVE_ID }));
      await rec('an agent writes', m.send('sa', 'beta@box-b', 'agent'));
      await rec('the person\'s conversation', m.conversation(ED_KEY, 'sb'));
      await rec('the agents\' conversation', m.conversation('sa', 'sb'));
      await rec('page', m.page(ED_ID, ED_KEY, 'sb', { limit: 10 }));
      await rec('summaries (no text, no id leaks)', m.conversations({}));
    });
    expect((t.get("the person's conversation") as MessageRow[]).map((x) => [x.text, x.authorId, x.editedAt, x.deletedAt])).toEqual([['with', ED_ID, null, null], ['without', null, null, null], ['null', null, null, null]]);
    expect(t.get('across with an id')).toMatchObject({ authorId: EVE_ID, author: 'person', state: 'approval' });
    expect((t.get("the agents' conversation") as MessageRow[]).map((x) => [x.text, x.authorId, x.author])).toEqual([['agent', null, 'agent']]);
  });

  onEachAdapter(o, 'decides a delete against a hand-over of the same message in one step: either the message is never handed over, or the delete is refused (#1269)', async (s) => {
    const clock = { now: T0 };
    const { peers } = await setUp(s, clock);
    const m = peers.messages;
    for (const order of ['delete first', 'delete last'] as const) {
      for (const race of ['replyFor', 'result', 'answer'] as const) {
        for (let round = 0; round < 12; round++) {
          const label = `${race}, ${order}, round ${round}`;
          // `answer` races the owner's approval of a message that waits for it; the others race a ready one.
          // An approval opens the link for what Eve writes next, so the approval race runs once for each order, each at an agent of another reporter.
          if (race === 'answer' && round > 0) continue;
          const target = order === 'delete first' ? 'sa' : 'sc';
          const subject = race === 'answer'
            ? asRow(await m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: target, text: `across ${round}`, authorId: EVE_ID }))
            : asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: `ready ${round}`, authorId: ED_ID }));
          const who = race === 'answer' ? EVE_ID : ED_ID;
          const request = race === 'answer' ? (await peers.rights.openRequests(ED_ID)).find((r) => r.messageId === subject.id)!.id : '';
          const del = (): Promise<PeerChange> => m.deleteMessage(subject.id, { author: who, now: T0 + 50 });
          const other = (): Promise<unknown> => (race === 'replyFor' ? peers.replyFor('sb', true) : race === 'result' ? m.result('sb', subject.id, 'queued') : peers.answer(request, ED_ID, 'deliver', ED));
          let change: PeerChange;
          let handedOver: unknown;
          if (order === 'delete first') [change, handedOver] = await Promise.all([del(), other()]);
          else [handedOver, change] = await Promise.all([other(), del()]);
          const row = (await m.message(subject.id))!;
          const texts = race === 'replyFor' ? (handedOver as { peerDeliveries: { text: string }[] }).peerDeliveries.map((d) => d.text) : [];
          if (change.ok) {
            // The delete won: a tombstone, which was not handed over.
            expect(row, label).toMatchObject({ text: '', deletedAt: T0 + 50, state: 'dropped', why: 'deleted' });
            expect(texts, label).not.toContain(subject.text);
          } else {
            // The hand-over won: the message is locked, whole.
            expect(change, label).toEqual({ ok: false, reason: 'locked' });
            expect(row, label).toMatchObject({ text: subject.text, deletedAt: null });
            // An approval locks the message too, before the agent has fetched it.
            expect(['handed', 'queued', 'ready'], label).toContain(row.state);
          }
          // Whatever happened, no tombstone is ever handed over afterwards.
          for (const d of (await peers.replyFor('sb', true)).peerDeliveries) expect(d.text, label).not.toBe('');
        }
      }
    }
  }, 300_000);
  it("refuses an edit over the length limit of the agent's owner in the words a send uses, and changes nothing, on every adapter (#1269)", async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers } = await setUp(s, clock);
      const m = peers.messages;
      await rec('set the limit', peers.setDefaults(ED_ID, { limits: { maxChars: 20 } }, ED));
      const own = asRow(await m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', text: 'short', authorId: ED_ID }));
      const across = asRow(await m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sb', text: 'short too', authorId: EVE_ID }));
      const long = 'x'.repeat(30);
      await rec('send over the limit', m.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sa', text: long, authorId: ED_ID }));
      await rec('send across over the limit', m.sendAcross({ person: 'Eve', personId: EVE_ID, toSession: 'sa', text: long, authorId: EVE_ID }));
      await rec('edit over the limit', m.editMessage(own.id, { author: ED_ID, text: long, now: T0 + 1 }));
      await rec('edit across over the limit', m.editMessage(across.id, { author: EVE_ID, text: long, now: T0 + 2 }));
      await rec('edit by someone else, over the limit', m.editMessage(own.id, { author: EVE_ID, text: long, now: T0 + 3 }));
      await rec('own row is as it was', m.message(own.id));
      await rec('across row is as it was', m.message(across.id));
      await rec('edit at the limit', m.editMessage(own.id, { author: ED_ID, text: 'y'.repeat(20), now: T0 + 4 }));
    });
    expect(t.get('set the limit')).toMatchObject({ ok: true });
    const words = 'The message is 30 characters, over the limit of 20. Send a shorter one.';
    expect(t.get('send over the limit')).toMatchObject({ ok: false, status: 422, error: words });
    expect(t.get('send across over the limit')).toMatchObject({ ok: false, status: 422, error: words });
    expect(t.get('edit over the limit')).toEqual({ ok: false, reason: 'too-long', status: 422, error: words });
    expect(t.get('edit across over the limit')).toEqual({ ok: false, reason: 'too-long', status: 422, error: words });
    expect(t.get('edit by someone else, over the limit')).toEqual({ ok: false, reason: 'not-yours' });
    expect((t.get('own row is as it was') as MessageRow).text).toBe('short');
    expect((t.get('across row is as it was') as MessageRow).text).toBe('short too');
    expect(t.get('edit at the limit')).toMatchObject({ ok: true });
  });

  it('gives every agent an id that is never reused, keeps live names unique per owner, sends to an id, and says an ended agent is no longer available, the same on every adapter (#1284)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight(ED_ID, from, to, 'send', ED);
      const m = peers.messages;
      const ids = (sessions: string[]): unknown => sessions.map((id) => [id, m.live(id)?.agentId ?? null, m.live(id)?.name ?? null]);
      await rec('ids and names, one each', ids(['sa', 'sb', 'sc', 'se']));
      // A second session of the same name on the same machine: it holds "beta 2" and has its own id.
      await s.fleet.upsertSession(sess({ id: 'sb2', owner: 'ed' }));
      await peers.note('sb2', b, 'ed', ED_ID, waiting('beta', 'box-b'));
      await peers.note('sb2', b, 'ed', ED_ID, waiting('beta', 'box-b'));
      await rec('ids and names, a twin', ids(['sb', 'sb2']));
      await rec('list shows the ids', m.list('sa'));
      await rec('send by the id alone', m.send('sa', '#2', 'to the first'));
      await rec('send by name, machine and id', m.send('sa', 'beta 2@box-b#5', 'to the second'));
      await rec('send under another name than the id has', m.send('sa', 'beta@box-b#5', 'wrong'));
      await rec('send to an id nobody has', m.send('sa', '#99', 'nobody'));
      await rec('send to oneself by id', m.send('sa', '#1', 'myself'));
      // The first beta ends; what was aimed at it is not delivered, and a newcomer of its name is a new agent.
      await peers.note('sb', b, 'ed', ED_ID, done('beta', 'box-b'));
      await rec('send to the ended agent', m.send('sa', '#2', 'again'));
      await rec('send to the ended agent by name', m.send('sa', 'beta@box-b#2', 'again'));
      await s.fleet.upsertSession(sess({ id: 'sb3', owner: 'ed' }));
      await peers.note('sb3', b, 'ed', ED_ID, waiting('beta', 'box-b'));
      await rec('ids and names, a newcomer', ids(['sb2', 'sb3']));
      await rec('the newcomer has none of the first one\'s mail', peers.replyFor('sb3', true));
      await rec('the ended agent is still no longer available', m.send('sa', '#2', 'still'));
      await rec('stored messages are bound to agents', (await m.conversation('sa', 'sb')).map((x) => [x.text, x.fromAgent, x.toAgent]));
    });
    expect(t.get('ids and names, one each')).toEqual([['sa', 1, 'alpha'], ['sb', 2, 'beta'], ['sc', 3, 'gamma'], ['se', 4, 'delta']]);
    expect(t.get('ids and names, a twin')).toEqual([['sb', 2, 'beta'], ['sb2', 5, 'beta 2']]);
    expect(t.get('send by the id alone')).toMatchObject({ ok: true, to: { name: 'beta' } });
    expect(t.get('send by name, machine and id')).toMatchObject({ ok: true, to: { name: 'beta 2' } });
    expect(t.get('send under another name than the id has')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('send to an id nobody has')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('send to oneself by id')).toMatchObject({ ok: false, status: 422 });
    expect(t.get('send to the ended agent')).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('(id 2) is no longer available') });
    expect(t.get('ids and names, a newcomer')).toEqual([['sb2', 5, 'beta 2'], ['sb3', 6, 'beta']]);
    expect((t.get('the newcomer has none of the first one\'s mail') as { peerDeliveries: unknown[] }).peerDeliveries).toEqual([]);
    expect(t.get('stored messages are bound to agents')).toEqual([['to the first', 1, 2]]);
  });


  it('gives a person with the same name as a deleted person none of what the deleted person had on the peer tables, and keeps what is the others\', the same on every adapter (#1284)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const ed = (await s.people.createPerson('Ed', null, T0)).person;
      const eve = (await s.people.createPerson('Eve', null, T0)).person;
      const { peers, a, b, c, eve: eveReporter } = await setUp(s, clock, { ed: ed.id, eve: eve.id });
      const m = peers.messages;
      const edEnd = personKeyOf(ed.id);
      const eveEnd = personKeyOf(eve.id);
      // What Ed has: rights, defaults, an open request, a message between his agents and one he wrote, and the end of a link to Eve's agent.
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight(ed.id, from, to, 'send', ED);
      await peers.setDefaults(ed.id, { roundTrips: 3 }, ED);
      await peers.rights.requestAccess({ ownerId: ed.id, fromKey: a, toKey: c, right: 'see', reason: 'look', by: 'alpha', fromSession: 'sa' });
      await m.send('sa', 'beta@box-b', 'agent to agent');
      await m.sendFromPerson({ ownerId: ed.id, person: 'Ed', toSession: 'sb', text: 'from ed' });
      await m.sendAcross({ person: 'Ed', personId: ed.id, toSession: 'se', text: 'hello eve' });
      // Eve wrote to Ed's agent and Ed allowed it, so a link and a conversation of Eve's are Ed's to answer for.
      await m.sendAcross({ person: 'Eve', personId: eve.id, toSession: 'sb', text: 'hi ed' });
      const toB = (await peers.rights.openRequests(ed.id)).find((r) => r.toKey === b && r.kind === 'message')!;
      await peers.answer(toB.id, ed.id, 'deliver', ED);
      // The agent answers a person by the name it was shown or by the key podium_peers lists, and only one who wrote to it is found.
      await rec('answer by name', m.send('sb', 'person:Eve', 'thanks eve'));
      await rec('answer by key', m.send('sb', eveEnd, 'thanks again'));
      await rec('answer to a name nobody wrote to it', m.send('sb', 'person:Zed', 'who'));
      await rec('before: Ed\'s rights', peers.rights.rightsOf(ed.id));
      await rec('before: Eve\'s requests', peers.rights.openRequests(eve.id));
      await rec('before: the link of Eve to Ed\'s agent', peers.rights.personLink(eveEnd, b));
      await rec('delete Ed', s.people.deleteMany([ed.id]).then((r) => r.length));
      const again = (await s.people.createPerson('Ed', null, T0 + 1)).person;
      expect(again.id).not.toBe(ed.id);
      // The newcomer who took the name has none of it, by any read.
      await rec('rights', peers.rights.rightsOf(again.id));
      await rec('rights of the deleted id', peers.rights.rightsOf(ed.id));
      await rec('open requests', peers.rights.openRequests(again.id));
      await rec('defaults', peers.rights.defaults(again.id));
      await rec('defaults of the deleted id', peers.rights.defaults(ed.id));
      await rec('owner view', peers.ownerView(again.id, T0 + 2));
      await rec('conversations', m.ownerConversations(again.id, { includeHidden: true }));
      await rec('counts', m.conversationCounts([again.id, ed.id, eve.id]));
      await rec('conversations (everyone\'s)', m.conversations({ ownerId: again.id }));
      await rec('page of the agents\' conversation', m.page(again.id, 'sa', 'sb', { limit: 50 }));
      await rec('page of the deleted person\'s conversation', m.page(again.id, edEnd, 'sb', { limit: 50 }));
      await rec('delete a conversation of the deleted person', m.deleteConversation(again.id, 'sa', 'sb'));
      await rec('write to Ed\'s agent as its owner', m.sendFromPerson({ ownerId: again.id, person: 'Ed', toSession: 'sb', text: 'mine now' }));
      await rec('the link end of the deleted person', peers.rights.personLink(edEnd, eveReporter));
      await rec('the link end of the newcomer', peers.rights.personLink(personKeyOf(again.id), eveReporter));
      // What was Ed's only is gone; what was Eve's stays, and what Ed had written to Eve's agent is gone with him.
      await rec('Eve\'s requests after', peers.rights.openRequests(eve.id));
      await rec('Eve\'s conversations after', m.ownerConversations(eve.id).then((l) => l.map((x) => [x.a.sessionId, x.b.sessionId, x.messages])));
      // The newcomer writes to Eve's agent as a stranger: nothing of the earlier Ed waits, and the first message asks Eve.
      await rec('the newcomer writes to Eve\'s agent', m.sendAcross({ person: 'Ed', personId: again.id, toSession: 'se', text: 'hello again' }));
      await rec('Eve\'s requests (the newcomer\'s)', peers.rights.openRequests(eve.id).then((l) => l.map((r) => [r.kind, r.fromKey === personKeyOf(again.id), r.by])));
    });
    expect(t.get('answer by name')).toMatchObject({ ok: true, person: true });
    expect(t.get('answer by key')).toMatchObject({ ok: true, person: true });
    expect(t.get('answer to a name nobody wrote to it')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('before: Ed\'s rights') as unknown[]).toHaveLength(2);
    expect(t.get('before: the link of Eve to Ed\'s agent')).not.toBeNull();
    expect(t.get('delete Ed')).toBe(1);
    for (const label of ['rights', 'rights of the deleted id', 'open requests', 'conversations', 'conversations (everyone\'s)']) expect(t.get(label), label).toEqual([]);
    expect(t.get('defaults')).toEqual({ trust: false, onRequest: 'ask', newSend: 'ask', limits: {} });
    expect(t.get('defaults of the deleted id')).toEqual({ trust: false, onRequest: 'ask', newSend: 'ask', limits: {} });
    expect(t.get('counts')).toEqual({ [t.get('counts') ? Object.keys(t.get('counts') as object)[0]! : '']: 0, ...(t.get('counts') as object) });
    expect(Object.values(t.get('counts') as Record<string, number>)).toEqual([0, 0, 0]);
    expect(t.get('page of the agents\' conversation')).toEqual({ messages: [], older: null });
    expect(t.get('page of the deleted person\'s conversation')).toEqual({ messages: [], older: null });
    expect(t.get('delete a conversation of the deleted person')).toBe(0);
    expect(t.get('write to Ed\'s agent as its owner')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('the link end of the deleted person')).toBeNull();
    expect(t.get('the link end of the newcomer')).toBeNull();
    expect(t.get('Eve\'s requests after')).toEqual([]);
    expect(t.get('the newcomer writes to Eve\'s agent')).toMatchObject({ author: 'person', state: 'approval', fromName: 'Ed' });
    expect(t.get('Eve\'s requests (the newcomer\'s)')).toEqual([['message', true, 'Ed']]);
  });

  it('starts a reporter clean when it changes hands: a newcomer with the name of a person who is gone, who reports from the same machine, inherits none of its links, the same on every adapter (#1284)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const ed = (await s.people.createPerson('Ed', null, T0)).person;
      const eve = (await s.people.createPerson('Eve', null, T0)).person;
      // Eve's reporter holds the machine's own key, so Ed's second account on the machine is filed under `<machine>#<name>`, the key a newcomer of his name will meet.
      const own = (name: string, id: number, machine: string, sessionId: string): ReporterSeen => ({ ...seen(machine, `box-${machine}`, name, sessionId, { ed: id, eve: id }), machineId: 'm' });
      await s.reporters.record(own('eve', eve.id, 'm', 'se'), T0);
      const key = await s.reporters.record(own('ed', ed.id, 'm', 'sa'), T0);
      const peers = s.peers({ now: () => clock.now, flagOn: () => true, startedAt: T0 });
      await rec('Ed\'s key', key);
      // A link kept for the reporter with no owner id: a row of nobody's that deleting Ed never removes, as a database upgraded from before ids holds.
      await peers.setPersonLink(personKeyOf(eve.id), key, 'allow', ED);
      await s.people.deleteMany([ed.id]);
      await rec('the reporter after Ed is deleted', s.reporters.peerLookup().get(key).then((r) => r && { owner: r.owner, ownerId: r.ownerId }));
      const again = (await s.people.createPerson('Ed', null, T0 + 1)).person;
      const taken = await s.reporters.record(own('ed', again.id, 'm', 'sa2'), T0 + 2);
      await rec('the newcomer\'s key', taken);
      await rec('the reporter after the newcomer reports', s.reporters.peerLookup().get(key).then((r) => r && { owner: r.owner, ownerId: r.ownerId }));
      await rec('the newcomer\'s reporters', s.reporters.peerLookup().ofOwner(again.id).then((l) => l.map((r) => r.key)));
      await rec('the sessions the reporter had', s.reporters.keysFor({ kind: 'mod', machineId: null, source: '127.0.0.1', sessionId: 'sa', owner: null }));
    });
    // The newcomer is filed under the same key (the path a takeover takes), and the row is the newcomer's now.
    expect(t.get('the newcomer\'s key')).toBe(t.get('Ed\'s key'));
    expect(t.get('the reporter after Ed is deleted')).toMatchObject({ owner: 'ed', ownerId: null });
    expect(t.get('the reporter after the newcomer reports')).toMatchObject({ owner: 'ed' });
    expect((t.get('the newcomer\'s reporters') as string[]).length).toBe(1);
  });
}
