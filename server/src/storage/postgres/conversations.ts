// The conversations of people and agents on PostgreSQL (#1278, DECISIONS 74): the SQLite store's logic over `PgDb`. `conversations`, `conversation_members` and `conversation_messages`,
// a fourth audience in its own tables: nothing here reads or writes a channel's message or a `peer_messages` row, and the reverse (`separation.test.ts` holds the code to it).
// A call that reads then writes is one transaction, and the gate in `PgDb.tx` takes them one at a time, as the SQLite lock does.
import { decodeCursor, encodeCursor, pageSize } from '../peerText.js';
import {
  DELIVERY_COLS, MAX_CONVERSATION_MEMBERS, MEMBER_COLS, MESSAGE_COLS, checkAuthor, checkMembers, checkNewMembers, checkTargets, firstDeliveryState, membersKey, newConversationId, newConversationMessageId, nextDeliveryState, refuseConversationChange, toConversation, toConversationMessage, toConversations,
  type DbConversation, type DbConversationMessage, type DbDelivery, type DbMember,
} from '../conversationRows.js';
import type { Conversation, ConversationChange, ConversationDeliveryState, ConversationMemberInput, ConversationMemberKind, ConversationMessage, ConversationPage, ConversationPostInput, ConversationsApi } from '../types.js';
import type { PgDb } from './conn.js';

type MemberRef = { kind: ConversationMemberKind; ref: string };

class PgConversations {
  constructor(
    private readonly db: PgDb,
    private readonly scope: () => Promise<string>,
  ) {}

  private row(id: string): Promise<DbConversation | undefined> {
    return this.db.get<DbConversation>('SELECT id, created_at, members_key FROM conversations WHERE id = ?', [id]);
  }

  private membersOf(id: string): Promise<DbMember[]> {
    return this.db.all<DbMember>(`SELECT ${MEMBER_COLS} FROM conversation_members WHERE conversation_id = ? ORDER BY joined_at, member_kind, member_ref`, [id]);
  }

  private async load(id: string): Promise<Conversation | null> {
    const r = await this.row(id);
    if (!r) return null;
    const m = (await this.db.get<{ last: number | null; n: number }>('SELECT MAX(created_at) AS last, COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ?', [id])) as { last: number | null; n: number };
    return toConversation(r, await this.membersOf(id), m.last, m.n);
  }

  private async current(id: string): Promise<MemberRef[]> {
    return (await this.membersOf(id)).filter((m) => m.left_at == null).map((m) => ({ kind: m.member_kind as ConversationMemberKind, ref: m.member_ref }));
  }

  private async rekey(id: string): Promise<void> {
    await this.db.run('UPDATE conversations SET members_key = ? WHERE id = ?', [membersKey(await this.current(id)), id]);
  }

  private async insertMember(id: string, m: ConversationMemberInput, addedBy: number | null, at: number): Promise<void> {
    await this.db.run('INSERT INTO conversation_members (conversation_id, member_kind, member_ref, member_name, added_by, joined_at, left_at) VALUES (?, ?, ?, ?, ?, ?, NULL)', [id, m.kind, m.ref, m.name, addedBy, at]);
  }

  open(input: { members: ConversationMemberInput[]; createdBy: number | null }, at: number): Promise<{ conversation: Conversation; created: boolean }> {
    return this.db.tx(async () => {
      const members = checkNewMembers(input.members);
      const key = membersKey(members);
      const found = await this.db.get<{ id: string }>('SELECT id FROM conversations WHERE members_key = ? ORDER BY created_at, id LIMIT 1', [key]);
      if (found) return { conversation: (await this.load(found.id)) as Conversation, created: false };
      const id = newConversationId(await this.scope());
      await this.db.run('INSERT INTO conversations (id, created_at, members_key) VALUES (?, ?, ?)', [id, at, key]);
      for (const m of members) await this.insertMember(id, m, m.kind === 'person' && input.createdBy !== null && m.ref === String(input.createdBy) ? null : input.createdBy, at);
      return { conversation: (await this.load(id)) as Conversation, created: true };
    });
  }

  get(id: string): Promise<Conversation | null> {
    return this.load(id);
  }

  async ids(): Promise<string[]> {
    return (await this.db.all<{ id: string }>('SELECT id FROM conversations ORDER BY id')).map((r) => r.id);
  }

