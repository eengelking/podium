// Shared, database-free helpers for the conversations of people and agents (#1278, DECISIONS 74): ids, member checks, the key that finds the conversation of a set of members,
// and the mapping of stored rows to the interface's values. No SQL here: each adapter has its own statements, in its own folder.
import { createHash, randomBytes } from 'node:crypto';
import type { Conversation, ConversationChange, ConversationMember, ConversationMemberInput, ConversationMemberKind, ConversationMessage } from './types.js';

export const MAX_CONVERSATION_MEMBERS = 50;
const KINDS: readonly ConversationMemberKind[] = ['person', 'agent'];

/** A conversation's id: `cnv_<scope>_<24 hex digits>`, the scope being the server's 8 hex digits of `chat_scope`. */
export const newConversationId = (scope: string): string => `cnv_${scope}_${randomBytes(12).toString('hex')}`;
/** A conversation message's id: `cmg_<scope>_<24 hex digits>`. */
export const newConversationMessageId = (scope: string): string => `cmg_${scope}_${randomBytes(12).toString('hex')}`;

export interface DbConversation {
  id: string;
  created_by: number | null;
  created_at: number;
  members_key: string;
}

export interface DbMember {
  conversation_id: string;
  member_kind: string;
  member_ref: string;
  member_name: string;
  added_by: number | null;
  joined_at: number;
  left_at: number | null;
}

export interface DbConversationMessage {
  id: string;
  conversation_id: string;
  author_kind: string;
  author_ref: string;
  author_name: string;
  author_id: number | null;
  text: string;
  created_at: number;
  updated_at: number;
  reply_to: string | null;
  seq: number;
  edited_at: number | null;
  deleted_at: number | null;
  handed_at: number | null;
}

export const MEMBER_COLS = 'conversation_id, member_kind, member_ref, member_name, added_by, joined_at, left_at';
export const MESSAGE_COLS = 'id, conversation_id, author_kind, author_ref, author_name, author_id, text, created_at, updated_at, reply_to, seq, edited_at, deleted_at, handed_at';

/** The members as stored: trimmed, each kind and ref once (the first name wins). Throws for a kind that is not `person` or `agent`, a person ref that is not an id, or an empty ref or name. */
export function checkMembers(members: readonly ConversationMemberInput[]): ConversationMemberInput[] {
  const seen = new Set<string>();
  const out: ConversationMemberInput[] = [];
  for (const m of members) {
    if (!KINDS.includes(m.kind)) throw new Error('A member is a person or an agent.');
    const ref = String(m.ref ?? '').trim();
    const name = String(m.name ?? '').trim();
    if (!ref || !name) throw new Error('A member needs a reference and a name.');
    if (ref.length > 255 || name.length > 255) throw new Error('A member reference or name is too long.');
    if (m.kind === 'person' && !/^\d{1,12}$/.test(ref)) throw new Error('A person is named by their id.');
    const key = `${m.kind}:${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: m.kind, ref, name });
  }
  return out;
}

/** The members of a new conversation: at least two, at least one a person, at most 50. */
export function checkNewMembers(members: readonly ConversationMemberInput[]): ConversationMemberInput[] {
  const list = checkMembers(members);
  if (list.length < 2) throw new Error('A conversation has at least two members.');
  if (!list.some((m) => m.kind === 'person')) throw new Error('A conversation has at least one person.');
  if (list.length > MAX_CONVERSATION_MEMBERS) throw new Error(`A conversation has at most ${MAX_CONVERSATION_MEMBERS} members.`);
  return list;
}

/** What finds the conversation of a set of members: a hash of the sorted `kind:ref` of the members who are in it now. */
export function membersKey(current: readonly { kind: string; ref: string }[]): string {
  const parts = current.map((m) => `${m.kind}:${m.ref}`).sort();
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

export function toMember(r: DbMember): ConversationMember {
  return {
    kind: r.member_kind as ConversationMemberKind,
    ref: r.member_ref,
    name: r.member_name,
    addedBy: r.added_by == null ? null : Number(r.added_by),
    joinedAt: Number(r.joined_at),
    leftAt: r.left_at == null ? null : Number(r.left_at),
  };
}

/** The conversation as returned: its members in the order they joined (then kind, then ref). */
export function toConversation(r: DbConversation, members: DbMember[], lastAt: number | null, messages: number): Conversation {
  const list = members.map(toMember).sort((a, b) => a.joinedAt - b.joinedAt || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { id: r.id, createdBy: r.created_by == null ? null : Number(r.created_by), createdAt: Number(r.created_at), members: list, lastAt: lastAt == null ? Number(r.created_at) : Number(lastAt), messages: Number(messages) };
}

export function toConversationMessage(r: DbConversationMessage): ConversationMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    authorKind: r.author_kind as ConversationMemberKind,
    authorRef: r.author_ref,
    authorName: r.author_name,
    authorId: r.author_id == null ? null : Number(r.author_id),
    text: r.text,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    replyTo: r.reply_to,
    editedAt: r.edited_at == null ? null : Number(r.edited_at),
    deletedAt: r.deleted_at == null ? null : Number(r.deleted_at),
    handedAt: r.handed_at == null ? null : Number(r.handed_at),
  };
}

/** Why the author may not change this message, or null when they may: no such message, not theirs (by id), already deleted, or already handed to an agent. */
export function refuseConversationChange(row: DbConversationMessage | undefined, author: number): Extract<ConversationChange, { ok: false }> | null {
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.author_kind !== 'person' || row.author_id == null || Number(row.author_id) !== author) return { ok: false, reason: 'not-yours' };
  if (row.deleted_at != null) return { ok: false, reason: 'deleted' };
  if (row.handed_at != null) return { ok: false, reason: 'locked' };
  return null;
}

/** The authorship of a new message: a person's carries their id, an agent's carries none. Throws for an author kind that is not `person` or `agent`. */
export function checkAuthor(kind: string): ConversationMemberKind {
  if (!KINDS.includes(kind as ConversationMemberKind)) throw new Error('A message is written by a person or an agent.');
  return kind as ConversationMemberKind;
}
