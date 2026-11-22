// The conversations of people and agents on SQLite (#1278, DECISIONS 74): `conversations`, `conversation_members`, `conversation_messages` and `conversation_deliveries` (#1282). A fourth audience, in its own
// tables: nothing here reads or writes a channel's message or a `peer_messages` row, and the reverse (`separation.test.ts` holds the code to it). Each call is one step
// under the lock, and one that writes more than one row is also one transaction, so a crash cannot leave half a conversation.
import type { DatabaseSync } from 'node:sqlite';
import type { AsyncLock } from '../lock.js';
import { decodeCursor, encodeCursor, pageSize } from '../peerText.js';
import {
  DELIVERY_COLS, MAX_CONVERSATION_MEMBERS, MEMBER_COLS, MESSAGE_COLS, checkAuthor, checkMembers, checkNewMembers, checkTargets, firstDeliveryState, nextDeliveryState, membersKey, newConversationId, newConversationMessageId, refuseConversationChange, toConversation, toConversationMessage, toConversations,
  type DbConversation, type DbConversationMessage, type DbDelivery, type DbMember,
} from '../conversationRows.js';
import type { Conversation, ConversationChange, ConversationDeliveryState, ConversationMemberInput, ConversationMemberKind, ConversationMessage, ConversationPage, ConversationPostInput, ConversationsApi } from '../types.js';

type MemberRef = { kind: ConversationMemberKind; ref: string };

class Conversations {
  constructor(
    private readonly db: DatabaseSync,
    private readonly scope: () => string,
  ) {}

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private row(id: string): DbConversation | undefined {
    return this.db.prepare('SELECT id, created_at, members_key FROM conversations WHERE id = ?').get(id) as unknown as DbConversation | undefined;
  }

  private membersOf(id: string): DbMember[] {
    return this.db.prepare(`SELECT ${MEMBER_COLS} FROM conversation_members WHERE conversation_id = ? ORDER BY joined_at, member_kind, member_ref`).all(id) as unknown as DbMember[];
  }

  private load(id: string): Conversation | null {
    const r = this.row(id);
    if (!r) return null;
    const m = this.db.prepare('SELECT MAX(created_at) AS last, COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ?').get(id) as unknown as { last: number | null; n: number };
    return toConversation(r, this.membersOf(id), m.last, m.n);
  }

  private current(id: string): MemberRef[] {
    return this.membersOf(id).filter((m) => m.left_at == null).map((m) => ({ kind: m.member_kind as ConversationMemberKind, ref: m.member_ref }));
  }

  private rekey(id: string): void {
    this.db.prepare('UPDATE conversations SET members_key = ? WHERE id = ?').run(membersKey(this.current(id)), id);
  }

