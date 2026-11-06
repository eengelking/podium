import { describe, it, expect } from 'vitest';
import { cleanPeerText, roundTripsUsed, shownCount } from './peerText.js';

describe('cleanPeerText', () => {
  it('replaces control characters other than a line break and a tab with a space', () => {
    expect(cleanPeerText('a\u0000b\u0007c\rd\u001be\u007ff\ng\th')).toBe('a b c d e f\ng\th');
    expect(cleanPeerText('plain ✓ text')).toBe('plain ✓ text');
  });
});

describe('roundTripsUsed', () => {
  const r = (fromSession: string, extra: Partial<{ state: 'ready' | 'declined' | 'dropped'; approved: boolean }> = {}) => ({ fromSession, state: extra.state ?? 'ready', approved: extra.approved ?? false });
  it('counts each change of direction as half a round trip, rounded up', () => {
    expect(roundTripsUsed([])).toBe(0);
    expect(roundTripsUsed([r('a'), r('a')])).toBe(0);
    expect(roundTripsUsed([r('a'), r('b')])).toBe(1);
    expect(roundTripsUsed([r('a'), r('b'), r('a')])).toBe(1);
    expect(roundTripsUsed([r('a'), r('b'), r('a'), r('b')])).toBe(2);
  });
  it('counts from the newest approved message, and skips declined and dropped ones', () => {
    expect(roundTripsUsed([r('a'), r('b'), r('a', { approved: true }), r('b')])).toBe(1);
    expect(roundTripsUsed([r('a'), r('b', { state: 'declined' }), r('b', { state: 'dropped' }), r('a')])).toBe(0);
  });
});

describe('shownCount', () => {
  const m = (author: 'agent' | 'person', text: string, sentAt: number, toSession: string, fromName = 'Ed') => ({ author, text, sentAt, toSession, fromName });
  it('counts a person message stored once per agent as one, the way the thread shows it', () => {
    expect(shownCount([])).toBe(0);
    expect(shownCount([m('person', 'hi', 1000, 'a'), m('person', 'hi', 1001, 'b'), m('agent', 'ok', 1500, 'p'), m('agent', 'ok', 1501, 'p')])).toBe(3);
  });
  it('does not merge different text, a gap over 2 s, another author, the same agent twice or an agent message', () => {
    expect(shownCount([m('person', 'hi', 0, 'a'), m('person', 'yo', 1, 'b')])).toBe(2);
    expect(shownCount([m('person', 'hi', 0, 'a'), m('person', 'hi', 2001, 'b')])).toBe(2);
    expect(shownCount([m('person', 'hi', 0, 'a'), m('person', 'hi', 1, 'b', 'Eve')])).toBe(2);
    expect(shownCount([m('person', 'hi', 0, 'a'), m('person', 'hi', 1, 'a')])).toBe(2);
    expect(shownCount([m('agent', 'hi', 0, 'a'), m('agent', 'hi', 1, 'b')])).toBe(2);
  });
});
