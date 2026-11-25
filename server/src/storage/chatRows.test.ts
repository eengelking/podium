// The rule that says when a person can no longer change a Chat message (#1269): an agent was handed it and has started or finished with it.
import { describe, expect, it } from 'vitest';
import { bumpAnswers, foldBumps, lockedByDelivery, newestChange, peerPersonKey, refuseChange, toChannelMessage, type DbChannelRow } from './chatRows.js';
import type { ChannelMention, MentionState } from './types.js';

const m = (sessionId: string | null, state: MentionState): ChannelMention => ({ sessionId, peerKey: null, typed: 'x@box', state, why: null, stateAt: 0 });

describe('lockedByDelivery', () => {
  it('is false for a message with no mention', () => {
    expect(lockedByDelivery([])).toBe(false);
  });
  it.each(['waiting', 'working', 'done'] as const)('is true for an agent mention that is %s', (state) => {
    expect(lockedByDelivery([m('sa', state)])).toBe(true);
  });
  it.each(['held', 'approval', 'not-delivered', 'dropped'] as const)('is false for an agent mention that is %s', (state) => {
    expect(lockedByDelivery([m('sa', state)])).toBe(false);
  });
  it.each(['working', 'done', 'waiting', 'held', 'approval', 'not-delivered', 'dropped'] as const)('is false for a person who was notified (no session), state %s', (state) => {
    expect(lockedByDelivery([m(null, state)])).toBe(false);
  });
  it('is true when any one mention locks it', () => {
    expect(lockedByDelivery([m('sa', 'held'), m(null, 'done'), m('sb', 'waiting')])).toBe(true);
    expect(lockedByDelivery([m('sa', 'held'), m(null, 'done'), m('sb', 'dropped')])).toBe(false);
  });
});

const row = (over: Partial<DbChannelRow> = {}): DbChannelRow => ({
  id: 'pub_00000000_a', channel: 'general', author_kind: 'person', author_ref: 'Ed', author_name: 'Ed', text: 't', created_at: 1, issue: null, project: null, milestone: null, reply_to: null,
  mentions_json: '[]', seq: 1, author_id: 7, edited_at: null, deleted_at: null, ...over,
});

describe('refuseChange', () => {
  it('lets the person whose id the message carries go on, whatever name is on it', () => {
    expect(refuseChange(row(), 7)).toBeNull();
    expect(refuseChange(row({ author_ref: 'somebody else', author_name: 'Somebody Else' }), 7)).toBeNull();
  });
  it('refuses a message that is not there', () => {
    expect(refuseChange(undefined, 7)).toEqual({ ok: false, reason: 'not-found' });
  });
  it('refuses another id, a message with no id, and an agent\'s message even when its id matches, as not yours', () => {
    expect(refuseChange(row(), 8)).toEqual({ ok: false, reason: 'not-yours' });
    expect(refuseChange(row({ author_id: null }), 7)).toEqual({ ok: false, reason: 'not-yours' });
    expect(refuseChange(row({ author_id: undefined }), 0)).toEqual({ ok: false, reason: 'not-yours' });
    expect(refuseChange(row({ author_kind: 'orchestrator' }), 7)).toEqual({ ok: false, reason: 'not-yours' });
  });
  it('refuses a tombstone, then a locked message, after the author check', () => {
    expect(refuseChange(row({ deleted_at: 5 }), 7)).toEqual({ ok: false, reason: 'deleted' });
    expect(refuseChange(row({ deleted_at: 5 }), 8)).toEqual({ ok: false, reason: 'not-yours' });
    const sent = JSON.stringify([{ sessionId: 'sa', peerKey: null, typed: 'x@box', state: 'waiting', why: null, stateAt: 0 }]);
    expect(refuseChange(row({ mentions_json: sent }), 7)).toEqual({ ok: false, reason: 'locked' });
  });
});

describe('toChannelMessage', () => {
  it('reads the ids and times of a row, and null for a database that has none', () => {
    expect(toChannelMessage(row({ author_id: 7, edited_at: 3, deleted_at: 4 }))).toMatchObject({ authorId: 7, editedAt: 3, deletedAt: 4 });
    expect(toChannelMessage(row({ author_id: undefined, edited_at: undefined, deleted_at: undefined }))).toMatchObject({ authorId: null, editedAt: null, deletedAt: null });
  });

  it('gives updatedAt as the newest of its post, edit, delete and a mention\'s state time, left out when a message has none (#1296)', () => {
    const mention = (stateAt: number) => JSON.stringify([{ sessionId: null, peerKey: null, typed: 'x@box', state: 'done', why: null, stateAt }]);
    expect(toChannelMessage(row({ created_at: 5 })).updatedAt).toBe(5);
    expect(toChannelMessage(row({ created_at: 5, edited_at: 9 })).updatedAt).toBe(9);
    expect(toChannelMessage(row({ created_at: 5, edited_at: 9, mentions_json: mention(12) })).updatedAt).toBe(12);
    expect(toChannelMessage(row({ created_at: 5, edited_at: 9, mentions_json: mention(7) })).updatedAt).toBe(9);
    expect(toChannelMessage(row({ created_at: 5, edited_at: 9, deleted_at: 20, mentions_json: '[]' })).updatedAt).toBe(20);
    expect(newestChange(4, null, 8)).toBe(8);
  });
});

describe('peerPersonKey', () => {
  it('is the folded name after person: when the message is to or from a person\'s own key, else the folded owner', () => {
    expect(peerPersonKey('person:ed  smith', 'zoe')).toBe('ed smith');
    expect(peerPersonKey('session-1', ' Ed  Smith ')).toBe('ed smith');
  });
});

describe('bumpAnswers (#1309)', () => {
  it('answers each person in the order given, from rows read in any order', () => {
    const row = (person_id: number, unread: number) => ({ person_id, thread: 't', unread, mentions: 0 });
    const answers = bumpAnswers([{ personId: 2 }, { personId: 1 }], [row(1, 7), row(2, 9)]);
    expect(answers.map((a) => [a.personId, a.unread])).toEqual([[2, 9], [1, 7]]);
    expect(bumpAnswers([], [])).toEqual([]);
  });
});

describe('foldBumps (#1309)', () => {
  it('has one entry for each person in ascending person id, whatever order they were listed in, counting a person listed twice twice', () => {
    expect(foldBumps([])).toEqual([]);
    expect(foldBumps([{ personId: 2, mention: false }, { personId: 1, mention: true }, { personId: 2, mention: true }, { personId: 2, mention: false }])).toEqual([
      { personId: 1, unread: 1, mentions: 1 },
      { personId: 2, unread: 3, mentions: 1 },
    ]);
    // The same people in the opposite order fold to the same list, so two transactions that count them take their row locks in one order (#1296).
    expect(foldBumps([{ personId: 9, mention: false }, { personId: 5, mention: false }, { personId: 7, mention: true }])).toEqual(foldBumps([{ personId: 7, mention: true }, { personId: 9, mention: false }, { personId: 5, mention: false }]));
  });
});