  async listFor(member: MemberRef): Promise<Conversation[]> {
    // The conversations the member is in now, and their members and message totals: three statements however many there are (#1309).
    const mine = 'SELECT conversation_id FROM conversation_members WHERE member_kind = ? AND member_ref = ? AND left_at IS NULL';
    const args = [member.kind, member.ref];
    return toConversations(
      // order-insensitive: the rows are folded into one conversation each by `toConversations`, which sorts them.
      await this.db.all<DbConversation>(`SELECT id, created_at, members_key FROM conversations WHERE id IN (${mine})`, args),
      // order-insensitive: the rows are folded into one conversation each by `toConversations`, which sorts them.
      await this.db.all<DbMember>(`SELECT ${MEMBER_COLS} FROM conversation_members WHERE conversation_id IN (${mine})`, args),
      // order-insensitive: the rows are folded into one conversation each by `toConversations`, which sorts them.
      await this.db.all<{ conversation_id: string; last: number | null; n: number }>(`SELECT conversation_id, MAX(created_at) AS last, COUNT(*) AS n FROM conversation_messages WHERE conversation_id IN (${mine}) GROUP BY conversation_id`, args),
    );
  }

  addMembers(id: string, members: ConversationMemberInput[], addedBy: number | null, at: number): Promise<Conversation | null> {
    return this.db.tx(async () => {
      if (!(await this.row(id))) return null;
      const list = checkMembers(members);
      const have = new Map((await this.membersOf(id)).map((m) => [`${m.member_kind}:${m.member_ref}`, m]));
      const inNow = new Set((await this.current(id)).map((m) => `${m.kind}:${m.ref}`));
      for (const m of list) inNow.add(`${m.kind}:${m.ref}`);
      if (inNow.size > MAX_CONVERSATION_MEMBERS) throw new Error(`A conversation has at most ${MAX_CONVERSATION_MEMBERS} members.`);
      for (const m of list) {
        const old = have.get(`${m.kind}:${m.ref}`);
        if (!old) await this.insertMember(id, m, addedBy, at);
        else if (old.left_at != null) await this.db.run('UPDATE conversation_members SET left_at = NULL, joined_at = ?, added_by = ?, member_name = ? WHERE conversation_id = ? AND member_kind = ? AND member_ref = ?', [at, addedBy, m.name, id, m.kind, m.ref]);
      }
      await this.rekey(id);
      return this.load(id);
    });
  }

  leave(id: string, member: MemberRef, at: number): Promise<{ conversation: Conversation | null; deleted: boolean } | null> {
    return this.db.tx(async () => {
      const mine = (await this.membersOf(id)).find((m) => m.member_kind === member.kind && m.member_ref === member.ref && m.left_at == null);
      if (!mine) return null;
      await this.db.run('UPDATE conversation_members SET left_at = ? WHERE conversation_id = ? AND member_kind = ? AND member_ref = ?', [at, id, member.kind, member.ref]);
      // The agents this person added leave with them: an agent never stays where its owner can no longer see or stop it.
      if (member.kind === 'person') await this.db.run("UPDATE conversation_members SET left_at = ? WHERE conversation_id = ? AND member_kind = 'agent' AND added_by = ? AND left_at IS NULL", [at, id, Number(member.ref)]);
      if (!(await this.current(id)).some((m) => m.kind === 'person')) {
        await this.erase(id);
        return { conversation: null, deleted: true };
      }
      await this.rekey(id);
      return { conversation: await this.load(id), deleted: false };
    });
  }

