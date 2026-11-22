// Who an orchestrator can reach, decided from what the adapter read (#1296): whose reporter an orchestrator is on, which ones to read rights for, who is reached, how each is listed and why a machine is left out.
import { describe, expect, it } from 'vitest';
import type { EffectiveRight, LiveOrchestrator, ReporterRef } from '../fleet/peerTypes.js';
import { leftOutWhy, listingOf, mayBeLeftOut, onPersonReporter, reachedOf, rightKeys, sameOwnerOn, sortListings } from './peerReach.js';

const orch = (over: Partial<LiveOrchestrator>): LiveOrchestrator => ({
  sessionId: 's', reporterKey: 'ka', owner: 'ed', ownerId: 11, agentId: 1, name: 'alpha', machine: 'box-a', os: null, project: '~/dev', status: 'running', waitReason: null, peers: true, ...over,
});
const rep = (over: Partial<ReporterRef>): ReporterRef => ({ key: 'ka', machine: 'box-a', owner: 'ed', ownerId: 11, adminSecret: false, os: null, peers: true, version: '1.0.0', reporterName: 'podium-reporter', ...over }) as ReporterRef;
const right = (level: EffectiveRight['level'], paused = false): EffectiveRight => ({ level, paused });

describe('onPersonReporter', () => {
  it('needs a reporter that is known, not on the admin secret and filed under the orchestrator\'s own person', () => {
    expect(onPersonReporter(orch({}), rep({}))).toBe(true);
    expect(onPersonReporter(orch({}), undefined)).toBe(false);
    expect(onPersonReporter(orch({}), null)).toBe(false);
    expect(onPersonReporter(orch({}), rep({ adminSecret: true }))).toBe(false);
    expect(onPersonReporter(orch({}), rep({ ownerId: 12 }))).toBe(false);
    expect(onPersonReporter(orch({ ownerId: null }), rep({ ownerId: null }))).toBe(false);
  });
});

describe('sameOwnerOn', () => {
  it('keeps the live orchestrators of the sender\'s person with messaging on, and none for a sender with no person', () => {
    const sender = orch({ sessionId: 'a' });
    const live = [sender, orch({ sessionId: 'b' }), orch({ sessionId: 'c', ownerId: 12 }), orch({ sessionId: 'd', peers: false })];
    expect(sameOwnerOn(sender, live).map((o) => o.sessionId)).toEqual(['a', 'b']);
    expect(sameOwnerOn(orch({ ownerId: null }), live)).toEqual([]);
  });
});

describe('rightKeys and reachedOf', () => {
  const sender = orch({ sessionId: 'a', reporterKey: 'ka' });
  const b = orch({ sessionId: 'b', reporterKey: 'kb' });
  const adm = orch({ sessionId: 'c', reporterKey: 'kc' });
  const twin = orch({ sessionId: 'd', reporterKey: 'kb' });
  const candidates = [sender, b, adm, twin];
  const reporters = new Map([rep({ key: 'ka' }), rep({ key: 'kb' }), rep({ key: 'kc', adminSecret: true })].map((r) => [r.key, r]));

  it('asks for the right to each other orchestrator on a person\'s reporter once, and for the extra keys', () => {
    expect(rightKeys(sender, candidates, reporters)).toEqual(['kb']);
    expect(rightKeys(sender, candidates, reporters, ['kx', 'kb'])).toEqual(['kb', 'kx']);
  });

  it('reaches the sender itself, and the others whose right is not none', () => {
    const rights = new Map([['kb', right('see')]]);
    expect(reachedOf(sender, candidates, { reporters, rights }).map((o) => o.sessionId)).toEqual(['a', 'b', 'd']);
    expect(reachedOf(sender, candidates, { reporters, rights: new Map([['kb', right('none')]]) }).map((o) => o.sessionId)).toEqual(['a']);
  });
});

describe('listingOf and sortListings', () => {
  it('lists an orchestrator by its address and id with the level and the pause, in the order of address then id', () => {
    const one = listingOf(orch({ agentId: 7, name: 'Beta', machine: 'm' }), right('ask', true));
    expect(one).toEqual({ address: 'Beta@m', id: '7', name: 'Beta', machine: 'm', os: null, project: '~/dev', status: 'running', level: 'ask', paused: true });
    const two = listingOf(orch({ agentId: 10, name: 'Beta', machine: 'm' }), right('send'));
    const first = listingOf(orch({ agentId: 2, name: 'Alpha', machine: 'm' }), right('send'));
    expect(sortListings([two, one, first]).map((l) => l.id)).toEqual(['2', '10', '7']);
  });
});

describe('mayBeLeftOut and leftOutWhy', () => {
  it('leaves out the admin secret\'s reporter and the sender\'s own, and gives a reason for the rest', () => {
    const sender = orch({ reporterKey: 'ka' });
    expect(mayBeLeftOut(rep({ key: 'ka' }), sender)).toBe(false);
    expect(mayBeLeftOut(rep({ key: 'kb', adminSecret: true }), sender)).toBe(false);
    expect(mayBeLeftOut(rep({ key: 'kb' }), sender)).toBe(true);
    expect(leftOutWhy(rep({ peers: null }), undefined)).toBe('reporter too old to message');
    expect(leftOutWhy(rep({ peers: false }), right('send'))).toBe('messaging off on the machine');
    expect(leftOutWhy(rep({}), right('none'))).toBe('no right to see it');
    expect(leftOutWhy(rep({}), right('see'))).toBe('no orchestrator running');
  });
});