  private insertMember(id: string, m: ConversationMemberInput, addedBy: number | null, at: number): void {
    this.db
      .prepare('INSERT INTO conversation_members (conversation_id, member_kind, member_ref, member_name, added_by, joined_at, left_at) VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .run(id, m.kind, m.ref, m.name, addedBy, at);
  }

  open(input: { members: ConversationMemberInput[]; createdBy: number | null }, at: number): { conversation: Conversation; created: boolean } {
    const members = checkNewMembers(input.members);
    const key = membersKey(members);
    const found = this.db.prepare('SELECT id FROM conversations WHERE members_key = ? ORDER BY created_at, id LIMIT 1').get(key) as unknown as { id: string } | undefined;
    if (found) return { conversation: this.load(found.id) as Conversation, created: false };
    const id = newConversationId(this.scope());
    this.tx(() => {
      this.db.prepare('INSERT INTO conversations (id, created_at, members_key) VALUES (?, ?, ?)').run(id, at, key);
      for (const m of members) this.insertMember(id, m, m.kind === 'person' && input.createdBy !== null && m.ref === String(input.createdBy) ? null : input.createdBy, at);
    });
    return { conversation: this.load(id) as Conversation, created: true };
  }

  get(id: string): Conversation | null {
    return this.load(id);
  }

  ids(): string[] {
    return (this.db.prepare('SELECT id FROM conversations ORDER BY id').all() as unknown as { id: string }[]).map((r) => r.id);
  }

  listFor(member: MemberRef): Conversation[] {
    // The conversations the member is in now, and their members and message totals: three statements however many there are (#1309).
    const mine = 'SELECT conversation_id FROM conversation_members WHERE member_kind = ? AND member_ref = ? AND left_at IS NULL';
    const args = [member.kind, member.ref];
    return toConversations(
      // order-insensitive: the rows are folded into one conversation each by `toConversations`, which sorts them.
      this.db.prepare(`SELECT id, created_at, members_key FROM conversations WHERE id IN (${mine})`).all(...args) as unknown as DbConversation[],
      // order-insensitive: the rows are folded into one conversation each by `toConversations`, which sorts them.
      this.db.prepare(`SELECT ${MEMBER_COLS} FROM conversation_members WHERE conversation_id IN (${mine})`).all(...args) as unknown as DbMember[],
      // order-insensitive: the rows are folded into one conversation each by `toConversations`, which sorts them.
      this.db.prepare(`SELECT conversation_id, MAX(created_at) AS last, COUNT(*) AS n FROM conversation_messages WHERE conversation_id IN (${mine}) GROUP BY conversation_id`).all(...args) as unknown as { conversation_id: string; last: number | null; n: number }[],
    );
  }

  addMembers(id: string, members: ConversationMemberInput[], addedBy: number | null, at: number): Conversation | null {
    if (!this.row(id)) return null;
    const list = checkMembers(members);
    const have = new Map(this.membersOf(id).map((m) => [`${m.member_kind}:${m.member_ref}`, m]));
    const inNow = new Set(this.current(id).map((m) => `${m.kind}:${m.ref}`));
    for (const m of list) inNow.add(`${m.kind}:${m.ref}`);
    if (inNow.size > MAX_CONVERSATION_MEMBERS) throw new Error(`A conversation has at most ${MAX_CONVERSATION_MEMBERS} members.`);
    this.tx(() => {
      for (const m of list) {
        const old = have.get(`${m.kind}:${m.ref}`);
        if (!old) this.insertMember(id, m, addedBy, at);
        else if (old.left_at != null) this.db.prepare('UPDATE conversation_members SET left_at = NULL, joined_at = ?, added_by = ?, member_name = ? WHERE conversation_id = ? AND member_kind = ? AND member_ref = ?').run(at, addedBy, m.name, id, m.kind, m.ref);
      }
      this.rekey(id);
    });
    return this.load(id);
  }

  leave(id: string, member: MemberRef, at: number): { conversation: Conversation | null; deleted: boolean } | null {
    const mine = this.membersOf(id).find((m) => m.member_kind === member.kind && m.member_ref === member.ref && m.left_at == null);
    if (!mine) return null;
    return this.tx(() => {
      this.db.prepare('UPDATE conversation_members SET left_at = ? WHERE conversation_id = ? AND member_kind = ? AND member_ref = ?').run(at, id, member.kind, member.ref);
      // The agents this person added leave with them: an agent never stays where its owner can no longer see or stop it.
      if (member.kind === 'person') this.db.prepare("UPDATE conversation_members SET left_at = ? WHERE conversation_id = ? AND member_kind = 'agent' AND added_by = ? AND left_at IS NULL").run(at, id, Number(member.ref));
      if (!this.current(id).some((m) => m.kind === 'person')) {
        this.erase(id);
        return { conversation: null, deleted: true };
      }
      this.rekey(id);
      return { conversation: this.load(id), deleted: false };
    });
  }

  post(id: string, input: ConversationPostInput, at: number): ConversationMessage | null {
    const kind = checkAuthor(input.authorKind);
    if (!this.row(id)) return null;
    if (!this.current(id).some((m) => m.kind === kind && m.ref === input.authorRef)) return null;
    const targets = checkTargets(input.targets, this.current(id), { kind, ref: input.authorRef });
    const mid = newConversationMessageId(this.scope());
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO conversation_messages (id, conversation_id, author_kind, author_ref, author_name, author_id, text, created_at, reply_to, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM conversation_messages))`,
        )
        .run(mid, id, kind, input.authorRef, input.authorName, kind === 'person' ? (input.authorId ?? null) : null, input.text, at, input.replyTo ?? null);
      for (const t of targets) {
        const state = firstDeliveryState(t.kind);
        this.db
          .prepare('INSERT INTO conversation_deliveries (conversation_id, message_id, member_kind, member_ref, member_name, named, state, state_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, mid, t.kind, t.ref, t.name, t.named ? 1 : 0, state, state === null ? null : at);
      }
    });
    return this.message(id, mid);
  }

  private raw(id: string, messageId: string): DbConversationMessage | undefined {
    return this.db.prepare(`SELECT ${MESSAGE_COLS} FROM conversation_messages WHERE id = ? AND conversation_id = ?`).get(messageId, id) as unknown as DbConversationMessage | undefined;
  }

  private deliveriesOf(id: string, messageIds: string[]): DbDelivery[] {
    if (!messageIds.length) return [];
    const marks = messageIds.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT ${DELIVERY_COLS} FROM conversation_deliveries WHERE conversation_id = ? AND message_id IN (${marks}) ORDER BY message_id, member_kind, member_ref`)
      .all(id, ...messageIds) as unknown as DbDelivery[];
  }

  private message(id: string, messageId: string): ConversationMessage | null {
    const r = this.raw(id, messageId);
    return r ? toConversationMessage(r, this.deliveriesOf(id, [messageId])) : null;
  }

  page(id: string, opts: { before?: string | null; limit: number }): ConversationPage {
    const before = opts.before === undefined || opts.before === null ? null : decodeCursor(opts.before);
    const limit = pageSize(opts.limit);
    const rows = (
      before
        ? this.db
            .prepare(`SELECT ${MESSAGE_COLS} FROM conversation_messages WHERE conversation_id = ? AND (created_at < ? OR (created_at = ? AND seq < ?)) ORDER BY created_at DESC, seq DESC LIMIT ?`)
            .all(id, before.at, before.at, before.seq, limit + 1)
        : this.db.prepare(`SELECT ${MESSAGE_COLS} FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?`).all(id, limit + 1)
    ) as unknown as DbConversationMessage[];
    const kept = rows.slice(0, limit).reverse();
    const oldest = kept[0];
    const deliveries = this.deliveriesOf(id, kept.map((r) => r.id));
    return { messages: kept.map((r) => toConversationMessage(r, deliveries)), older: rows.length > limit && oldest ? encodeCursor(Number(oldest.created_at), Number(oldest.seq)) : null };
  }

  getMessage(id: string, messageId: string): ConversationMessage | null {
    return this.message(id, messageId);
  }

  editMessage(id: string, messageId: string, x: { author: number; text: string; now: number }): ConversationChange {
    const refused = refuseConversationChange(this.raw(id, messageId), x.author);
    if (refused) return refused;
    this.db.prepare('UPDATE conversation_messages SET text = ?, edited_at = ? WHERE id = ?').run(x.text, x.now, messageId);
    return { ok: true, message: this.message(id, messageId) as ConversationMessage };
  }

  deleteMessage(id: string, messageId: string, x: { author: number; now: number }): ConversationChange {
    const refused = refuseConversationChange(this.raw(id, messageId), x.author);
    if (refused) return refused;
    this.db.prepare("UPDATE conversation_messages SET text = '', deleted_at = ? WHERE id = ?").run(x.now, messageId);
    return { ok: true, message: this.message(id, messageId) as ConversationMessage };
  }

  markHanded(id: string, messageId: string, at: number): ConversationMessage | null {
    if (!this.raw(id, messageId)) return null;
    this.db.prepare('UPDATE conversation_messages SET handed_at = COALESCE(handed_at, ?) WHERE id = ?').run(at, messageId);
    return this.message(id, messageId);
  }

  setDelivery(id: string, messageId: string, member: MemberRef, state: ConversationDeliveryState, at: number): ConversationMessage | null {
    const d = this.db.prepare(`SELECT ${DELIVERY_COLS} FROM conversation_deliveries WHERE conversation_id = ? AND message_id = ? AND member_kind = ? AND member_ref = ?`).get(id, messageId, member.kind, member.ref) as unknown as DbDelivery | undefined;
    if (!d) return null;
    const next = nextDeliveryState(d.state, state);
    if (next) this.db.prepare('UPDATE conversation_deliveries SET state = ?, state_at = ? WHERE conversation_id = ? AND message_id = ? AND member_kind = ? AND member_ref = ?').run(next, at, id, messageId, member.kind, member.ref);
    return this.message(id, messageId);
  }

  /** Deletes the conversation, its members, its messages and their deliveries. Returns how many messages. */
  private erase(id: string): number {
    this.db.prepare('DELETE FROM conversation_deliveries WHERE conversation_id = ?').run(id);
    const n = Number(this.db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(id).changes);
    this.db.prepare('DELETE FROM conversation_members WHERE conversation_id = ?').run(id);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM chat_read_state WHERE thread = ?').run(`convo:${id}`);
    return n;
  }

  remove(id: string): { removed: boolean; messages: number } {
    if (!this.row(id)) return { removed: false, messages: 0 };
    return this.tx(() => ({ removed: true, messages: this.erase(id) }));
  }

  removePerson(personId: number): number {
    return this.tx(() => removePersonOf(this.db, personId));
  }

  purge(olderThan: number): number {
    return this.tx(() => {
      this.db.prepare('DELETE FROM conversation_deliveries WHERE message_id IN (SELECT id FROM conversation_messages WHERE created_at < ?)').run(olderThan);
      return Number(this.db.prepare('DELETE FROM conversation_messages WHERE created_at < ?').run(olderThan).changes);
    });
  }
}

