// The Chat page's stores on PostgreSQL (#1034): the SQLite store's logic over `PgDb`. The group channel (`group_messages`), General
// (`public_messages`) and each person's read state per thread (`chat_read_state`). Nothing here reads or writes a direct message (the
// conversation table): a channel's text and a conversation's text are in different tables, read by different methods, on purpose.
// Every call that reads then writes is one transaction, and the gate in `PgDb.tx` takes them one at a time, as the SQLite lock does.
import { nameKey } from '../rows.js';
import { decodeCursor, encodeCursor, pageSize } from '../peerText.js';
import {
  CHAT_SCOPE_KEY, channelOwner, checkAuthorKind, emptyReadState, mentionsOf, newChannelId, newServerScope, toChannelMessage, withMentionState, type DbChannelRow,
} from '../chatRows.js';
import type { ChannelMessage, ChannelPage, ChannelPostInput, ChannelStoreApi, ChatReadStateApi, ChatStoreApi, ChatStoreOptions, GroupScope, MentionState, ThreadReadState } from '../types.js';
import type { PgDb } from './conn.js';

const GROUP_COLS = 'id, owner, group_id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq';
const PUBLIC_COLS = 'id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq';

/** One channel table. The group table's every statement is scoped to an owner and a group. */
class PgChannel {
  constructor(
    private readonly db: PgDb,
    private readonly table: 'group_messages' | 'public_messages',
    private readonly now: () => number,
    private readonly scope: () => Promise<string>,
  ) {}

  private get grouped(): boolean {
    return this.table === 'group_messages';
  }

  private get cols(): string {
    return this.grouped ? GROUP_COLS : PUBLIC_COLS;
  }

  /** The `WHERE` for the channel and the values that fill it. */
  private where(scope: GroupScope | null): { sql: string; args: string[] } {
    return scope ? { sql: 'owner = ? AND group_id = ?', args: [channelOwner(scope.owner), scope.groupId] } : { sql: '1 = 1', args: [] };
  }

  private byId(id: string, scope: GroupScope | null): Promise<DbChannelRow | undefined> {
    const w = this.where(scope);
    return this.db.get<DbChannelRow>(`SELECT ${this.cols} FROM ${this.table} WHERE id = ? AND ${w.sql}`, [id, ...w.args]);
  }

  post(scope: GroupScope | null, input: ChannelPostInput): Promise<ChannelMessage> {
    return this.db.tx(async () => {
      const kind = checkAuthorKind(input.authorKind);
      const at = this.now();
      const mentions = mentionsOf(input, at);
      const id = newChannelId(this.grouped ? 'grp' : 'pub', await this.scope());
      const common = [id, kind, input.authorRef, input.authorName, input.text, at, at, input.issue ?? null, input.project ?? null, input.milestone ?? null, input.replyTo ?? null, JSON.stringify(mentions)] as const;
      // `seq` is the next number in the table: the gate in `PgDb.tx` lets one transaction at a time reach this insert.
      if (scope) {
        await this.db.run(
          `INSERT INTO group_messages (id, owner, group_id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM group_messages))`,
          [common[0], channelOwner(scope.owner), scope.groupId, ...common.slice(1)],
        );
      } else {
        await this.db.run(
          `INSERT INTO public_messages (id, author_kind, author_ref, author_name, text, created_at, updated_at, issue, project, milestone, reply_to, mentions_json, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM public_messages))`,
          [...common],
        );
      }
      return toChannelMessage((await this.byId(id, scope)) as DbChannelRow);
    });
  }

  async page(scope: GroupScope | null, opts: { before?: string | null; limit: number }): Promise<ChannelPage> {
    const before = opts.before === undefined || opts.before === null ? null : decodeCursor(opts.before);
    const limit = pageSize(opts.limit);
    const w = this.where(scope);
    const rows = before
      ? await this.db.all<DbChannelRow>(`SELECT ${this.cols} FROM ${this.table} WHERE ${w.sql} AND (created_at < ? OR (created_at = ? AND seq < ?)) ORDER BY created_at DESC, seq DESC LIMIT ?`, [...w.args, before.at, before.at, before.seq, limit + 1])
      : await this.db.all<DbChannelRow>(`SELECT ${this.cols} FROM ${this.table} WHERE ${w.sql} ORDER BY created_at DESC, seq DESC LIMIT ?`, [...w.args, limit + 1]);
    // The extra row only says there is an older page; the cursor names the oldest row kept.
    const kept = rows.slice(0, limit).reverse();
    const oldest = kept[0];
    return { messages: kept.map(toChannelMessage), older: rows.length > limit && oldest ? encodeCursor(oldest.created_at, oldest.seq) : null };
  }

