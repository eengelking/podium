// A conversation's summary from its messages (#1309): the two ends and the names they carry, the links whose rights a list needs, and the summary those rights make.
import { describe, expect, it } from 'vitest';
import type { MessageRow } from '../fleet/peerTypes.js';
import { headOf, linksOf, pairsOf, toSummary } from './peerSummary.js';

const msg = (over: Partial<MessageRow>): MessageRow => ({
  id: 'm', owner: 'ed', ownerId: 11, link: 'a|b', fromKey: 'ka', toKey: 'kb', fromSession: 'sa', toSession: 'sb', fromAgent: null, toAgent: null,
  fromName: 'alpha', fromMachine: 'box-a', toName: 'beta', toMachine: 'box-b', text: '', sentAt: 1000, state: 'delivered', stateAt: 1000, why: null, approved: false,
  author: 'agent', authorId: null, editedAt: null, deletedAt: null, ...over,
});

describe('headOf', () => {
  it('orders the two ends by session id and takes the names of the newest agent message', () => {
    const g = [msg({ sentAt: 1 }), msg({ fromSession: 'sb', toSession: 'sa', fromKey: 'kb', toKey: 'ka', fromName: 'beta2', toName: 'alpha2', fromMachine: 'box-b', toMachine: 'box-a', sentAt: 2 })];
    const h = headOf(g);
    expect(h.a).toEqual({ sessionId: 'sa', name: 'alpha2', machine: 'box-a', reporterKey: 'ka' });
    expect(h.b).toEqual({ sessionId: 'sb', name: 'beta2', machine: 'box-b', reporterKey: 'kb' });
    expect(h.named).toBe(g[1]);
  });

  it('skips a person\'s message for the names, and falls back to the last message when none is an agent\'s', () => {
    const agent = msg({ sentAt: 1 });
    const person = msg({ author: 'person', fromName: 'Ed', fromSession: 'person:11', fromKey: 'person:11', sentAt: 2 });
    expect(headOf([agent, person]).named).toBe(agent);
    expect(headOf([person]).named).toBe(person);
    expect(headOf([person]).a.sessionId).toBe('person:11');
  });
});

describe('linksOf', () => {
  it('is the link of each direction, a to b and b to a', () => {
    expect(linksOf(headOf([msg({})]))).toEqual([['ka', 'kb'], ['kb', 'ka']]);
  });
});

describe('toSummary', () => {
  const g = [msg({ sentAt: 5 }), msg({ sentAt: 9, id: 'm2' })];
  const open = { level: 'send', paused: false } as const;

  it('puts the rights, the message count, the last time and the cap into the summary', () => {
    expect(toSummary(g, headOf(g), open, { level: 'see', paused: false }, 3)).toEqual({
      link: 'a|b', a: headOf(g).a, b: headOf(g).b, owner: 'ed', ownerId: 11, messages: 2, lastAt: 9, state: 'active', paused: false,
      aToB: true, bToA: false, roundTrips: { used: 0, cap: 3 },
    });
  });

  it('is waiting when a message waits for approval, and paused, with who paused it, when either direction is', () => {
    const waiting = [...g, msg({ state: 'approval', id: 'm3' })];
    expect(toSummary(waiting, headOf(waiting), open, open, 10).state).toBe('waiting');
    const paused = toSummary(g, headOf(g), open, { level: 'send', paused: true, pausedBy: 'admin', pausedByAdmin: 'Root' }, 10);
    expect(paused).toMatchObject({ state: 'paused', paused: true, pausedBy: 'admin', pausedByAdmin: 'Root' });
    expect(toSummary(waiting, headOf(waiting), open, { level: 'send', paused: true }, 10).state).toBe('waiting');
  });
});

describe('pairsOf', () => {
  it('has each pair once with its two ids in order, whichever way it was sent, sorted', () => {
    expect(pairsOf([{ from_session: 'sb', to_session: 'sa' }, { from_session: 'sa', to_session: 'sb' }, { from_session: 'sc', to_session: 'person:1' }])).toEqual([['person:1', 'sc'], ['sa', 'sb']]);
    expect(pairsOf([])).toEqual([]);
  });
});