/**
 * A person was deleted: they leave every conversation, and each one left with no person is deleted with its members and messages. Returns how many were deleted.
 * It opens no transaction, so a person's deletion (`people.ts`) can run it inside its own.
 */
export function removePersonOf(db: DatabaseSync, personId: number): number {
  const ref = String(personId);
  const ids = db.prepare("SELECT conversation_id AS id FROM conversation_members WHERE member_kind = 'person' AND member_ref = ? ORDER BY conversation_id").all(ref) as unknown as { id: string }[];
  let deleted = 0;
  for (const { id } of ids) {
    db.prepare("DELETE FROM conversation_members WHERE conversation_id = ? AND member_kind = 'person' AND member_ref = ?").run(id, ref);
    db.prepare("DELETE FROM conversation_members WHERE conversation_id = ? AND member_kind = 'agent' AND added_by = ?").run(id, personId);
    const left = db.prepare('SELECT member_kind, member_ref, left_at FROM conversation_members WHERE conversation_id = ? ORDER BY member_kind, member_ref').all(id) as unknown as { member_kind: string; member_ref: string; left_at: number | null }[];
    const now = left.filter((m) => m.left_at == null);
    if (now.some((m) => m.member_kind === 'person')) db.prepare('UPDATE conversations SET members_key = ? WHERE id = ?').run(membersKey(now.map((m) => ({ kind: m.member_kind, ref: m.member_ref }))), id);
    else {
      db.prepare('DELETE FROM conversation_deliveries WHERE conversation_id = ?').run(id);
      db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(id);
      db.prepare('DELETE FROM conversation_members WHERE conversation_id = ?').run(id);
      db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      db.prepare('DELETE FROM chat_read_state WHERE thread = ?').run(`convo:${id}`);
      deleted += 1;
    }
  }
  return deleted;
}