  setMention(scope: GroupScope | null, id: string, index: number, patch: { state: MentionState; why?: string | null }): Promise<ChannelMessage | null> {
    return this.db.tx(async () => {
      const row = await this.byId(id, scope);
      if (!row) return null;
      const at = this.now();
      const next = withMentionState(toChannelMessage(row).mentions, index, patch, at);
      if (!next) return null;
      await this.db.run(`UPDATE ${this.table} SET mentions_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(next), at, id]);
      return toChannelMessage((await this.byId(id, scope)) as DbChannelRow);
    });
  }

  clear(scope: GroupScope | null): Promise<number> {
    const w = this.where(scope);
    return this.db.run(`DELETE FROM ${this.table} WHERE ${w.sql}`, w.args);
  }

  async count(scope: GroupScope | null): Promise<number> {
    const w = this.where(scope);
    return ((await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.table} WHERE ${w.sql}`, w.args)) as { n: number }).n;
  }

  purge(olderThan: number): Promise<number> {
    return this.db.run(`DELETE FROM ${this.table} WHERE created_at < ?`, [olderThan]);
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

class PgReadState {
  constructor(
    private readonly db: PgDb,
    private readonly now: () => number,
  ) {}

  async get(person: string, thread: string): Promise<ThreadReadState> {
    const r = await this.db.get<DbReadState>('SELECT person, thread, last_read, unread, mentions, updated_at FROM chat_read_state WHERE person = ? AND thread = ?', [nameKey(person), thread]);
    return r ? toState(r) : emptyReadState(person, thread);
  }

  async list(person: string): Promise<ThreadReadState[]> {
    return (await this.db.all<DbReadState>('SELECT person, thread, last_read, unread, mentions, updated_at FROM chat_read_state WHERE person = ? ORDER BY thread', [nameKey(person)])).map(toState);
  }

  async bump(person: string, thread: string, mention: boolean): Promise<ThreadReadState> {
    await this.db.run(
      `INSERT INTO chat_read_state (person, thread, last_read, unread, mentions, updated_at) VALUES (?, ?, NULL, 1, ?, ?)
       ON CONFLICT(person, thread) DO UPDATE SET unread = chat_read_state.unread + 1, mentions = chat_read_state.mentions + excluded.mentions, updated_at = excluded.updated_at`,
      [nameKey(person), thread, mention ? 1 : 0, this.now()],
    );
    return this.get(person, thread);
  }

  async markRead(person: string, thread: string, upTo: string | null): Promise<ThreadReadState> {
    await this.db.run(
      `INSERT INTO chat_read_state (person, thread, last_read, unread, mentions, updated_at) VALUES (?, ?, ?, 0, 0, ?)
       ON CONFLICT(person, thread) DO UPDATE SET last_read = excluded.last_read, unread = 0, mentions = 0, updated_at = excluded.updated_at`,
      [nameKey(person), thread, upTo, this.now()],
    );
    return this.get(person, thread);
  }

  forget(thread: string): Promise<number> {
    return this.db.run('DELETE FROM chat_read_state WHERE thread = ?', [thread]);
  }
}

/** This server's scope, minted on first use and kept in `settings`. */
function scopeOf(db: PgDb): () => Promise<string> {
  let known: string | null = null;
  return async () => {
    if (known) return known;
    const read = async (): Promise<string | undefined> => (await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [CHAT_SCOPE_KEY]))?.value;
    let v = await read();
    if (!v) {
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', [CHAT_SCOPE_KEY, newServerScope()]);
      v = (await read()) as string;
    }
    known = v;
    return v;
  };
}

/** The Chat stores over the pool. */
export function pgChat(db: PgDb, opts: ChatStoreOptions): ChatStoreApi {
  const scope = scopeOf(db);
  const group = new PgChannel(db, 'group_messages', opts.now, scope);
  const pub = new PgChannel(db, 'public_messages', opts.now, scope);
  const state = new PgReadState(db, opts.now);
  const readState: ChatReadStateApi = {
    get: (person, thread) => state.get(person, thread),
    list: (person) => state.list(person),
    bump: (person, thread, mention) => db.tx(() => state.bump(person, thread, mention)),
    markRead: (person, thread, upTo) => db.tx(() => state.markRead(person, thread, upTo)),
    forget: (thread) => state.forget(thread),
  };
  const groupApi: ChannelStoreApi<[GroupScope]> = {
    post: (s, input) => group.post(s, input),
    page: (s, o) => group.page(s, o),
    setMention: (s, id, index, patch) => group.setMention(s, id, index, patch),
    clear: (s) => group.clear(s),
    count: (s) => group.count(s),
    purge: (olderThan) => group.purge(olderThan),
  };
  const publicApi: ChannelStoreApi<[]> = {
    post: (input) => pub.post(null, input),
    page: (o) => pub.page(null, o),
    setMention: (id, index, patch) => pub.setMention(null, id, index, patch),
    clear: () => pub.clear(null),
    count: () => pub.count(null),
    purge: (olderThan) => pub.purge(olderThan),
  };
  return { serverScope: () => scope(), group: groupApi, public: publicApi, readState };
}