  post(id: string, input: ConversationPostInput, at: number): Promise<ConversationMessage | null> {
    return this.db.tx(async () => {
      const kind = checkAuthor(input.authorKind);
      if (!(await this.row(id))) return null;
      if (!(await this.current(id)).some((m) => m.kind === kind && m.ref === input.authorRef)) return null;
      const targets = checkTargets(input.targets, await this.current(id), { kind, ref: input.authorRef });
      const mid = newConversationMessageId(await this.scope());
      // `seq` is the next number in the table: the gate in `PgDb.tx` lets one transaction at a time reach this insert.
      await this.db.run(
        `INSERT INTO conversation_messages (id, conversation_id, author_kind, author_ref, author_name, author_id, text, created_at, reply_to, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM conversation_messages))`,
        [mid, id, kind, input.authorRef, input.authorName, kind === 'person' ? (input.authorId ?? null) : null, input.text, at, input.replyTo ?? null],
      );
      for (const t of targets) {
        const state = firstDeliveryState(t.kind);
        await this.db.run('INSERT INTO conversation_deliveries (conversation_id, message_id, member_kind, member_ref, member_name, named, state, state_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, mid, t.kind, t.ref, t.name, t.named ? 1 : 0, state, state === null ? null : at]);
      }
      return this.message(id, mid);
    });
  }

  private raw(id: string, messageId: string): Promise<DbConversationMessage | undefined> {
    return this.db.get<DbConversationMessage>(`SELECT ${MESSAGE_COLS} FROM conversation_messages WHERE id = ? AND conversation_id = ?`, [messageId, id]);
  }

  private deliveriesOf(id: string, messageIds: string[]): Promise<DbDelivery[]> {
    if (!messageIds.length) return Promise.resolve([]);
    const marks = messageIds.map(() => '?').join(', ');
    return this.db.all<DbDelivery>(`SELECT ${DELIVERY_COLS} FROM conversation_deliveries WHERE conversation_id = ? AND message_id IN (${marks}) ORDER BY message_id, member_kind, member_ref`, [id, ...messageIds]);
  }

  private async message(id: string, messageId: string): Promise<ConversationMessage | null> {
    const r = await this.raw(id, messageId);
    return r ? toConversationMessage(r, await this.deliveriesOf(id, [messageId])) : null;
  }

  async page(id: string, opts: { before?: string | null; limit: number }): Promise<ConversationPage> {
    const before = opts.before === undefined || opts.before === null ? null : decodeCursor(opts.before);
    const limit = pageSize(opts.limit);
    const rows = before
      ? await this.db.all<DbConversationMessage>(`SELECT ${MESSAGE_COLS} FROM conversation_messages WHERE conversation_id = ? AND (created_at < ? OR (created_at = ? AND seq < ?)) ORDER BY created_at DESC, seq DESC LIMIT ?`, [id, before.at, before.at, before.seq, limit + 1])
      : await this.db.all<DbConversationMessage>(`SELECT ${MESSAGE_COLS} FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?`, [id, limit + 1]);
    const kept = rows.slice(0, limit).reverse();
    const oldest = kept[0];
    const deliveries = await this.deliveriesOf(id, kept.map((r) => r.id));
    return { messages: kept.map((r) => toConversationMessage(r, deliveries)), older: rows.length > limit && oldest ? encodeCursor(Number(oldest.created_at), Number(oldest.seq)) : null };
  }

  getMessage(id: string, messageId: string): Promise<ConversationMessage | null> {
    return this.message(id, messageId);
  }

  editMessage(id: string, messageId: string, x: { author: number; text: string; now: number }): Promise<ConversationChange> {
    return this.db.tx(async () => {
      const refused = refuseConversationChange(await this.raw(id, messageId), x.author);
      if (refused) return refused;
      await this.db.run('UPDATE conversation_messages SET text = ?, edited_at = ? WHERE id = ?', [x.text, x.now, messageId]);
      return { ok: true, message: (await this.message(id, messageId)) as ConversationMessage };
    });
  }

  deleteMessage(id: string, messageId: string, x: { author: number; now: number }): Promise<ConversationChange> {
    return this.db.tx(async () => {
      const refused = refuseConversationChange(await this.raw(id, messageId), x.author);
      if (refused) return refused;
      await this.db.run("UPDATE conversation_messages SET text = '', deleted_at = ? WHERE id = ?", [x.now, messageId]);
      return { ok: true, message: (await this.message(id, messageId)) as ConversationMessage };
    });
  }

  markHanded(id: string, messageId: string, at: number): Promise<ConversationMessage | null> {
    return this.db.tx(async () => {
      if (!(await this.raw(id, messageId))) return null;
      await this.db.run('UPDATE conversation_messages SET handed_at = COALESCE(handed_at, ?) WHERE id = ?', [at, messageId]);
      return this.message(id, messageId);
    });
  }

  setDelivery(id: string, messageId: string, member: MemberRef, state: ConversationDeliveryState, at: number): Promise<ConversationMessage | null> {
    return this.db.tx(async () => {
      const d = await this.db.get<DbDelivery>(`SELECT ${DELIVERY_COLS} FROM conversation_deliveries WHERE conversation_id = ? AND message_id = ? AND member_kind = ? AND member_ref = ?`, [id, messageId, member.kind, member.ref]);
      if (!d) return null;
      const next = nextDeliveryState(d.state, state);
      if (next) await this.db.run('UPDATE conversation_deliveries SET state = ?, state_at = ? WHERE conversation_id = ? AND message_id = ? AND member_kind = ? AND member_ref = ?', [next, at, id, messageId, member.kind, member.ref]);
      return this.message(id, messageId);
    });
  }

  /** Deletes the conversation, its members, its messages and their deliveries. Returns how many messages. */
  private async erase(id: string): Promise<number> {
    await this.db.run('DELETE FROM conversation_deliveries WHERE conversation_id = ?', [id]);
    const n = await this.db.run('DELETE FROM conversation_messages WHERE conversation_id = ?', [id]);
    await this.db.run('DELETE FROM conversation_members WHERE conversation_id = ?', [id]);
    await this.db.run('DELETE FROM conversations WHERE id = ?', [id]);
    await this.db.run('DELETE FROM chat_read_state WHERE thread = ?', [`convo:${id}`]);
    return n;
  }

  remove(id: string): Promise<{ removed: boolean; messages: number }> {
    return this.db.tx(async () => {
      if (!(await this.row(id))) return { removed: false, messages: 0 };
      return { removed: true, messages: await this.erase(id) };
    });
  }

  removePerson(personId: number): Promise<number> {
    return this.db.tx(() => removePersonOf(this.db, personId));
  }

  purge(olderThan: number): Promise<number> {
    return this.db.tx(async () => {
      await this.db.run('DELETE FROM conversation_deliveries WHERE message_id IN (SELECT id FROM conversation_messages WHERE created_at < ?)', [olderThan]);
      return this.db.run('DELETE FROM conversation_messages WHERE created_at < ?', [olderThan]);
    });
  }
}

/**
 * A person was deleted: they leave every conversation, and each one left with no person is deleted with its members and messages. Returns how many were deleted.
 * It opens no transaction, so a person's deletion (`people.ts`) can run it inside its own.
 */
export async function removePersonOf(db: PgDb, personId: number): Promise<number> {
  const ref = String(personId);
  const ids = await db.all<{ id: string }>("SELECT conversation_id AS id FROM conversation_members WHERE member_kind = 'person' AND member_ref = ? ORDER BY conversation_id", [ref]);
  let deleted = 0;
  for (const { id } of ids) {
    await db.run("DELETE FROM conversation_members WHERE conversation_id = ? AND member_kind = 'person' AND member_ref = ?", [id, ref]);
    await db.run("DELETE FROM conversation_members WHERE conversation_id = ? AND member_kind = 'agent' AND added_by = ?", [id, personId]);
    const left = await db.all<{ member_kind: string; member_ref: string; left_at: number | null }>('SELECT member_kind, member_ref, left_at FROM conversation_members WHERE conversation_id = ? ORDER BY member_kind, member_ref', [id]);
    const now = left.filter((m) => m.left_at == null);
    if (now.some((m) => m.member_kind === 'person')) await db.run('UPDATE conversations SET members_key = ? WHERE id = ?', [membersKey(now.map((m) => ({ kind: m.member_kind, ref: m.member_ref }))), id]);
    else {
      await db.run('DELETE FROM conversation_deliveries WHERE conversation_id = ?', [id]);
      await db.run('DELETE FROM conversation_messages WHERE conversation_id = ?', [id]);
      await db.run('DELETE FROM conversation_members WHERE conversation_id = ?', [id]);
      await db.run('DELETE FROM conversations WHERE id = ?', [id]);
      await db.run('DELETE FROM chat_read_state WHERE thread = ?', [`convo:${id}`]);
      deleted += 1;
    }
  }
  return deleted;
}

/** The conversations store over the connection. */
export function pgConversations(db: PgDb, scope: () => Promise<string>): ConversationsApi {
  const c = new PgConversations(db, scope);
  return {
    open: (input, at) => c.open(input, at),
    get: (id) => c.get(id),
    ids: () => c.ids(),
    listFor: (member) => c.listFor(member),
    addMembers: (id, members, addedBy, at) => c.addMembers(id, members, addedBy, at),
    leave: (id, member, at) => c.leave(id, member, at),
    post: (id, input, at) => c.post(id, input, at),
    page: (id, o) => c.page(id, o),
    getMessage: (id, messageId) => c.getMessage(id, messageId),
    editMessage: (id, messageId, x) => c.editMessage(id, messageId, x),
    deleteMessage: (id, messageId, x) => c.deleteMessage(id, messageId, x),
    markHanded: (id, messageId, at) => c.markHanded(id, messageId, at),
    setDelivery: (id, messageId, member, state, at) => c.setDelivery(id, messageId, member, state, at),
    remove: (id) => c.remove(id),
    removePerson: (personId) => c.removePerson(personId),
    purge: (olderThan) => c.purge(olderThan),
  };
}
