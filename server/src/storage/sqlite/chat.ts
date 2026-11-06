// The Chat page's stores on SQLite (#1034): the group channel (`group_messages`), General (`public_messages`) and each person's read state per
// thread (`chat_read_state`). Nothing here reads or writes a direct message (the conversation table): a channel's text and a conversation's text are in
// different tables, read by different methods, on purpose (the maintainer's hard rule; `separation.test.ts` holds the code to it).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { AsyncLock } from '../lock.js';
import { nameKey } from '../rows.js';
import { decodeCursor, encodeCursor, pageSize } from '../peerText.js';
import {
  CHAT_SCOPE_KEY, channelOwner, chatSettingsOver, checkAuthorKind, emptyReadState, mentionsOf, newChannelId, newServerScope, toChannelMessage, withMentionState, type DbChannelRow,
} from '../chatRows.js';
import type { AdminReadRow, ChannelMessage, ChannelPage, ChannelPostInput, ChannelStoreApi, ChatAdminReadsApi, ChatReadStateApi, ChatStoreApi, ChatStoreOptions, GroupScope, MentionState, ThreadReadState } from '../types.js';

const GROUP_COLS = 'id, owner, group_id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq';
const PUBLIC_COLS = 'id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq';

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
  private where(scope: GroupScope | null): { sql: string; args: string[] } {
    return scope ? { sql: 'owner = ? AND group_id = ?', args: [channelOwner(scope.owner), scope.groupId] } : { sql: '1 = 1', args: [] };
  }

  private byId(id: string, scope: GroupScope | null): DbChannelRow | undefined {
    const w = this.where(scope);
    return this.stmt(`SELECT ${this.cols} FROM ${this.table} WHERE id = ? AND ${w.sql}`).get(id, ...w.args) as unknown as DbChannelRow | undefined;
  }

  post(scope: GroupScope | null, input: ChannelPostInput): ChannelMessage {
    const kind = checkAuthorKind(input.authorKind);
    const at = this.now();
    const mentions = mentionsOf(input, at);
    const id = newChannelId(this.grouped ? 'grp' : 'pub', this.scope());
    const common = [id, kind, input.authorRef, input.authorName, input.text, at, at, input.issue ?? null, input.project ?? null, input.milestone ?? null, input.replyTo ?? null, JSON.stringify(mentions)] as const;
    if (scope) {
      this.stmt(
        `INSERT INTO group_messages (id, owner, group_id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM group_messages))`,
      ).run(common[0], channelOwner(scope.owner), scope.groupId, ...common.slice(1));
    } else {
      this.stmt(
        `INSERT INTO public_messages (id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM public_messages))`,
      ).run(...common);
    }
    return toChannelMessage(this.byId(id, scope) as DbChannelRow);
  }

  page(scope: GroupScope | null, opts: { before?: string | null; limit: number }): ChannelPage {
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

  setMention(scope: GroupScope | null, id: string, index: number, patch: { state: MentionState; why?: string | null }): ChannelMessage | null {
    const row = this.byId(id, scope);
    if (!row) return null;
    const at = this.now();
    const next = withMentionState(toChannelMessage(row).mentions, index, patch, at);
    if (!next) return null;
    this.stmt(`UPDATE ${this.table} SET mentions_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(next), at, id);
    return toChannelMessage(this.byId(id, scope) as DbChannelRow);
  }

  clear(scope: GroupScope | null): number {
    const w = this.where(scope);
    return Number(this.stmt(`DELETE FROM ${this.table} WHERE ${w.sql}`).run(...w.args).changes);
  }

  count(scope: GroupScope | null): number {
    const w = this.where(scope);
    return (this.stmt(`SELECT COUNT(*) AS n FROM ${this.table} WHERE ${w.sql}`).get(...w.args) as { n: number }).n;
  }

  purge(olderThan: number): number {
    return Number(this.stmt(`DELETE FROM ${this.table} WHERE created_at < ?`).run(olderThan).changes);
  }
}

interface DbReadState {
  person: string;
  thread: string;
  last_read: string | null;
  unread: number;
  mentions: number;
  updated_at: number;
}

const toState = (r: DbReadState): ThreadReadState => ({ person: r.person, thread: r.thread, lastRead: r.last_read, unread: r.unread, mentions: r.mentions, updatedAt: r.updated_at });

class ReadState {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  get(person: string, thread: string): ThreadReadState {
    const r = this.db.prepare('SELECT person, thread, last_read, unread, mentions, updated_at FROM chat_read_state WHERE person = ? AND thread = ?').get(nameKey(person), thread) as unknown as DbReadState | undefined;
    return r ? toState(r) : emptyReadState(person, thread);
  }

  list(person: string): ThreadReadState[] {
    return (this.db.prepare('SELECT person, thread, last_read, unread, mentions, updated_at FROM chat_read_state WHERE person = ? ORDER BY thread').all(nameKey(person)) as unknown as DbReadState[]).map(toState);
  }

  bump(person: string, thread: string, mention: boolean): ThreadReadState {
    this.db
      .prepare(
        `INSERT INTO chat_read_state (person, thread, last_read, unread, mentions, updated_at) VALUES (?, ?, NULL, 1, ?, ?)
         ON CONFLICT(person, thread) DO UPDATE SET unread = unread + 1, mentions = mentions + excluded.mentions, updated_at = excluded.updated_at`,
      )
      .run(nameKey(person), thread, mention ? 1 : 0, this.now());
    return this.get(person, thread);
  }

  markRead(person: string, thread: string, upTo: string | null): ThreadReadState {
    this.db
      .prepare(
        `INSERT INTO chat_read_state (person, thread, last_read, unread, mentions, updated_at) VALUES (?, ?, ?, 0, 0, ?)
         ON CONFLICT(person, thread) DO UPDATE SET last_read = excluded.last_read, unread = 0, mentions = 0, updated_at = excluded.updated_at`,
      )
      .run(nameKey(person), thread, upTo, this.now());
    return this.get(person, thread);
  }

  forget(thread: string): number {
    return Number(this.db.prepare('DELETE FROM chat_read_state WHERE thread = ?').run(thread).changes);
  }
}

interface DbAdminRead {
  thread: string;
  admin: string;
  started_at: number;
  last_seen_at: number;
}

const toRead = (r: DbAdminRead): AdminReadRow => ({ admin: r.admin, startedAt: r.started_at, lastSeenAt: r.last_seen_at });

/** The records of an Admin reading a thread that is not theirs (`chat_admin_reads`): who, which thread and when. Never any text. */
class AdminReads {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  touch(thread: string, admin: string, gapMs: number): { record: AdminReadRow; started: boolean; previousSeenAt: number | null } {
    const now = this.now();
    const key = nameKey(admin);
    const last = this.db.prepare('SELECT thread, admin, started_at, last_seen_at FROM chat_admin_reads WHERE thread = ? AND admin_key = ? ORDER BY last_seen_at DESC, started_at DESC LIMIT 1').get(thread, key) as unknown as DbAdminRead | undefined;
    if (last && now - last.last_seen_at <= gapMs) {
      const seen = Math.max(now, last.last_seen_at);
      this.db.prepare('UPDATE chat_admin_reads SET last_seen_at = ? WHERE thread = ? AND admin_key = ? AND started_at = ?').run(seen, thread, key, last.started_at);
      return { record: { admin: last.admin, startedAt: last.started_at, lastSeenAt: seen }, started: false, previousSeenAt: last.last_seen_at };
    }
    this.db
      .prepare('INSERT INTO chat_admin_reads (thread, admin_key, admin, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread, admin_key, started_at) DO UPDATE SET last_seen_at = excluded.last_seen_at')
      .run(thread, key, admin, now, now);
    return { record: { admin, startedAt: now, lastSeenAt: now }, started: true, previousSeenAt: null };
  }

  list(thread: string): AdminReadRow[] {
    return (this.db.prepare('SELECT thread, admin, started_at, last_seen_at FROM chat_admin_reads WHERE thread = ? ORDER BY started_at, admin_key').all(thread) as unknown as DbAdminRead[]).map(toRead);
  }

  live(threads: string[], since: number): (AdminReadRow & { thread: string })[] {
    if (!threads.length) return [];
    const marks = threads.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT thread, admin, started_at, last_seen_at FROM chat_admin_reads WHERE thread IN (${marks}) AND last_seen_at > ? ORDER BY thread, started_at, admin_key`)
      .all(...threads, since) as unknown as DbAdminRead[];
    return rows.map((r) => ({ thread: r.thread, ...toRead(r) }));
  }

  threads(prefix: string): string[] {
    return (this.db.prepare('SELECT DISTINCT thread FROM chat_admin_reads WHERE substr(thread, 1, ?) = ? ORDER BY thread').all(prefix.length, prefix) as unknown as { thread: string }[]).map((r) => r.thread);
  }

  forget(thread: string): number {
    return Number(this.db.prepare('DELETE FROM chat_admin_reads WHERE thread = ?').run(thread).changes);
  }

  purge(olderThan: number): number {
    return Number(this.db.prepare('DELETE FROM chat_admin_reads WHERE last_seen_at < ?').run(olderThan).changes);
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
  const state = new ReadState(db, opts.now);
  const reads = new AdminReads(db, opts.now);
  const step = <T>(fn: () => T): Promise<T> => lock.run(fn);
  const readState: ChatReadStateApi = {
    get: (person, thread) => step(() => state.get(person, thread)),
    list: (person) => step(() => state.list(person)),
    bump: (person, thread, mention) => step(() => state.bump(person, thread, mention)),
    markRead: (person, thread, upTo) => step(() => state.markRead(person, thread, upTo)),
    forget: (thread) => step(() => state.forget(thread)),
  };
  const adminReads: ChatAdminReadsApi = {
    touch: (thread, admin, gapMs) => step(() => reads.touch(thread, admin, gapMs)),
    list: (thread) => step(() => reads.list(thread)),
    live: (threads, since) => step(() => reads.live(threads, since)),
    threads: (prefix) => step(() => reads.threads(prefix)),
    forget: (thread) => step(() => reads.forget(thread)),
    purge: (olderThan) => step(() => reads.purge(olderThan)),
  };
  const groupApi: ChannelStoreApi<[GroupScope]> = {
    post: (s, input) => step(() => group.post(s, input)),
    page: (s, o) => step(() => group.page(s, o)),
    setMention: (s, id, index, patch) => step(() => group.setMention(s, id, index, patch)),
    clear: (s) => step(() => group.clear(s)),
    count: (s) => step(() => group.count(s)),
    purge: (olderThan) => step(() => group.purge(olderThan)),
  };
  const publicApi: ChannelStoreApi<[]> = {
    post: (input) => step(() => pub.post(null, input)),
    page: (o) => step(() => pub.page(null, o)),
    setMention: (id, index, patch) => step(() => pub.setMention(null, id, index, patch)),
    clear: () => step(() => pub.clear(null)),
    count: () => step(() => pub.count(null)),
    purge: (olderThan) => step(() => pub.purge(olderThan)),
  };
  const get = (key: string): string | undefined => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  const settings = chatSettingsOver({
    get: (key) => step(() => get(key)),
    set: (key, value) => step(() => void db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)),
    del: (key) => step(() => void db.prepare('DELETE FROM settings WHERE key = ?').run(key)),
    prefixed: (prefix) => step(() => db.prepare("SELECT key, value FROM settings WHERE substr(key, 1, ?) = ? ORDER BY key").all(prefix.length, prefix) as unknown as { key: string; value: string }[]),
  });
  return { serverScope: () => step(scope), group: groupApi, public: publicApi, readState, adminReads, settings };
}
