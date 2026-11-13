// Contract cases for orchestrator messaging (#890): the rights between reporters, the owners' defaults and limits, requests for
// access, and the messages, answers, retention and views built on them. Each runs one scenario over every adapter
// (`sameOnAll`). Ids of messages and requests are generated, so they are scrubbed from what is compared and used as they come.
import { it, expect } from 'vitest';
import { sameOnAll, type Openers } from './contractSame.js';
import type { Report } from '../fleet/protocol.js';
import type { Actor } from '../fleet/peerTypes.js';
import type { ReporterSeen } from './rows.js';
import type { PeerStoreApi, Storage } from './types.js';
import { session } from './contract.js';

const T0 = 1_800_000_000_000;
const ED: Actor = { name: 'ed', admin: false };
const ADMIN: Actor = { name: 'Admin', admin: true };
const DAY = 86_400_000;
const HOUR = 3_600_000;
const SERVER_LIMITS = { roundTrips: 10, perMinute: 6, maxChars: 20_000 };

const seen = (id: string, name: string, owner: string, sessionId: string): ReporterSeen => ({
  kind: 'mod', machineId: id, machineName: name, source: '127.0.0.1', owner, credential: 'person', version: '1.2.0', engineVersion: null, sessionId, os: 'macOS', peers: true,
});
const waiting = (name: string, machine: string): Report =>
  ({ session: { name, status: 'waiting', waitReason: 'input', peers: true, repoName: null, projectRoot: '~/dev' }, machine: { name: machine, os: 'macOS' } }) as unknown as Report;
const done = (name: string, machine: string): Report =>
  ({ session: { name, status: 'done', waitReason: null, peers: true, repoName: null, projectRoot: '~/dev' }, machine: { name: machine, os: 'macOS' } }) as unknown as Report;

/** Three reporters of `ed` (each with a waiting orchestrator), one of another owner and one that reports with the admin secret. */
export async function setUp(s: Storage, clock: { now: number }): Promise<{ peers: PeerStoreApi; a: string; b: string; c: string; eve: string }> {
  const peers = s.peers({ now: () => clock.now, flagOn: () => true, startedAt: T0 });
  const a = await s.reporters.record(seen('a', 'box-a', 'ed', 'sa'), T0);
  const b = await s.reporters.record(seen('b', 'box-b', 'ed', 'sb'), T0);
  const c = await s.reporters.record(seen('c', 'box-c', 'ed', 'sc'), T0);
  const eve = await s.reporters.record(seen('e', 'box-e', 'eve', 'se'), T0);
  for (const [id, owner] of [['sa', 'ed'], ['sb', 'ed'], ['sc', 'ed'], ['se', 'eve']] as const) await s.fleet.upsertSession(session({ id, owner }));
  await peers.note('sa', a, 'ed', waiting('alpha', 'box-a'));
  await peers.note('sb', b, 'ed', waiting('beta', 'box-b'));
  await peers.note('sc', c, 'ed', waiting('gamma', 'box-c'));
  await peers.note('se', eve, 'eve', waiting('delta', 'box-e'));
  return { peers, a, b, c, eve };
}

