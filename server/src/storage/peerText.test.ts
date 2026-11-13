import { describe, it, expect } from 'vitest';
import { cleanNameText, cleanPeerText, latestOf, roundTripsUsed, shownCount } from './peerText.js';

describe('cleanPeerText', () => {
  it('replaces control characters other than a line break and a tab with a space', () => {
    expect(cleanPeerText('a\u0000b\u0007c\rd\u001be\u007ff\ng\th')).toBe('a b c d e f\ng\th');
    expect(cleanPeerText('plain ✓ text')).toBe('plain ✓ text');
  });

  it('removes format characters, which draw nothing: bidi controls, zero-width characters and tag characters (#1051)', () => {
    // The joiners U+200C and U+200D are kept in a message's text (below); every other format character goes.
    expect(cleanPeerText('a\u202Eb\u200Bc\u2066d\u2069e\uFEFFf\u2060g\u00ADh\u{E0041}i')).toBe('abcdefghi');
    expect(cleanPeerText('emoji \u{1F389} stays')).toBe('emoji \u{1F389} stays');
  });

  it('keeps the joiners that spell a word or an emoji: a family emoji and a Persian word with a zero-width non-joiner (#1051)', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
    const persian = '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645';
    expect(cleanPeerText(`see ${family} and ${persian}`)).toBe(`see ${family} and ${persian}`);
    // ... while a bidi override next to them still goes.
    expect(cleanPeerText(`${persian}\u202E${family}\u2066`)).toBe(`${persian}${family}`);
  });

  it('removes every format character from a name, joiners included, so two names that differ only in what draws nothing are one (#1051)', () => {
    expect(cleanNameText('Al\u200Dex\u200C \u202EBo\u200B')).toBe('Alex Bo');
  });

  it('turns the line separators a terminal or a browser breaks a line at into a line break (#1051)', () => {
    expect(cleanPeerText('one\u2028two\u2029three\u0085four')).toBe('one\ntwo\nthree\nfour');
  });
});

describe('latestOf', () => {
  it('takes the largest of a list of any length: a spread of 130,000 or more arguments throws a RangeError, and this does not (#1051)', () => {
    expect(latestOf([3, 9, 4])).toBe(9);
    expect(latestOf([7])).toBe(7);
    const big = Array.from({ length: 1_000_000 }, (_, i) => i);
    expect(() => Math.max(...big)).toThrow(RangeError);
    expect(latestOf(big)).toBe(999_999);
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
