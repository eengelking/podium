// The Chat page's stores on SQLite (#1034): the group channel (`group_messages`), General (`public_messages`) and each person's read state per
// thread (`chat_read_state`). Nothing here reads or writes a direct message (the conversation table): a channel's text and a conversation's text are in
// different tables, read by different methods, on purpose (the maintainer's hard rule; `separation.test.ts` holds the code to it).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { AsyncLock } from '../lock.js';
import { conversationsOver } from './conversations.js';
import { chunksOf } from '../batches.js';
import { decodeCursor, encodeCursor, pageSize } from '../peerText.js';
import {
  CHANNEL_COLS, CHAT_SCOPE_KEY, GENERAL_CHANNEL, MAX_PUBLIC_CHANNELS, adminKeyOf, channelKey, channelRefusal, chatSettingsOver, checkAuthorKind, checkDescription, checkNewChannel, emptyReadState, foldBumps, heldLikes, holdsHeld, holdsMention, idList, idText, mentionLike, mentionsOf, newChannelId, newServerScope, OWED_CAP_MS, OWED_FILLED_KEY, owedIds, personKey, refuseChange, toChannelMessage, toPublicChannel, withMentionState, type DbChannelRow, type DbPublicChannel,
} from '../chatRows.js';
import type { AdminReadKind, AdminReadRow, ChannelChange, ChannelMessage, ChannelPage, ChannelPostInput, ChannelStoreApi, ChatAdminReadsApi, ChatReadStateApi, ChatStoreApi, ChatStoreOptions, GroupScope, MentionState, NewPublicChannel, PublicChannel, PublicChannelOutcome, PublicChannelsApi, PublicStoreApi, ReadBump, ThreadReadState } from '../types.js';

const GROUP_COLS = 'id, owner_id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq, author_id, edited_at, deleted_at';
const PUBLIC_COLS = 'id, channel, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq, author_id, edited_at, deleted_at';

/** Which messages of a table: one person's group, or one public channel (#1035). */
type Scope = GroupScope | { channel: string };

