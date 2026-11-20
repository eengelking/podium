import { describe, expect, it } from 'vitest';
import type { MessageRow, MessageState } from '../fleet/peerTypes.js';
import { MERGE_MS, shownCount } from './peerText.js';
import { LOCKED_STATES, decideChange, isSentToAgent, mergesAsOne } from './peerEdit.js';

const row = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 'm1', owner: 'ed', link: 'l', fromKey: '', toKey: 'kb', fromSession: 'sa', toSession: 'sb', fromName: 'Ed', fromMachine: '', toName: 'beta', toMachine: 'box-b', text: 'hi', sentAt: 1000,
  state: 'ready', stateAt: 1000, why: null, approved: false, author: 'person', authorId: 7, editedAt: null, deletedAt: null, ...over,
});

describe('isSentToAgent', () => {
  it.each([
    ['approval', false], ['ready', false], ['declined', false], ['dropped', false],
    ['queued', true], ['handed', true], ['delivered', true],
  ] as [MessageState, boolean][])('says %s is sent to an agent: %s', (state, locked) => {
    expect(isSentToAgent(state)).toBe(locked);
  });

  it('is exactly the states LOCKED_STATES names', () => {
    expect([...LOCKED_STATES].sort()).toEqual(['delivered', 'handed', 'queued']);
  });
});

describe('mergesAsOne', () => {
  const a = row();
  const b = row({ id: 'm2', toSession: 'sc' });
  it('merges a person\'s identical text to two different agents inside the window, by the same name', () => {
    expect(mergesAsOne(a, b)).toBe(true);
    expect(mergesAsOne(a, row({ id: 'm2', toSession: 'sc', sentAt: 1000 + MERGE_MS }))).toBe(true);
  });
  it('does not merge past the window, with another text or name, an agent\'s message, or two to the same agent', () => {
    expect(mergesAsOne(a, row({ id: 'm2', toSession: 'sc', sentAt: 1000 + MERGE_MS + 1 }))).toBe(false);
    expect(mergesAsOne(a, row({ id: 'm2', toSession: 'sc', text: 'other' }))).toBe(false);
    expect(mergesAsOne(a, row({ id: 'm2', toSession: 'sc', fromName: 'Zoe' }))).toBe(false);
    expect(mergesAsOne(a, row({ id: 'm2', toSession: 'sc', author: 'agent' }))).toBe(false);
    expect(mergesAsOne(a, row({ id: 'm2' }))).toBe(false);
  });
  it('agrees with the count the thread shows (shownCount) on every pair of rows', () => {
    const times = [1000, 1000 + MERGE_MS, 1000 + MERGE_MS + 1];
    for (const t of times) for (const to of ['sb', 'sc']) for (const text of ['hi', 'yo']) for (const author of ['person', 'agent'] as const) for (const fromName of ['Ed', 'Zoe']) {
      const other = row({ id: 'm2', sentAt: t, toSession: to, text, author, fromName });
      expect(shownCount([a, other]) === 1).toBe(mergesAsOne(a, other));
    }
  });
});

describe('decideChange', () => {
  it('answers not-found for no row', () => {
    expect(decideChange(null, [], 7)).toEqual({ ok: false, reason: 'not-found' });
  });
  it('answers not-yours for another person\'s id, an agent\'s row and a person\'s row with no author id, before anything else', () => {
    expect(decideChange(row(), [], 8)).toEqual({ ok: false, reason: 'not-yours' });
    expect(decideChange(row({ author: 'agent', authorId: null }), [], 7)).toEqual({ ok: false, reason: 'not-yours' });
    expect(decideChange(row({ author: 'agent', authorId: 7 }), [], 7)).toEqual({ ok: false, reason: 'not-yours' });
    expect(decideChange(row({ authorId: null }), [], 0)).toEqual({ ok: false, reason: 'not-yours' });
    expect(decideChange(row({ deletedAt: 5, state: 'delivered' }), [], 8)).toEqual({ ok: false, reason: 'not-yours' });
  });
  it('answers deleted for a tombstone, ahead of locked', () => {
    expect(decideChange(row({ deletedAt: 5, text: '', state: 'dropped' }), [], 7)).toEqual({ ok: false, reason: 'deleted' });
    expect(decideChange(row({ deletedAt: 5, text: '', state: 'delivered' }), [], 7)).toEqual({ ok: false, reason: 'deleted' });
  });
  it('answers locked for a row sent to an agent, and changes a row that was not', () => {
    for (const state of ['queued', 'handed', 'delivered'] as const) expect(decideChange(row({ state }), [], 7)).toEqual({ ok: false, reason: 'locked' });
    for (const state of ['approval', 'ready', 'declined', 'dropped'] as const) expect(decideChange(row({ state }), [], 7)).toMatchObject({ ok: true });
  });
  it('takes with the row every sibling the thread merges with it, and locks them all when one is locked', () => {
    const first = row();
    const sibling = row({ id: 'm2', toSession: 'sc', sentAt: 1500 });
    const unrelated = [row({ id: 'm3', toSession: 'sd', text: 'other' }), row({ id: 'm4', toSession: 'se', authorId: 8 }), row({ id: 'm5', toSession: 'sf', sentAt: 9000 }), row({ id: 'm1' })];
    const d = decideChange(first, [first, sibling, ...unrelated], 7);
    expect(d.ok && d.group.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(decideChange(first, [first, row({ id: 'm2', toSession: 'sc', state: 'delivered' })], 7)).toEqual({ ok: false, reason: 'locked' });
    // The sibling is asked for: the first row is its sibling the same way.
    const d2 = decideChange(sibling, [first, sibling], 7);
    expect(d2.ok && d2.group.map((m) => m.id)).toEqual(['m2', 'm1']);
  });
});
