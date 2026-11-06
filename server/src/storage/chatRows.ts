// The pure part of the Chat page's stores (#1034), shared by every adapter: neither adapter imports the other, so what they have in common
// lives here. Nothing in this file touches a database, and nothing here knows a direct message (`peer_messages`): a channel's text and a
// conversation's text are kept in different tables and read by different methods on purpose.
import { randomBytes } from 'node:crypto';
import { nameKey } from './rows.js';
import type { ChannelMention, ChannelMessage, ChannelPostInput, ChatAuthorKind, MentionState } from './types.js';

export const CHAT_AUTHOR_KINDS: readonly ChatAuthorKind[] = ['person', 'orchestrator', 'subagent', 'reporter'];
export const MENTION_STATES: readonly MentionState[] = ['waiting', 'working', 'done', 'not-delivered', 'held', 'dropped'];

/** The `settings` key that holds this server's scope, minted once. */
export const CHAT_SCOPE_KEY = 'chat_scope';

/**
 * A channel message's id: `<table>_<scope>_<random>`. `<table>` is `grp` (group_messages) or `pub` (public_messages); `<scope>` is the
 * server's 8 hex digits, minted once and kept in `settings` (`chat_scope`), so ids from two servers can be told apart and a bridge can
 * carry them unchanged later; `<random>` is 24 hex digits. Example: `pub_3fa9c1d2_9e1b0c47d5a86f3e2b4a7c10`.
 */
export const newChannelId = (prefix: 'grp' | 'pub', scope: string): string => `${prefix}_${scope}_${randomBytes(12).toString('hex')}`;

/** A fresh server scope: 8 hex digits. */
export const newServerScope = (): string => randomBytes(4).toString('hex');

/** The owner of a group channel as it is stored and compared: folded the way every owner name is. */
export const channelOwner = (owner: string): string => nameKey(owner);

/** The group channel's key columns, in one place for both adapters. */
export interface DbChannelRow {
  id: string;
  owner?: string;
  group_id?: string;
  author_kind: string;
  author_ref: string;
  author_name: string;
  text: string;
  created_at: number;
  updated_at: number;
  issue: string | null;
  project: string | null;
  milestone: string | null;
  reply_to: string | null;
  mentions_json: string;
  seq: number;
}

/** Throws for an author kind that is not one of the four. */
export function checkAuthorKind(kind: string): ChatAuthorKind {
  if (!CHAT_AUTHOR_KINDS.includes(kind as ChatAuthorKind)) throw new Error('The author kind is not one of person, orchestrator, subagent or reporter.');
  return kind as ChatAuthorKind;
}

/** The mentions of a new post, each with its delivery state (waiting unless the caller says otherwise) stamped at `at`. */
export function mentionsOf(input: ChannelPostInput, at: number): ChannelMention[] {
  return (input.mentions ?? []).map((m) => {
    const state = m.state ?? 'waiting';
    if (!MENTION_STATES.includes(state)) throw new Error('The delivery state is not one of waiting, working, done, not-delivered, held or dropped.');
    return { sessionId: m.sessionId, peerKey: m.peerKey, typed: m.typed, state, why: m.why ?? null, stateAt: at };
  });
}

export function parseMentions(json: string): ChannelMention[] {
  return JSON.parse(json) as ChannelMention[];
}

/** One stored row as the interface returns it. */
export function toChannelMessage(r: DbChannelRow): ChannelMessage {
  return {
    id: r.id,
    owner: r.owner ?? null,
    groupId: r.group_id ?? null,
    authorKind: r.author_kind as ChatAuthorKind,
    authorRef: r.author_ref,
    authorName: r.author_name,
    text: r.text,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    issue: r.issue,
    project: r.project,
    milestone: r.milestone,
    replyTo: r.reply_to,
    mentions: parseMentions(r.mentions_json),
  };
}

/** `mentions` with one entry's state changed at `at`; null when there is no entry at `index`. */
export function withMentionState(mentions: ChannelMention[], index: number, patch: { state: MentionState; why?: string | null }, at: number): ChannelMention[] | null {
  const current = mentions[index];
  if (!Number.isInteger(index) || !current) return null;
  if (!MENTION_STATES.includes(patch.state)) throw new Error('The delivery state is not one of waiting, working, done, not-delivered, held or dropped.');
  return mentions.map((m, i) => (i === index ? { ...m, state: patch.state, why: patch.why ?? null, stateAt: at } : m));
}

/** What a read state row says before anything was counted for the thread. */
export const emptyReadState = (person: string, thread: string): { person: string; thread: string; lastRead: null; unread: 0; mentions: 0; updatedAt: 0 } => ({
  person: nameKey(person),
  thread,
  lastRead: null,
  unread: 0,
  mentions: 0,
  updatedAt: 0,
});