export function peerCases(o: Openers): void {
  it('agrees on every adapter for rights: setting, pausing, removing, proposing and the refusals between owners', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c, eve } = await setUp(s, clock);
      const r = peers.rights;
      await rec('effective (none)', r.effective(a, b));
      await rec('set a to b: send', r.setRight('ed', a, b, 'send', ED));
      await rec('set b to a: see', r.setRight('ed', b, a, 'see', ED));
      await rec('set a to c: ask', r.setRight('ed', a, c, 'ask', ED));
      await rec('set across owners', r.setRight('ed', a, eve, 'see', ED));
      await rec('effective', r.effective(a, b));
      await rec('effective (other way)', r.effective(b, a));
      await rec('rights of ed', r.rightsOf('ed'));
      await rec('rights of ED (any case)', r.rightsOf('ED'));
      await rec('pause link', r.pauseLink('ed', a, b, true, ED));
      await rec('effective (paused)', r.effective(a, b));
      await rec('pause unknown link', r.pauseLink('ed', a, 'nope', true, ED));
      await rec('resume link', r.pauseLink('ed', a, b, false, ED));
      await rec('admin pauses the link', r.pauseLink(null, a, b, true, { name: 'Root', admin: true }));
      await rec('effective (an Admin\'s pause)', r.effective(a, b));
      await rec('rights (an Admin\'s pause)', r.rightsOf('ed'));
      await rec('owner pauses it again', r.pauseLink('ed', a, b, true, ED));
      await rec('effective (still the Admin\'s)', r.effective(b, a));
      await rec('owner resumes (refused)', r.pauseLink('ed', a, b, false, ED));
      await rec('owner resumes the reporter (the Admin\'s pause stays)', r.pauseReporter(a, false, ED));
      await rec('effective (after the reporter resume)', r.effective(a, b));
      await rec('admin resumes the link', r.pauseLink(null, a, b, false, { name: 'Root', admin: true }));
      await rec('effective (resumed)', r.effective(a, b));
      await rec('pause reporter', r.pauseReporter(a, true, ADMIN));
      await rec('effective (the Admin\'s bulk pause)', r.effective(a, b));
      await rec('effective (the Admin\'s bulk pause, the reporter itself)', r.effective(a, a));
      await rec('pause reporter (not admin)', r.pauseReporter(a, true, ED));
      await rec('rights (paused)', r.rightsOf('ed'));
      await rec('owner resumes the reporter (the bulk pause stays)', r.pauseReporter(a, false, ED));
      await rec('effective (after the owner\'s resume of the bulk pause)', r.effective(a, b));
      await rec('resume reporter', r.pauseReporter(a, false, ADMIN));
      await rec('effective (after the Admin\'s bulk resume)', r.effective(a, b));
      await rec('propose', r.propose(b, c, 'see', ADMIN));
      await rec('propose (not admin)', r.propose(b, c, 'see', ED));
      await rec('propose none', r.propose(b, c, 'none', ADMIN));
      await rec('open requests', r.openRequests('ed'));
      await rec('open requests about a', r.openRequests('ed', a));
      await rec('set none', r.setRight('ed', b, a, 'none', ED));
      await rec('rights (after none)', r.rightsOf('ed'));
      await rec('remove link', peers.removeLink('ed', a, b, ED));
      await rec('rights (removed)', r.rightsOf('ed'));
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
      await rec('defaults (fresh)', r.defaults('ed'));
      await rec('limits (fresh)', r.limits('ed', SERVER_LIMITS));
      await rec('set defaults', peers.setDefaults('ed', { roundTrips: 3 }, ED));
      await rec('set defaults over the server limit', peers.setDefaults('ed', { roundTrips: 99 }, ED));
      await rec('set defaults unknown key', peers.setDefaults('ed', { nope: 1 }, ED));
      await rec('defaults', r.defaults('ED'));
      await rec('limits (stricter)', r.limits('ed', SERVER_LIMITS));
      await rec('limits (another owner)', r.limits('eve', SERVER_LIMITS));
      // three requests in the same millisecond, then one later: oldest first, the tie decided by one rule
      await rec('request 1', r.requestAccess({ owner: 'ed', fromKey: a, toKey: b, right: 'see', reason: 'one', by: 'alpha', fromSession: 'sa' }));
      await rec('request 2', r.requestAccess({ owner: 'ed', fromKey: a, toKey: c, right: 'send', reason: 'two', by: 'alpha', fromSession: 'sa' }));
      await rec('request 3', r.requestAccess({ owner: 'ed', fromKey: b, toKey: c, right: 'see', reason: 'three', by: 'beta', fromSession: 'sb' }));
      clock.now += 5;
      await rec('request 4', r.requestAccess({ owner: 'ed', fromKey: c, toKey: a, right: 'see', reason: 'four', by: 'gamma', fromSession: 'sc' }));
      await rec('request again (same pair)', r.requestAccess({ owner: 'ed', fromKey: a, toKey: b, right: 'see', reason: 'one more', by: 'alpha', fromSession: 'sa' }));
      await rec('request across owners', r.requestAccess({ owner: 'ed', fromKey: a, toKey: 'e', right: 'see', reason: 'x', by: 'alpha', fromSession: 'sa' }));
      await rec('open', r.openRequests('ed'));
      await rec('open about c', r.openRequests('ed', c));
      await rec('open (other owner)', r.openRequests('eve'));
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
      for (const [from, to, right, reason] of asks) await rec(`request ${reason}`, r.requestAccess({ owner: 'ed', fromKey: from, toKey: to, right, reason, by: 'x', fromSession: 'sa' }));
      await rec('open', r.openRequests('ed'));
      await rec('open about a', r.openRequests('ed', a));
      clock.now += 1;
      await rec('request later', r.requestAccess({ owner: 'ed', fromKey: b, toKey: a, right: 'see', reason: 'later', by: 'x', fromSession: 'sb' }));
      await rec('open (with a later one)', r.openRequests('ed'));
    });
    const reasons = (t.get('open') as { reason: string }[]).map((x) => x.reason);
    expect(reasons).toEqual(['zulu', 'mike', 'alpha', 'yankee', 'bravo']);
    expect((t.get('open (with a later one)') as { reason: string }[]).map((x) => x.reason).at(-1)).toBe('later');
  });

  it('agrees on every adapter for sending, listing, results and the order of a conversation, through approval and decline', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight('ed', from, to, 'send', ED);
      await peers.rights.setRight('ed', a, c, 'ask', ED);
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
      await rec('conversations (owner)', (await peers.messages.conversations({ owner: 'ed' })));
      await rec('conversations (other owner)', (await peers.messages.conversations({ owner: 'eve' })));
      await rec('conversations (live only)', (await peers.messages.conversations({ liveOnly: true })));
      await rec('conversations (since)', (await peers.messages.conversations({ since: T0 + 1 })));
      await rec('open requests', (await peers.rights.openRequests('ed')));
    });
    expect((t.get('send') as { ok: boolean }).ok).toBe(true);
    expect((t.get('send too long') as { ok: boolean }).ok).toBe(false);
  });

  it('agrees on every adapter for answering a request, a paused answer, replying to a session and what ended or deleted sessions drop', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c } = await setUp(s, clock);
      await peers.rights.setRight('ed', a, b, 'send', ED);
      await peers.rights.setRight('ed', a, c, 'ask', ED);
      const waits = (await peers.messages.send('sa', 'gamma@box-c', 'needs approval')) as { id: string; state: string };
      await rec('send (waits)', (waits));
      const request = await peers.rights.requestAccess({ owner: 'ed', fromKey: b, toKey: c, right: 'see', reason: 'look', by: 'beta', fromSession: 'sb' });
      await rec('access', (request));
      const open = await peers.rights.openRequests('ed');
      await rec('open', (open));
      const [first, second] = open;
      await rec('answer: not the owner', peers.answer(first!.id, 'eve', 'allow', ED));
      await rec('answer: unknown id', peers.answer('nope', 'ed', 'allow', ED));
      await rec('answer: wrong kind', peers.answer(first!.id, 'ed', first!.kind === 'message' ? 'allow' : 'deliver', ED));
      await rec('answer first', (await peers.answer(first!.id, 'ed', first!.kind === 'message' ? 'deliver' : 'allow', ED)));
      await rec('answer again', peers.answer(first!.id, 'ed', 'allow', ED));
      if (second) await rec('answer second (paused)', (await peers.answerPaused(second.id, 'ed', 'decline', ED)));
      await rec('open (after)', (await peers.rights.openRequests('ed')));
      await rec('reply for a (allowed)', (await peers.replyFor('sa', true)));
      await rec('reply for a (not allowed)', (await peers.replyFor('sa', false)));
      await rec('reply for c', (await peers.replyFor('sc', true)));
      await rec('reply for unknown', (await peers.replyFor('nope', true)));
      await peers.note('sb', b, 'ed', done('beta', 'box-b'));
      await rec('live after done', peers.messages.live('sb'));
      await peers.ended('sa');
      await rec('live after ended', peers.messages.live('sa'));
      await rec('conversations', (await peers.messages.conversations({})));
      await peers.deleted(['sc', 'nope']);
      await rec('open (deleted)', (await peers.rights.openRequests('ed')));
      await rec('conversations (deleted)', (await peers.messages.conversations({})));
    });
    expect(t.get('live after ended')).toBeNull();
  });

  it('agrees on every adapter for the owner and admin views, retention, and dropping every held message', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c } = await setUp(s, clock);
      await peers.rights.setRight('ed', a, b, 'send', ED);
      await peers.rights.setRight('ed', b, a, 'send', ED);
      await peers.messages.send('sa', 'beta@box-b', 'hello');
      await peers.messages.send('sb', 'alpha@box-a', 'hi back');
      await peers.rights.requestAccess({ owner: 'ed', fromKey: c, toKey: a, right: 'see', reason: 'look', by: 'gamma', fromSession: 'sc' });
      await rec('owner view', (await peers.ownerView('ed', T0 + 10)));
      await rec('owner view (nobody)', (await peers.ownerView('zed', T0 + 10)));
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
      await peers.rights.setRight('ed', a, b, 'send', ED);
      await peers.rights.setRight('ed', b, a, 'send', ED);
      // A live orchestrator whose id has no sessions row, and whose id differs from the prefix only in case.
      await peers.note('Person:ghost', a, 'ed', waiting('ghost', 'box-a'));
      await rec('send from the look-alike', peers.messages.send('Person:ghost', 'beta@box-b', 'who am I'));
      await rec('person writes', peers.messages.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'sb', text: 'from the person' }));
      await rec('retain', peers.retain());
      await rec('look-alike conversation', peers.messages.conversation('Person:ghost', 'sb'));
      await rec('person conversation', peers.messages.conversation('person:ed', 'sb'));
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
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight('ed', from, to, 'send', ED);
      const m = peers.messages;
      // The first two share a moment, so the insertion number decides their order.
      await rec('send 1', m.send('sa', 'beta@box-b', 'one'));
      await rec('send 2', m.send('sb', 'alpha@box-a', 'two'));
      clock.now += 5;
      await rec('send 3', m.send('sa', 'beta@box-b', 'three'));
      await rec('person adds to it', m.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'sb', withSession: 'sa', text: 'from ed' }));
      await rec('person to one agent', m.sendFromPerson({ owner: 'Ed', person: 'Ed', toSession: 'sb', text: 'just you' }));
      await rec('person: nobody by that id', m.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'nope', text: 'hi' }));
      await rec('person: another owner\'s agent', m.sendFromPerson({ owner: 'eve', person: 'Eve', toSession: 'sb', text: 'hi' }));
      await rec('person: empty', m.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'sb', text: '  ' }));
      await rec('person: too long', m.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'sb', text: 'x'.repeat(20_001) }));
      await rec('person: no conversation with that agent', m.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'sb', withSession: 'sc', text: 'hi' }));
      const p1 = await rec('page 1', m.page('ed', 'sa', 'sb', { limit: 2 }));
      await rec('page 2', m.page('ed', 'sa', 'sb', { before: p1.older, limit: 2 }));
      await rec('page (everything, the pair the other way)', m.page('ed', 'sb', 'sa', { limit: 50 }));
      await rec('page with the person alone', m.page('ed', 'person:ed', 'sb', { limit: 50 }));
      await rec('page (another owner)', m.page('eve', 'sa', 'sb', { limit: 50 }));
      await rec('page (bad cursor)', m.page('ed', 'sa', 'sb', { before: 'junk', limit: 2 }));
      await rec('conversation', m.conversation('sa', 'sb'));
      await rec('deliveries to beta', m.conversation('sb', 'sa'));
      await rec('owner conversations', m.ownerConversations('ed'));
      await rec('owner conversations (another owner)', m.ownerConversations('eve'));
      // The agents leave: the conversation is hidden and kept, not deleted.
      await peers.ended('sa');
      await peers.ended('sb');
      await rec('person: the agent has ended', m.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'sb', text: 'anyone?' }));
      clock.now += 10;
      await rec('hide (another owner)', m.hideConversation('eve', 'sa', 'sb'));
      await rec('hide', m.hideConversation('ed', 'sa', 'sb'));
      await rec('hide again', m.hideConversation('ed', 'sa', 'sb'));
      await rec('owner conversations (hidden left out)', m.ownerConversations('ed'));
      await rec('owner conversations (hidden included)', m.ownerConversations('ed', { includeHidden: true }));
      await rec('page (hidden, still readable)', m.page('ed', 'sa', 'sb', { limit: 1 }));
      await rec('purge (not yet old enough)', m.purgeHidden(clock.now, 10));
      await rec('show', m.showConversation('ed', 'sa', 'sb'));
      await rec('owner conversations (shown)', m.ownerConversations('ed'));
      await rec('purge (nothing hidden)', m.purgeHidden(clock.now + DAY, 0));
      clock.now += 100;
      await m.hideConversation('ed', 'sa', 'sb');
      await rec('purge (a day on)', m.purgeHidden(clock.now + 1, 0));
      await rec('conversation (purged)', m.conversation('sa', 'sb'));
      await rec('owner conversations (purged)', m.ownerConversations('ed', { includeHidden: true }));
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
    expect(t.get('person to one agent')).toMatchObject({ author: 'person', fromName: 'Ed', toSession: 'sb', fromSession: 'person:ed' });
    expect((t.get('owner conversations') as unknown[]).length).toBe(2);
    expect(t.get('owner conversations (another owner)')).toEqual([]);
    expect(t.get('hide (another owner)')).toBe(0);
    expect(t.get('hide')).toBe(4);
    expect(t.get('hide again')).toBe(0);
    expect((t.get('owner conversations (hidden left out)') as { a: { sessionId: string } }[]).map((c) => c.a.sessionId)).toEqual(['person:ed']);
    expect((t.get('owner conversations (hidden included)') as { hiddenAt: number | null }[]).map((c) => c.hiddenAt).sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b))).toEqual([T0 + 15, null]);
    expect(t.get('purge (not yet old enough)')).toBe(0);
    expect(t.get('show')).toBe(4);
    expect((t.get('owner conversations (shown)') as { hiddenAt: number | null }[]).map((c) => c.hiddenAt)).toEqual([null, null]);
    expect(t.get('purge (nothing hidden)')).toBe(0);
    expect(t.get('purge (a day on)')).toBe(4);
    expect(t.get('conversation (purged)')).toEqual([]);
    expect((t.get('owner conversations (purged)') as { a: { sessionId: string } }[]).map((c) => c.a.sessionId)).toEqual(['person:ed']);
  });

  it('keeps a hidden conversation for the longest resume window of its agents, and for the grace period when no window is known (#1113)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight('ed', from, to, 'send', ED);
      const m = peers.messages;
      const windows = async (sa: number | null, sb: number | null) => {
        await s.fleet.upsertSession(session({ id: 'sa', owner: 'ed', resume_window_days: sa }));
        await s.fleet.upsertSession(session({ id: 'sb', owner: 'ed', resume_window_days: sb }));
      };
      // The agents' harnesses let a person resume them for 7 and 3 days, so the conversation stays 7 days, whatever the grace period says.
      await windows(7, 3);
      await m.send('sa', 'beta@box-b', 'one');
      await m.hideConversation('ed', 'sa', 'sb');
      await rec('purge: 2 days on, grace one hour', m.purgeHidden(T0 + 2 * DAY, HOUR));
      await rec('purge: 6 days on', m.purgeHidden(T0 + 6 * DAY, HOUR));
      await rec('conversation kept', m.conversation('sa', 'sb'));
      await rec('purge: past 7 days', m.purgeHidden(T0 + 7 * DAY + 1, HOUR));
      await rec('conversation purged', m.conversation('sa', 'sb'));
      // No window known (a session stored before it was reported): the grace period decides, as before.
      clock.now = T0 + 10 * DAY;
      await windows(null, null);
      await m.send('sa', 'beta@box-b', 'two');
      await m.hideConversation('ed', 'sa', 'sb');
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
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight('ed', from, to, 'send', ED);
      const m = peers.messages;
      await m.send('sa', 'beta@box-b', 'one');
      await rec('after one', m.conversations({ owner: 'ed' }));
      await m.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'sa', withSession: 'sb', text: 'from ed' });
      await rec('after the person', m.conversations({ owner: 'ed' }));
      await m.send('sb', 'alpha@box-a', 'two');
      await rec('after the answer', m.conversations({ owner: 'ed' }));
    });
    const trips = (label: string): number => (t.get(label) as { roundTrips: { used: number } }[])[0]!.roundTrips.used;
    expect([trips('after one'), trips('after the person'), trips('after the answer')]).toEqual([0, 0, 1]);
  });

  it('deletes one conversation\'s messages and no other, and a page cursor outlives the deletion (#1034)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a], [a, c], [c, a]] as const) await peers.rights.setRight('ed', from, to, 'send', ED);
      const m = peers.messages;
      for (const text of ['one', 'two', 'three']) {
        await m.send('sa', 'beta@box-b', text);
        clock.now += 1;
      }
      await m.send('sa', 'gamma@box-c', 'to gamma');
      const p1 = await rec('page 1', m.page('ed', 'sa', 'sb', { limit: 2 }));
      await rec('delete (another owner)', m.deleteConversation('eve', 'sa', 'sb'));
      await rec('delete', m.deleteConversation('ed', 'sb', 'sa'));
      await rec('page 2 after the delete', m.page('ed', 'sa', 'sb', { before: p1.older, limit: 2 }));
      await rec('delete again', m.deleteConversation('ed', 'sa', 'sb'));
      await rec('the other conversation', m.conversation('sa', 'sc'));
      await rec('conversations', m.ownerConversations('ed'));
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
      for (let i = 0; i < 60; i++) await m.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'sa', text: `m${i}`, state: 'queued' });
      clock.now += 5;
      await rec('hide', m.hideConversation('ed', 'person:ed', 'sa'));
      clock.now += 5;
      await m.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'sb', text: 'another conversation', state: 'queued' });
      const list = await rec('with the hidden one', m.ownerConversations('ed', { includeHidden: true }));
      await rec('hidden at', Promise.resolve(list.map((c) => [c.a.sessionId, c.b.sessionId, c.messages, c.hiddenAt])));
      await rec('without the hidden one', m.ownerConversations('ed').then((l) => l.map((c) => [c.a.sessionId, c.b.sessionId])));
    });
    expect(t.get('hide')).toBe(60);
    expect(t.get('hidden at')).toEqual([['person:ed', 'sb', 1, null], ['person:ed', 'sa', 60, T0 + 5]]);
    expect(t.get('without the hidden one')).toEqual([['person:ed', 'sb']]);
  });

  it("agrees on every adapter for a person writing to another person's agent: the request, the link it opens, pausing, removing and the refusals (#1034)", async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c } = await setUp(s, clock);
      // Three more agents of ed on box-a, so a flood can pass the cap on what one person may have waiting.
      for (const n of [1, 2, 3, 4]) {
        await s.fleet.upsertSession(session({ id: `sx${n}`, owner: 'ed' }));
        await peers.note(`sx${n}`, a, 'ed', waiting(`extra${n}`, 'box-a'));
      }
      const m = peers.messages;
      await rec('empty', m.sendAcross({ person: 'Eve', toSession: 'sb', text: ' ' }));
      await rec('nobody by that id', m.sendAcross({ person: 'Eve', toSession: 'nope', text: 'hi' }));
      await rec('too long', m.sendAcross({ person: 'Eve', toSession: 'sb', text: 'x'.repeat(20_001) }));
      await rec("the person's own agent", m.sendAcross({ person: 'Ed', toSession: 'sb', text: 'hi' }));
      const first = await rec('first message waits for approval', m.sendAcross({ person: 'Eve', toSession: 'sb', text: 'hello beta' }));
      await rec('the same agent again while it waits', m.sendAcross({ person: 'EVE', toSession: 'sb', text: 'hello again' }));
      await rec('a request is open', peers.rights.openRequests('ed'));
      await rec('nothing is handed over yet', peers.replyFor('sb', true));
      await rec('eve list', m.ownerConversations('eve'));
      await rec('ed list', m.ownerConversations('ed'));
      await rec('a third person list', m.ownerConversations('zed'));
      await rec('owner read', m.page('ed', 'person:eve', 'sb', { limit: 10 }));
      await rec('reporters grid leaves the person out', peers.rights.rightsOf('ed'));
      // The flood: five waiting at one owner, then refused.
      for (const to of ['sa', 'sc', 'sx1', 'sx2']) await rec(`waiting for ${to}`, m.sendAcross({ person: 'Eve', toSession: to, text: `hi ${to}` }));
      await rec('past the cap', m.sendAcross({ person: 'Eve', toSession: 'sx3', text: 'one too many' }));
      // A decline stores no link and tells the person's side only through the message.
      const toC = (await peers.rights.openRequests('ed')).find((r) => r.toKey === c)!;
      await rec('decline', peers.answer(toC.id, 'ed', 'decline', ED));
      await rec('no link after a decline', peers.rights.personLink('person:eve', c));
      // An agent that ends with a request open drops it.
      await peers.ended('sa');
      await rec('after the agent ended', m.page('ed', 'person:eve', 'sa', { limit: 10 }));
      await rec('requests after the end', peers.rights.openRequests('ed'));
      // An allow opens the link and delivers.
      const toB = (await peers.rights.openRequests('ed')).find((r) => r.toKey === b)!;
      await rec('request view', peers.ownerView('ed', T0));
      await rec('allow', peers.answer(toB.id, 'ed', 'deliver', ED));
      await rec('the link', peers.rights.personLink('person:eve', b));
      await rec('effective', peers.rights.effective('person:eve', b));
      await rec('handed over, framed as a person', peers.replyFor('sb', true));
      await rec('taken', m.result('sb', (first as { id: string }).id, 'took'));
      await rec('sent over the open link', m.sendAcross({ person: 'Eve', toSession: 'sb', text: 'second' }));
      await rec('pause', peers.setPersonLink('person:eve', b, 'pause', ED, 'sender'));
      await rec('the link paused by the sender', peers.rights.personLink('person:eve', b));
      await rec('paused: refused', m.sendAcross({ person: 'Eve', toSession: 'sb', text: 'third' }));
      await rec('paused: nothing handed over', peers.replyFor('sb', true));
      await rec('resume', peers.setPersonLink('person:eve', b, 'resume', ED));
      await rec('resumed: handed over', peers.replyFor('sb', true));
      await rec('the link after a resume', peers.rights.personLink('person:eve', b));
      await rec('pause by the owner', peers.setPersonLink('person:eve', b, 'pause', ED, 'owner'));
      await rec('the link paused by the owner', peers.rights.personLink('person:eve', b));
      await rec('pause by an Admin', peers.setPersonLink('person:eve', b, 'pause', ED, 'admin'));
      await rec('the link paused by an Admin', peers.rights.personLink('person:eve', b));
      await rec('pause with no pauser', peers.setPersonLink('person:eve', b, 'pause', ED));
      await rec('the link paused by nobody known', peers.rights.personLink('person:eve', b));
      await rec('resume again', peers.setPersonLink('person:eve', b, 'resume', ED));
      await rec('remove', peers.setPersonLink('person:eve', b, 'remove', ED));
      await rec('removed: refused', m.sendAcross({ person: 'Eve', toSession: 'sb', text: 'fourth' }));
      await rec('remove again', peers.setPersonLink('person:eve', b, 'remove', ED));
      await rec('pause a removed link', peers.setPersonLink('person:eve', b, 'pause', ED));
      await rec('a link to ones own agent', peers.setPersonLink('person:ed', b, 'allow', ED));
      await rec('a link to nobody', peers.setPersonLink('person:eve', 'nope', 'allow', ED));
      await rec('not a person', peers.setPersonLink('eve', b, 'allow', ED));
      await rec('open it again', peers.setPersonLink('person:eve', b, 'allow', ED));
      await rec('sent again', m.sendAcross({ person: 'Eve', toSession: 'sb', text: 'fifth' }));
      // The hourly sweep keeps a person's messages and an open request.
      clock.now += 3_600_000;
      await rec('retain', peers.retain());
      await rec('after retain', m.page('ed', 'person:eve', 'sb', { limit: 10 }));
      await rec('requests after retain', peers.rights.openRequests('ed'));
      await rec('delete (the person is not the stored owner)', m.deleteConversation('eve', 'person:eve', 'sb'));
      await rec('delete', m.deleteConversation('ed', 'person:eve', 'sb'));
      await rec('eve list after the delete', m.ownerConversations('eve'));
    });
    const state = (label: string) => (t.get(label) as { state: string }).state;
    expect(t.get('empty')).toMatchObject({ ok: false, status: 400 });
    expect(t.get('nobody by that id')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('too long')).toMatchObject({ ok: false, status: 422 });
    expect(t.get("the person's own agent")).toMatchObject({ ok: false, status: 422 });
    expect(t.get('first message waits for approval')).toMatchObject({ author: 'person', fromName: 'Eve', fromSession: 'person:eve', fromKey: 'person:eve', toSession: 'sb', owner: 'ed', state: 'approval' });
    expect(t.get('the same agent again while it waits')).toMatchObject({ ok: false, status: 409 });
    expect(t.get('a request is open') as unknown[]).toHaveLength(1);
    expect(t.get('a request is open')).toMatchObject([{ kind: 'message', owner: 'ed', fromKey: 'person:eve', by: 'Eve' }]);
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
    expect(t.get('the link')).toMatchObject({ from: 'person:eve', owner: 'ed', level: 'send', paused: false });
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
      await s.fleet.upsertSession(session({ id: 'sx1', owner: 'ed' }));
      await peers.note('sx1', a, 'ed', waiting('alpha two', 'box-a'));
      await m.sendAcross({ person: 'Eve', toSession: 'sa', text: 'one' });
      await m.sendAcross({ person: 'Eve', toSession: 'sx1', text: 'two' });
      const [first, second] = (await peers.rights.openRequests('ed')).filter((r) => r.toKey === a);
      await rec('approve the first', peers.answer(first!.id, 'ed', 'deliver', ED));
      await rec('an Admin pauses the link', peers.setPersonLink('person:eve', a, 'pause', ED, 'admin'));
      await rec('approve the second while paused', peers.answer(second!.id, 'ed', 'deliver', ED));
      await rec('the link is still paused by the Admin', peers.rights.personLink('person:eve', a));
      await rec('allow while paused', peers.setPersonLink('person:eve', a, 'allow', ED));
      await rec('the link after the allow', peers.rights.personLink('person:eve', a));
      await rec('resume', peers.setPersonLink('person:eve', a, 'resume', ED));
      await rec('allow on an open link', peers.setPersonLink('person:eve', a, 'allow', ED));
      await rec('the sender pauses', peers.setPersonLink('person:eve', a, 'pause', ED, 'sender'));
      await rec('allow after the sender paused', peers.setPersonLink('person:eve', a, 'allow', ED));
      await rec('remove', peers.setPersonLink('person:eve', a, 'resume', ED));
      await rec('removed', peers.setPersonLink('person:eve', a, 'remove', ED));
      await rec('allow after a removal', peers.setPersonLink('person:eve', a, 'allow', ED));
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
      await rec('nobody wrote yet', m.send('sb', 'person:eve', 'hi'));
      await m.sendAcross({ person: 'Eve', toSession: 'sb', text: 'hello beta' });
      await rec('while the first message waits for the owner', m.send('sb', 'person:eve', 'early'));
      const toB = (await peers.rights.openRequests('ed')).find((r) => r.toKey === b)!;
      await peers.answer(toB.id, 'ed', 'deliver', ED);
      await rec('another agent of the same owner', m.send('sa', 'person:eve', 'not mine to answer'));
      await rec('a person nobody wrote to', m.send('sb', 'person:zed', 'hi'));
      await rec('empty', m.send('sb', 'person:eve', ' '));
      await rec('too long', m.send('sb', 'person:eve', 'x'.repeat(20_001)));
      clock.now += 1;
      await rec('reply', m.send('sb', 'person:eve', 'here you go'));
      await rec('reply, name in capitals', m.send('sb', 'person:EVE', 'second'));
      await rec('owner read', m.page('ed', 'person:eve', 'sb', { limit: 10 }));
      await rec('eve list', m.ownerConversations('eve'));
      await rec('nothing is handed to the agent', peers.replyFor('sb', true));
      await rec('requests after the replies', peers.rights.openRequests('ed'));
      // A flood of replies reaches the per-minute limit.
      let limited: unknown = null;
      for (let i = 0; i < 40 && !limited; i++) {
        const out = await m.send('sb', 'person:eve', `flood ${i}`);
        if ('status' in out) limited = out;
      }
      await rec('flood', Promise.resolve(limited));
      clock.now += 120_000;
      await rec('pause', peers.setPersonLink('person:eve', b, 'pause', ED, 'sender'));
      await rec('paused: refused', m.send('sb', 'person:eve', 'while paused'));
      await rec('resume', peers.setPersonLink('person:eve', b, 'resume', ED));
      await rec('resumed', m.send('sb', 'person:eve', 'back'));
      await rec('remove', peers.setPersonLink('person:eve', b, 'remove', ED));
      await rec('removed: refused', m.send('sb', 'person:eve', 'after removal'));
      await rec('open again', peers.setPersonLink('person:eve', b, 'allow', ED));
      // The hourly sweep keeps an answer to a person.
      clock.now += 3_600_000;
      await rec('retain', peers.retain());
      await rec('after retain', m.page('ed', 'person:eve', 'sb', { limit: 10 }));
      await peers.ended('sb');
      await rec('after the agent ended', m.send('sb', 'person:eve', 'late'));
      await rec('a conversation read still shows them', m.page('ed', 'person:eve', 'sb', { limit: 10 }));
    });
    expect(t.get('nobody wrote yet')).toMatchObject({ ok: false, status: 404, error: 'You cannot see an orchestrator called person:eve. Run podium_peers for the list.' });
    expect(t.get('while the first message waits for the owner')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('another agent of the same owner')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('a person nobody wrote to')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('empty')).toMatchObject({ ok: false, status: 400 });
    expect(t.get('too long')).toMatchObject({ ok: false, status: 422 });
    expect(t.get('reply')).toMatchObject({ ok: true, state: 'sent', person: true, paused: false, to: { name: 'Eve' } });
    expect(t.get('reply, name in capitals')).toMatchObject({ ok: true });
    const read = t.get('owner read') as { messages: { author: string; state: string; fromSession: string; toSession: string; toKey: string; text: string; owner: string }[] };
    expect(read.messages.map((x) => [x.author, x.state, x.text])).toEqual([['person', 'ready', 'hello beta'], ['agent', 'delivered', 'here you go'], ['agent', 'delivered', 'second']]);
    expect(read.messages[1]).toMatchObject({ fromSession: 'sb', toSession: 'person:eve', toKey: 'person:eve', owner: 'ed' });
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
      await rec('stored delivered', m.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'sb', text: 'through the console', state: 'queued' }));
      await rec('idle agent reports: nothing handed over', peers.replyFor('sb', true));
      await rec('stored ready', m.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'sb', text: 'for the peer path' }));
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
      await rec('owner never wrote', m.send('sb', 'person:ed', 'early'));
      await m.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'sb', text: 'status of the build?' });
      await rec('another agent of the owner', m.send('sa', 'person:ed', 'not mine to answer'));
      await rec('a person nobody wrote to', m.send('sb', 'person:eve', 'hi'));
      await rec('empty', m.send('sb', 'person:ed', ' '));
      await rec('too long', m.send('sb', 'person:ed', 'x'.repeat(20_001)));
      clock.now += 1;
      await rec('reply', m.send('sb', 'person:ed', 'green'));
      await rec('reply, name in capitals', m.send('sb', 'person:ED', 'still green'));
      await rec('owner read', m.page('ed', 'person:ed', 'sb', { limit: 10 }));
      await rec('ed list', m.ownerConversations('ed'));
      await rec('the agent lists the owner', m.list('sb'));
      await rec('requests after the replies', peers.rights.openRequests('ed'));
      let limited: unknown = null;
      for (let i = 0; i < 40 && !limited; i++) {
        const out = await m.send('sb', 'person:ed', `flood ${i}`);
        if ('status' in out) limited = out;
      }
      await rec('flood', Promise.resolve(limited));
      clock.now += 120_000;
      clock.now += 3_600_000;
      await rec('retain', m.page('ed', 'person:ed', 'sb', { limit: 10 }));
      await rec('deleted', m.deleteConversation('ed', 'person:ed', 'sb'));
      await rec('reply after the conversation was deleted', m.send('sb', 'person:ed', 'late'));
      await m.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'sb', text: 'again' });
      await peers.ended('sb');
      await rec('after the agent ended', m.send('sb', 'person:ed', 'late'));
    });
    expect(t.get('owner never wrote')).toMatchObject({ ok: false, status: 404, error: 'You cannot see an orchestrator called person:ed. Run podium_peers for the list.' });
    expect(t.get('another agent of the owner')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('a person nobody wrote to')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('empty')).toMatchObject({ ok: false, status: 400 });
    expect(t.get('too long')).toMatchObject({ ok: false, status: 422 });
    expect(t.get('reply')).toMatchObject({ ok: true, state: 'sent', person: true, paused: false, to: { name: 'Ed' } });
    expect(t.get('reply, name in capitals')).toMatchObject({ ok: true });
    const read = t.get('owner read') as { messages: { author: string; state: string; fromSession: string; toSession: string; toKey: string; text: string; owner: string }[] };
    expect(read.messages.map((x) => [x.author, x.state, x.text])).toEqual([['person', 'ready', 'status of the build?'], ['agent', 'delivered', 'green'], ['agent', 'delivered', 'still green']]);
    expect(read.messages[1]).toMatchObject({ fromSession: 'sb', toSession: 'person:ed', toKey: 'person:ed', owner: 'ed' });
    expect(t.get('ed list') as unknown[]).toHaveLength(1);
    expect((t.get('the agent lists the owner') as { people: { address: string; name: string; paused: boolean }[] }).people).toEqual([{ address: 'person:ed', name: 'Ed', paused: false }]);
    expect(t.get('requests after the replies')).toEqual([]);
    expect(t.get('flood')).toMatchObject({ ok: false, status: 429 });
    expect(t.get('retain') as { messages: unknown[] }).toHaveProperty('messages');
    expect(t.get('reply after the conversation was deleted')).toMatchObject({ ok: false, status: 404 });
    expect(t.get('after the agent ended')).toMatchObject({ ok: false });
  });
}