/** The conversations store over the connection, each call one step under its lock. */
export function conversationsOver(db: DatabaseSync, lock: AsyncLock, scope: () => string): ConversationsApi {
  const c = new Conversations(db, scope);
  const step = <T>(fn: () => T): Promise<T> => lock.run(fn);
  return {
    open: (input, at) => step(() => c.open(input, at)),
    get: (id) => step(() => c.get(id)),
    ids: () => step(() => c.ids()),
    listFor: (member) => step(() => c.listFor(member)),
    addMembers: (id, members, addedBy, at) => step(() => c.addMembers(id, members, addedBy, at)),
    leave: (id, member, at) => step(() => c.leave(id, member, at)),
    post: (id, input, at) => step(() => c.post(id, input, at)),
    page: (id, o) => step(() => c.page(id, o)),
    getMessage: (id, messageId) => step(() => c.getMessage(id, messageId)),
    editMessage: (id, messageId, x) => step(() => c.editMessage(id, messageId, x)),
    deleteMessage: (id, messageId, x) => step(() => c.deleteMessage(id, messageId, x)),
    markHanded: (id, messageId, at) => step(() => c.markHanded(id, messageId, at)),
    setDelivery: (id, messageId, member, state, at) => step(() => c.setDelivery(id, messageId, member, state, at)),
    remove: (id) => step(() => c.remove(id)),
    removePerson: (personId) => step(() => c.removePerson(personId)),
    purge: (olderThan) => step(() => c.purge(olderThan)),
  };
}
