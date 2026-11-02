// Contract cases for orchestrator messaging (#890): the rights between reporters, the owners' defaults and limits, requests for
// access, and the messages, answers, retention and views built on them. Each runs one scenario over the adapter and over the the reference
// reference (`sameOnBoth`). Ids of messages and requests are generated, so they are scrubbed from what is compared and used as they come.
import { it, expect } from 'vitest';
import { sameOnBoth, type Openers } from './contractSame.js';
import type { Report } from '../fleet/protocol.js';
import type { Actor } from '../fleet/peerTypes.js';
import type { ReporterSeen } from './rows.js';
import type { PeerStoreApi, Storage } from './types.js';
import { session } from './contract.js';

const T0 = 1_800_000_000_000;
const ED: Actor = { name: 'ed', admin: false };
const ADMIN: Actor = { name: 'Admin', admin: true };
const SERVER_LIMITS = { roundTrips: 10, perMinute: 6, maxChars: 20_000 };

const seen = (id: string, name: string, owner: string, sessionId: string): ReporterSeen => ({
  kind: 'mod', machineId: id, machineName: name, source: '127.0.0.1', owner, credential: 'person', version: '1.2.0', engineVersion: null, sessionId, os: 'macOS', peers: true,
});
const waiting = (name: string, machine: string): Report =>
  ({ session: { name, status: 'waiting', waitReason: 'input', peers: true, repoName: null, projectRoot: '~/dev' }, machine: { name: machine, os: 'macOS' } }) as unknown as Report;
const done = (name: string, machine: string): Report =>
  ({ session: { name, status: 'done', waitReason: null, peers: true, repoName: null, projectRoot: '~/dev' }, machine: { name: machine, os: 'macOS' } }) as unknown as Report;

/** Three reporters of `ed` (each with a waiting orchestrator), one of another owner and one that reports with the admin secret. */
async function setUp(s: Storage, clock: { now: number }): Promise<{ peers: PeerStoreApi; a: string; b: string; c: string; eve: string }> {
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
  it('matches the reference for rights: setting, pausing, removing, proposing and the refusals between owners', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
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
      await rec('pause reporter', r.pauseReporter(a, true, ADMIN));
      await rec('pause reporter (not admin)', r.pauseReporter(a, true, ED));
      await rec('rights (paused)', r.rightsOf('ed'));
      await rec('resume reporter', r.pauseReporter(a, false, ADMIN));
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
  });

  it('matches the reference for owner defaults and limits, and for requests for access in the order they were opened', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
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
    const t = await sameOnBoth(o, async (s, rec) => {
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

  it('matches the reference for sending, listing, results and the order of a conversation, through approval and decline', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
      const clock = { now: T0 };
      const { peers, a, b, c } = await setUp(s, clock);
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight('ed', from, to, 'send', ED);
      await peers.rights.setRight('ed', a, c, 'ask', ED);
      await rec('list for alpha', peers.messages.list('sa'));
      await rec('live', peers.messages.live('sa'));
      await rec('live (unknown)', peers.messages.live('nope'));
      const one = await peers.messages.send('sa', 'beta@box-b', 'one');
      await rec('send', (one));
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

  it('matches the reference for answering a request, a paused answer, replying to a session and what ended or deleted sessions drop', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
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

  it('matches the reference for the owner and admin views, retention, and dropping every held message', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
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
}