/** One channel table. `grouped` is the group table, whose every statement is scoped to an owner and a group. */
class Channel {
  private readonly stmts = new Map<string, StatementSync>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly table: 'group_messages' | 'public_messages',
    private readonly now: () => number,
    private readonly scope: () => string,
  ) {}

  private get grouped(): boolean {
    return this.table === 'group_messages';
  }

  private get cols(): string {
    return this.grouped ? GROUP_COLS : PUBLIC_COLS;
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** The `WHERE` for the channel and the values that fill it. */
  private where(scope: Scope): { sql: string; args: (string | number)[] } {
    return 'channel' in scope ? { sql: 'channel = ?', args: [scope.channel] } : { sql: 'owner_id = ?', args: [scope.ownerId] };
  }

  private byId(id: string, scope: Scope): DbChannelRow | undefined {
    const w = this.where(scope);
    return this.stmt(`SELECT ${this.cols} FROM ${this.table} WHERE id = ? AND ${w.sql}`).get(id, ...w.args) as unknown as DbChannelRow | undefined;
  }

  post(scope: Scope, input: ChannelPostInput): ChannelMessage {
    const kind = checkAuthorKind(input.authorKind);
    const at = this.now();
    const mentions = mentionsOf(input, at);
    const id = newChannelId(this.grouped ? 'grp' : 'pub', this.scope());
    const common = [id, kind, input.authorRef, input.authorName, input.text, at, at, input.issue ?? null, input.project ?? null, input.milestone ?? null, input.replyTo ?? null, JSON.stringify(mentions), kind === 'person' ? (input.authorId ?? null) : null] as const;
    if (!('channel' in scope)) {
      this.stmt(
        `INSERT INTO group_messages (id, owner, group_id, owner_id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, author_id, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM group_messages))`,
        // `owner` and `group_id` are the older name key and are not read (#1284); they hold the id's key so a name never lands in them.
      ).run(common[0], personKey(scope.ownerId), personKey(scope.ownerId), scope.ownerId, ...common.slice(1));
    } else {
      // A channel that is not General must exist, so a post can never fill a channel an Admin has just removed.
      if (scope.channel !== GENERAL_CHANNEL && !this.stmt('SELECT 1 AS x FROM public_channels WHERE name = ?').get(scope.channel)) throw new Error('There is no such public channel.');
      this.stmt(
        `INSERT INTO public_messages (id, channel, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, author_id, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM public_messages))`,
      ).run(common[0], scope.channel, ...common.slice(1));
    }
    return toChannelMessage(this.byId(id, scope) as DbChannelRow);
  }

  page(scope: Scope, opts: { before?: string | null; limit: number }): ChannelPage {
    const before = opts.before === undefined || opts.before === null ? null : decodeCursor(opts.before);
    const limit = pageSize(opts.limit);
    const w = this.where(scope);
    const rows = (
      before
        ? this.stmt(`SELECT ${this.cols} FROM ${this.table} WHERE ${w.sql} AND (created_at < ? OR (created_at = ? AND seq < ?)) ORDER BY created_at DESC, seq DESC LIMIT ?`).all(...w.args, before.at, before.at, before.seq, limit + 1)
        : this.stmt(`SELECT ${this.cols} FROM ${this.table} WHERE ${w.sql} ORDER BY created_at DESC, seq DESC LIMIT ?`).all(...w.args, limit + 1)
    ) as unknown as DbChannelRow[];
    // The extra row only says there is an older page; the cursor names the oldest row kept.
    const kept = rows.slice(0, limit).reverse();
    const oldest = kept[0];
    return { messages: kept.map(toChannelMessage), older: rows.length > limit && oldest ? encodeCursor(oldest.created_at, oldest.seq) : null };
  }

  setMention(scope: Scope, id: string, index: number, patch: { state: MentionState; why?: string | null; copyId?: string | null }): ChannelMessage | null {
    const row = this.byId(id, scope);
    if (!row) return null;
    const at = this.now();
    const next = withMentionState(toChannelMessage(row).mentions, index, patch, at);
    if (!next) return null;
    this.stmt(`UPDATE ${this.table} SET mentions_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(next), at, id);
    return toChannelMessage(this.byId(id, scope) as DbChannelRow);
  }

  /** One message by id in this scope, a tombstone too (#1269). */
  getMessage(scope: Scope, id: string): ChannelMessage | null {
    const row = this.byId(id, scope);
    return row ? toChannelMessage(row) : null;
  }

  /** The author changes the text of their own message (#1269). The row is read and written inside one step of the lock, so a delivery cannot change it in between. */
  editMessage(scope: Scope, id: string, x: { author: number; text: string; now: number }): ChannelChange {
    const row = this.byId(id, scope);
    const refused = refuseChange(row, x.author);
    if (refused) return refused;
    this.stmt(`UPDATE ${this.table} SET text = ?, edited_at = ?, updated_at = ? WHERE id = ?`).run(x.text, x.now, x.now, id);
    return { ok: true, message: toChannelMessage(this.byId(id, scope) as DbChannelRow) };
  }

  /** The author deletes their own message (#1269): the row stays, with no text and no mentions. */
  deleteMessage(scope: Scope, id: string, x: { author: number; now: number }): ChannelChange {
    const refused = refuseChange(this.byId(id, scope), x.author);
    if (refused) return refused;
    this.stmt(`UPDATE ${this.table} SET text = '', mentions_json = '[]', deleted_at = ?, updated_at = ? WHERE id = ?`).run(x.now, x.now, id);
    return { ok: true, message: toChannelMessage(this.byId(id, scope) as DbChannelRow) };
  }

  /** The held mentions of one channel, or (with no `scope`) of every channel of the table in one read (#1309). */
  heldMentions(scope: Scope | null, filter: { sessionId?: string }): ChannelMessage[] {
    const w = scope ? this.where(scope) : { sql: '1 = 1', args: [] };
    const likes = heldLikes(filter.sessionId);
    const rows = this.stmt(`SELECT ${this.cols} FROM ${this.table} WHERE ${w.sql} AND ${likes.map(() => 'mentions_json LIKE ?').join(' AND ')} ORDER BY created_at, seq`).all(...w.args, ...likes) as unknown as DbChannelRow[];
    return rows.map(toChannelMessage).filter((m) => holdsHeld(m, filter.sessionId));
  }

  /** The messages of every channel with a mention of `sessionId` in one of `states`, written by a person, oldest first (#1213). */
  mentionsAcross(filter: { sessionId: string; states: MentionState[] }): ChannelMessage[] {
    const rows = this.stmt(`SELECT ${this.cols} FROM ${this.table} WHERE author_kind = 'person' AND mentions_json LIKE ? ORDER BY created_at, seq`).all(mentionLike(filter.sessionId)) as unknown as DbChannelRow[];
    return rows.map(toChannelMessage).filter((m) => holdsMention(m, filter.sessionId, filter.states));
  }

  /** How many messages each channel holds, in one query; a channel with none is absent (#1213). */
  counts(): Record<string, number> {
    const rows = this.stmt(`SELECT channel, COUNT(*) AS n FROM ${this.table} GROUP BY channel ORDER BY channel`).all() as unknown as { channel: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.channel, Number(r.n)]));
  }

  clear(scope: Scope): number {
    const w = this.where(scope);
    return Number(this.stmt(`DELETE FROM ${this.table} WHERE ${w.sql}`).run(...w.args).changes);
  }

  count(scope: Scope): number {
    const w = this.where(scope);
    return (this.stmt(`SELECT COUNT(*) AS n FROM ${this.table} WHERE ${w.sql}`).get(...w.args) as { n: number }).n;
  }

  purge(olderThan: number): number {
    return Number(this.stmt(`DELETE FROM ${this.table} WHERE created_at < ?`).run(olderThan).changes);
  }
}

/** The public channels beside General (#1035): the rows of `public_channels`. Their messages are `public_messages` rows keyed by the channel. */
class PublicChannels {
  constructor(private readonly db: DatabaseSync) {}

  private row(name: string): DbPublicChannel | undefined {
    return this.db.prepare(`SELECT ${CHANNEL_COLS} FROM public_channels WHERE name = ?`).get(name) as unknown as DbPublicChannel | undefined;
  }

  create(input: NewPublicChannel, at: number): PublicChannelOutcome {
    const c = checkNewChannel(input);
    if ('ok' in c) return c;
    if (this.row(c.name)) return channelRefusal('name-taken', `There is already a channel named ${c.name}.`);
    if (c.link && this.db.prepare('SELECT 1 AS x FROM public_channels WHERE link_key = ?').get(c.link.key)) return channelRefusal('link-taken', 'That link already has a channel.');
    // The limit is in the insert itself, so no second insert can pass it between a count and this statement.
    const made = this.db
      .prepare(
        // `created_by` is the older name key and is not read (#1284); the opener is `created_by_id`.
        `INSERT INTO public_channels (name, description, link_kind, link_ref, link_key, created_by, created_by_id, created_by_name, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, '', ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM public_channels) < ?`,
      )
      .run(c.name, c.description, c.link?.kind ?? null, c.link?.ref ?? null, c.link?.key ?? null, c.createdById, c.createdByName, at, at, MAX_PUBLIC_CHANNELS);
    if (Number(made.changes) === 0) return channelRefusal('limit-reached', `There are already ${MAX_PUBLIC_CHANNELS} channels besides General.`);
    return { ok: true, channel: toPublicChannel(this.row(c.name) as DbPublicChannel) };
  }

  list(): PublicChannel[] {
    return (this.db.prepare(`SELECT ${CHANNEL_COLS} FROM public_channels ORDER BY name`).all() as unknown as DbPublicChannel[]).map(toPublicChannel);
  }

  get(name: string): PublicChannel | null {
    const r = this.row(channelKey(name));
    return r ? toPublicChannel(r) : null;
  }

  updateDescription(name: string, description: string, at: number): PublicChannelOutcome {
    const key = channelKey(name);
    if (!this.row(key)) return channelRefusal('not-found', 'There is no such public channel.');
    const bad = checkDescription(description);
    if (bad) return bad;
    this.db.prepare('UPDATE public_channels SET description = ?, updated_at = ? WHERE name = ?').run(description, at, key);
    return { ok: true, channel: toPublicChannel(this.row(key) as DbPublicChannel) };
  }

  remove(name: string): { removed: boolean; messages: number } {
    const key = channelKey(name);
    if (!this.row(key)) return { removed: false, messages: 0 };
    this.db.exec('SAVEPOINT remove_public_channel');
    try {
      const messages = Number(this.db.prepare('DELETE FROM public_messages WHERE channel = ?').run(key).changes);
      this.db.prepare('DELETE FROM public_channels WHERE name = ?').run(key);
      this.db.exec('RELEASE remove_public_channel');
      return { removed: true, messages };
    } catch (err) {
      this.db.exec('ROLLBACK TO remove_public_channel');
      this.db.exec('RELEASE remove_public_channel');
      throw err;
    }
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM public_channels').get() as { n: number }).n;
  }
}

/** A read state row. `person` is the older name key, which holds `#<id>` now and is not read (#1284); the person is `person_id`. */
interface DbReadState {
  person_id: number;
  thread: string;
  last_read: string | null;
  unread: number;
  mentions: number;
  updated_at: number;
}

const toState = (r: DbReadState): ThreadReadState => ({ personId: Number(r.person_id), thread: r.thread, lastRead: r.last_read, unread: r.unread, mentions: r.mentions, updatedAt: r.updated_at });

class ReadState {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  get(personId: number, thread: string): ThreadReadState {
    const r = this.db.prepare('SELECT person_id, thread, last_read, unread, mentions, updated_at FROM chat_read_state WHERE person_id = ? AND thread = ?').get(personId, thread) as unknown as DbReadState | undefined;
    return r ? toState(r) : emptyReadState(personId, thread);
  }

  list(personId: number): ThreadReadState[] {
    return (this.db.prepare('SELECT person_id, thread, last_read, unread, mentions, updated_at FROM chat_read_state WHERE person_id = ? ORDER BY thread').all(personId) as unknown as DbReadState[]).map(toState);
  }

  /** One insert (and one read) for each batch of people: the number of statements does not grow with the people (#1309). */
  bumpMany(thread: string, bumps: readonly ReadBump[]): ThreadReadState[] {
    const out = new Map<number, ThreadReadState>();
    const at = this.now();
    const folded = foldBumps(bumps);
    for (const part of chunksOf(folded)) {
      this.db
        .prepare(
          `INSERT INTO chat_read_state (person, person_id, thread, last_read, unread, mentions, updated_at) VALUES ${part.map(() => '(?, ?, ?, NULL, ?, ?, ?)').join(', ')}
           ON CONFLICT(person, thread) DO UPDATE SET unread = unread + excluded.unread, mentions = mentions + excluded.mentions, updated_at = excluded.updated_at`,
        )
        .run(...part.flatMap((b) => [personKey(b.personId), b.personId, thread, b.unread, b.mentions, at]));
      // order-insensitive: the rows are put into a map by person, and the answer follows the order the people were given.
      const rows = this.db.prepare(`SELECT person_id, thread, last_read, unread, mentions, updated_at FROM chat_read_state WHERE thread = ? AND person_id IN (${part.map(() => '?').join(', ')})`).all(thread, ...part.map((b) => b.personId)) as unknown as DbReadState[];
      for (const r of rows) out.set(Number(r.person_id), toState(r));
    }
    return folded.map((b) => out.get(b.personId) as ThreadReadState);
  }

  markRead(personId: number, thread: string, upTo: string | null): ThreadReadState {
    this.db
      .prepare(
        `INSERT INTO chat_read_state (person, person_id, thread, last_read, unread, mentions, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?)
         ON CONFLICT(person, thread) DO UPDATE SET last_read = excluded.last_read, unread = 0, mentions = 0, updated_at = excluded.updated_at`,
      )
      .run(personKey(personId), personId, thread, upTo, this.now());
    return this.get(personId, thread);
  }

  forget(thread: string): number {
    return Number(this.db.prepare('DELETE FROM chat_read_state WHERE thread = ?').run(thread).changes);
  }

  threads(prefix: string): string[] {
    return (this.db.prepare('SELECT DISTINCT thread FROM chat_read_state WHERE substr(thread, 1, ?) = ? ORDER BY thread').all(prefix.length, prefix) as unknown as { thread: string }[]).map((r) => r.thread);
  }
}

interface DbAdminRead {
  thread: string;
  admin: string;
  started_at: number;
  last_seen_at: number;
  kind: AdminReadKind;
}

interface DbOwed {
  thread: string;
  admin_key: string;
  started_at: number;
  people: string;
  seen: string;
}

const toRead = (r: DbAdminRead): AdminReadRow => ({ admin: r.admin, startedAt: r.started_at, lastSeenAt: r.last_seen_at, kind: r.kind });

/** One person owed one Admin record (#1061). */
const owe = (db: DatabaseSync, thread: string, adminKey: string, startedAt: number, people: number[]): void => {
  for (const p of people) db.prepare('INSERT INTO chat_admin_owed (person_key, person_id, thread, admin_key, started_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(personKey(p), p, thread, adminKey, startedAt);
};

/** Once, fills `chat_admin_owed` from the lists of the records made before it (#1061); the key is set last, so an interrupted fill runs again and adds nothing twice. */
export function fillOwed(db: DatabaseSync): void {
  if (db.prepare('SELECT 1 AS x FROM settings WHERE key = ?').get(OWED_FILLED_KEY)) return;
  const rows = db.prepare("SELECT thread, admin_key, started_at, people, seen FROM chat_admin_reads WHERE people <> '[]' ORDER BY thread, started_at, admin_key").all() as unknown as DbOwed[];
  for (const r of rows) owe(db, r.thread, r.admin_key, r.started_at, owedIds(r));
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(OWED_FILLED_KEY, '1');
}

/** The records of an Admin reading a thread that is not theirs (`chat_admin_reads`): who, which thread and when. Never any text. */
class AdminReads {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {
    fillOwed(db);
  }

  private owe(thread: string, adminKey: string, startedAt: number, people: number[]): void {
    owe(this.db, thread, adminKey, startedAt, people);
  }

  touch(thread: string, admin: string, adminId: number | null, gapMs: number, people: number[] = []): { record: AdminReadRow; started: boolean; previousSeenAt: number | null } {
    const now = this.now();
    const key = adminKeyOf(admin, adminId);
    const last = this.db.prepare("SELECT thread, admin, started_at, last_seen_at, kind FROM chat_admin_reads WHERE thread = ? AND admin_key = ? AND kind = 'read' ORDER BY last_seen_at DESC, started_at DESC LIMIT 1").get(thread, key) as unknown as DbAdminRead | undefined;
    if (last && now - last.last_seen_at <= gapMs) {
      const seen = Math.max(now, last.last_seen_at);
      this.db.prepare("UPDATE chat_admin_reads SET last_seen_at = ? WHERE thread = ? AND admin_key = ? AND started_at = ? AND kind = 'read'").run(seen, thread, key, last.started_at);
      return { record: { admin: last.admin, startedAt: last.started_at, lastSeenAt: seen, kind: 'read' }, started: false, previousSeenAt: last.last_seen_at };
    }
    const row = this.insert(thread, key, admin, now, 'read', people);
    return { record: row, started: true, previousSeenAt: null };
  }

  mark(thread: string, admin: string, adminId: number | null, kind: Exclude<AdminReadKind, 'read'>, people: number[] = []): AdminReadRow {
    return this.insert(thread, adminKeyOf(admin, adminId), admin, this.now(), kind, people);
  }

  /** One record at `at`, or the first free millisecond after it, since (thread, admin, time) is the key. */
  private insert(thread: string, key: string, admin: string, at: number, kind: AdminReadKind, people: number[]): AdminReadRow {
    let t = at;
    while (this.db.prepare('SELECT 1 AS x FROM chat_admin_reads WHERE thread = ? AND admin_key = ? AND started_at = ?').get(thread, key, t)) t++;
    this.db.prepare('INSERT INTO chat_admin_reads (thread, admin_key, admin, started_at, last_seen_at, kind, people, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(thread, key, admin, t, t, kind, idText(people), '[]');
    this.owe(thread, key, t, idList(idText(people)));
    return { admin, startedAt: t, lastSeenAt: t, kind };
  }

  list(thread: string): AdminReadRow[] {
    return (this.db.prepare('SELECT thread, admin, started_at, last_seen_at, kind FROM chat_admin_reads WHERE thread = ? ORDER BY started_at, admin_key, kind').all(thread) as unknown as DbAdminRead[]).map(toRead);
  }

  live(threads: string[], since: number): (AdminReadRow & { thread: string })[] {
    if (!threads.length) return [];
    const marks = threads.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT thread, admin, started_at, last_seen_at, kind FROM chat_admin_reads WHERE thread IN (${marks}) AND kind = 'read' AND last_seen_at > ? ORDER BY thread, started_at, admin_key`)
      .all(...threads, since) as unknown as DbAdminRead[];
    return rows.map((r) => ({ thread: r.thread, ...toRead(r) }));
  }

  recent(since: number): (AdminReadRow & { thread: string })[] {
    const rows = this.db
      .prepare("SELECT thread, admin, started_at, last_seen_at, kind FROM chat_admin_reads WHERE kind = 'read' AND last_seen_at > ? ORDER BY thread, started_at, admin_key")
      .all(since) as unknown as DbAdminRead[];
    return rows.map((r) => ({ thread: r.thread, ...toRead(r) }));
  }

  threads(prefix: string): string[] {
    return (this.db.prepare('SELECT DISTINCT thread FROM chat_admin_reads WHERE substr(thread, 1, ?) = ? ORDER BY thread').all(prefix.length, prefix) as unknown as { thread: string }[]).map((r) => r.thread);
  }

  seen(thread: string, personId: number): number {
    return Number(this.db.prepare('DELETE FROM chat_admin_owed WHERE person_id = ? AND thread = ?').run(personId, thread).changes);
  }

  unseenFor(personId: number): (AdminReadRow & { thread: string })[] {
    const rows = this.db
      .prepare(
        `SELECT r.thread, r.admin, r.started_at, r.last_seen_at, r.kind FROM chat_admin_owed o
         JOIN chat_admin_reads r ON r.thread = o.thread AND r.admin_key = o.admin_key AND r.started_at = o.started_at
         WHERE o.person_id = ? ORDER BY r.started_at DESC, r.thread, r.admin_key, r.kind`,
      )
      .all(personId) as unknown as DbAdminRead[];
    return rows.map((r) => ({ thread: r.thread, ...toRead(r) }));
  }

  /** Deletes the records matched by `where` that nobody is still owed a look at. */
  private drop(where: string, ...values: (string | number)[]): number {
    const sql = `DELETE FROM chat_admin_reads WHERE ${where} AND NOT EXISTS (SELECT 1 FROM chat_admin_owed o WHERE o.thread = chat_admin_reads.thread AND o.admin_key = chat_admin_reads.admin_key AND o.started_at = chat_admin_reads.started_at)`;
    return Number(this.db.prepare(sql).run(...values).changes);
  }

  forget(thread: string): number {
    return this.drop('thread = ?', thread);
  }

  /** A record last read 90 days ago or more stops being owed to the people who have not seen it, then goes with the rest that are past `olderThan`. */
  purge(olderThan: number): number {
    const capped = this.db.prepare('SELECT thread, admin_key, started_at FROM chat_admin_reads WHERE last_seen_at < ? ORDER BY thread, started_at, admin_key').all(this.now() - OWED_CAP_MS) as unknown as DbOwed[];
    for (const r of capped) this.db.prepare('DELETE FROM chat_admin_owed WHERE thread = ? AND admin_key = ? AND started_at = ?').run(r.thread, r.admin_key, r.started_at);
    return this.drop('last_seen_at < ?', olderThan);
  }
}

/** This server's scope, minted on first use and kept in `settings`. */
function scopeOf(db: DatabaseSync): () => string {
  let known: string | null = null;
  return () => {
    if (known) return known;
    const read = (): string | undefined => (db.prepare('SELECT value FROM settings WHERE key = ?').get(CHAT_SCOPE_KEY) as { value: string } | undefined)?.value;
    let v = read();
    if (!v) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(CHAT_SCOPE_KEY, newServerScope());
      v = read() as string;
    }
    known = v;
    return v;
  };
}

/**
 * The Chat stores over the connection, each call one step under its lock. The synchronous classes are kept whole, so a read of a page and the
 * write of a post cannot be split by another task, in or out of a transaction.
 */
export function chatStoreOver(db: DatabaseSync, lock: AsyncLock, opts: ChatStoreOptions): ChatStoreApi {
  const scope = scopeOf(db);
  const group = new Channel(db, 'group_messages', opts.now, scope);
  const pub = new Channel(db, 'public_messages', opts.now, scope);
  const channels = new PublicChannels(db);
  const state = new ReadState(db, opts.now);
  const reads = new AdminReads(db, opts.now);
  const step = <T>(fn: () => T): Promise<T> => lock.run(fn);
  const readState: ChatReadStateApi = {
    get: (person, thread) => step(() => state.get(person, thread)),
    list: (person) => step(() => state.list(person)),
    bumpMany: (thread, bumps) => step(() => state.bumpMany(thread, bumps)),
    markRead: (person, thread, upTo) => step(() => state.markRead(person, thread, upTo)),
    forget: (thread) => step(() => state.forget(thread)),
    threads: (prefix) => step(() => state.threads(prefix)),
  };
  const adminReads: ChatAdminReadsApi = {
    touch: (thread, admin, adminId, gapMs, people) => step(() => reads.touch(thread, admin, adminId, gapMs, people)),
    mark: (thread, admin, adminId, kind, people) => step(() => reads.mark(thread, admin, adminId, kind, people)),
    list: (thread) => step(() => reads.list(thread)),
    live: (threads, since) => step(() => reads.live(threads, since)),
    recent: (since) => step(() => reads.recent(since)),
    threads: (prefix) => step(() => reads.threads(prefix)),
    unseenFor: (person) => step(() => reads.unseenFor(person)),
    seen: (thread, person) => step(() => reads.seen(thread, person)),
    forget: (thread) => step(() => reads.forget(thread)),
    purge: (olderThan) => step(() => reads.purge(olderThan)),
  };
  const groupApi: ChannelStoreApi<[GroupScope]> = {
    post: (s, input) => step(() => group.post(s, input)),
    page: (s, o) => step(() => group.page(s, o)),
    setMention: (s, id, index, patch) => step(() => group.setMention(s, id, index, patch)),
    getMessage: (s, id) => step(() => group.getMessage(s, id)),
    editMessage: (s, id, x) => step(() => group.editMessage(s, id, x)),
    deleteMessage: (s, id, x) => step(() => group.deleteMessage(s, id, x)),
    heldMentions: (s, filter) => step(() => group.heldMentions(s, filter)),
    clear: (s) => step(() => group.clear(s)),
    count: (s) => step(() => group.count(s)),
    purge: (olderThan) => step(() => group.purge(olderThan)),
  };
  const inChannel = (c: string): { channel: string } => ({ channel: channelKey(c) });
  const publicApi: PublicStoreApi = {
    post: (c, input) => step(() => pub.post(inChannel(c), input)),
    page: (c, o) => step(() => pub.page(inChannel(c), o)),
    setMention: (c, id, index, patch) => step(() => pub.setMention(inChannel(c), id, index, patch)),
    getMessage: (c, id) => step(() => pub.getMessage(inChannel(c), id)),
    editMessage: (c, id, x) => step(() => pub.editMessage(inChannel(c), id, x)),
    deleteMessage: (c, id, x) => step(() => pub.deleteMessage(inChannel(c), id, x)),
    heldMentions: (c, filter) => step(() => pub.heldMentions(inChannel(c), filter)),
    heldMentionsAcross: (filter) => step(() => pub.heldMentions(null, filter)),
    clear: (c) => step(() => pub.clear(inChannel(c))),
    count: (c) => step(() => pub.count(inChannel(c))),
    purge: (olderThan) => step(() => pub.purge(olderThan)),
    counts: () => step(() => pub.counts()),
    mentionsAcross: (filter) => step(() => pub.mentionsAcross(filter)),
  };
  const channelsApi: PublicChannelsApi = {
    create: (input, at) => step(() => channels.create(input, at)),
    list: () => step(() => channels.list()),
    get: (name) => step(() => channels.get(name)),
    updateDescription: (name, description, at) => step(() => channels.updateDescription(name, description, at)),
    remove: (name) => step(() => channels.remove(name)),
    count: () => step(() => channels.count()),
  };
  const get = (key: string): string | undefined => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  const settings = chatSettingsOver({
    get: (key) => step(() => get(key)),
    set: (key, value) => step(() => void db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)),
    del: (key) => step(() => void db.prepare('DELETE FROM settings WHERE key = ?').run(key)),
    prefixed: (prefix) => step(() => db.prepare("SELECT key, value FROM settings WHERE substr(key, 1, ?) = ? ORDER BY key").all(prefix.length, prefix) as unknown as { key: string; value: string }[]),
  });
  return { serverScope: () => step(scope), group: groupApi, public: publicApi, channels: channelsApi, conversations: conversationsOver(db, lock, scope), readState, adminReads, settings };
}
