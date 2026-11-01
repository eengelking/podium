import { describe, it, expect } from 'vitest';
import { cleanPeerText, roundTripsUsed } from './peerText.js';

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
