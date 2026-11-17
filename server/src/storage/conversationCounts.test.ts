import { describe, expect, it } from 'vitest';
import { countConversations, type ConversationGroupRow } from './conversationCounts.js';

const row = (owner: string, from: string, to: string, hidden: boolean): ConversationGroupRow => ({ owner, from_session: from, to_session: to, all_hidden: hidden ? 1 : 0 });

describe('countConversations (#1046)', () => {
  it('counts a pair once however many directions and owners it has', () => {
    const rows = [row('ed', 'sa', 'sb', false), row('ed', 'sb', 'sa', false), row('ed', 'sa', 'sc', false)];
    expect(countConversations(rows, ['ed', 'eve'])).toEqual({ ed: 2, eve: 0 });
  });

  it('counts a conversation a person started with another person\'s agent', () => {
    expect(countConversations([row('eve', 'person:ed', 'se', false)], ['Ed', 'eve'])).toEqual({ Ed: 1, eve: 1 });
  });

  it('leaves out a pair whose rows are all hidden, and keeps one with any shown row', () => {
    expect(countConversations([row('ed', 'sa', 'sb', true), row('ed', 'sb', 'sa', true)], ['ed'])).toEqual({ ed: 0 });
    expect(countConversations([row('ed', 'sa', 'sb', true), row('ed', 'sb', 'sa', false)], ['ed'])).toEqual({ ed: 1 });
  });

  it('judges hidden over the rows a person owns or is an end of, as ownerConversations does', () => {
    // Ed's rows are hidden; a later row in the same pair is stored under another owner and shown. Ed's list leaves the pair out.
    const rows = [row('ed', 'sa', 'sb', true), row('eve', 'sb', 'sa', false)];
    expect(countConversations(rows, ['ed', 'eve'])).toEqual({ ed: 0, eve: 1 });
  });
});
