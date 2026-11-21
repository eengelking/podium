import { describe, expect, it } from 'vitest';
import { countConversations, type ConversationGroupRow } from './conversationCounts.js';

const row = (owner: number, from: string, to: string, hidden: boolean): ConversationGroupRow => ({ owner_id: owner, from_session: from, to_session: to, all_hidden: hidden ? 1 : 0 });

describe('countConversations (#1046)', () => {
  it('counts a pair once however many directions and owners it has', () => {
    const rows = [row(1, 'sa', 'sb', false), row(1, 'sb', 'sa', false), row(1, 'sa', 'sc', false)];
    expect(countConversations(rows, [1, 2])).toEqual({ 1: 2, 2: 0 });
  });

  it('counts a conversation a person started with another person\'s agent', () => {
    expect(countConversations([row(2, 'person:1', 'se', false)], [1, 2])).toEqual({ 1: 1, 2: 1 });
  });

  it('leaves out a pair whose rows are all hidden, and keeps one with any shown row', () => {
    expect(countConversations([row(1, 'sa', 'sb', true), row(1, 'sb', 'sa', true)], [1])).toEqual({ 1: 0 });
    expect(countConversations([row(1, 'sa', 'sb', true), row(1, 'sb', 'sa', false)], [1])).toEqual({ 1: 1 });
  });

  it('judges hidden over the rows a person owns or is an end of, as ownerConversations does', () => {
    // Ed's rows are hidden; a later row in the same pair is stored under another owner and shown. Ed's list leaves the pair out.
    const rows = [row(1, 'sa', 'sb', true), row(2, 'sb', 'sa', false)];
    expect(countConversations(rows, [1, 2])).toEqual({ 1: 0, 2: 1 });
  });
});
