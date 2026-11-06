// An Admin reading a person's group or a Direct Message is recorded and the people in it are told (#1034). One record per Admin per reading session:
// reads of one thread by one Admin less than 30 minutes apart are one session. A reading is live while the Admin read it in the last 30 seconds.
// A record holds who, which thread and when, never any text. General is public and is never recorded.
import type { ChatAdminReadsApi } from '../storage/types.js';
import type { ChatCore } from './chatCore.js';
import type { AdminReading, ChatViewer } from './chatTypes.js';

/** Reads of one thread by one Admin this close together are one reading session. */
export const SESSION_GAP_MS = 30 * 60_000;
/** A reading is live this long after the Admin's last read. The Admin's open thread pings every 15 seconds to keep it so. */
export const LIVE_MS = 30_000;

export interface AdminReadRecord {
  admin: string;
  startedAt: number;
  lastSeenAt: number;
}

/** Whose thread an Admin is reading: the people who are told, and what the Admin log says it was. */
export interface ReadSubject {
  scope: 'group' | 'dm';
  thread: string;
  /** The people in the thread, folded: the group's person, or the owner and the person of a conversation. */
  owners: string[];
}

export class AdminReads {
  constructor(private readonly core: ChatCore) {}

  private get store(): ChatAdminReadsApi {
    return this.core.store.adminReads;
  }

  /**
   * `viewer`, an Admin, read (or pinged) a thread that is not theirs. Records it, tells the people in it when a reading starts or comes back after it went
   * stale, and writes `chat_admin_read` to the Admin log once per session. A failure stops the read, so no thread is read without a record.
   */
  async note(viewer: ChatViewer, s: ReadSubject): Promise<void> {
    const got = await this.store.touch(s.thread, viewer.actor, SESSION_GAP_MS);
    const now = this.core.host.now();
    const wasLive = got.previousSeenAt !== null && now - got.previousSeenAt < LIVE_MS;
    if (got.started) this.core.onEvent({ kind: 'admin_read', by: viewer.actor, scope: s.scope, thread: s.thread, owners: s.owners });
    if (got.started || !wasLive) for (const owner of new Set(s.owners)) this.core.signal({ scope: s.scope, owner });
  }

  /** The thread's records, oldest first. */
  list(thread: string): Promise<AdminReadRecord[]> {
    return this.store.list(thread);
  }

  /** The Admins reading each of these threads now, by thread. Never one whose time has passed. */
  async liveFor(threads: string[]): Promise<Map<string, AdminReading[]>> {
    const now = this.core.host.now();
    const out = new Map<string, AdminReading[]>();
    for (const r of await this.store.live(threads, now - LIVE_MS)) {
      const list = out.get(r.thread) ?? [];
      list.push({ admin: r.admin, since: r.startedAt, until: r.lastSeenAt + LIVE_MS });
      out.set(r.thread, list);
    }
    return out;
  }

  forget(thread: string): Promise<number> {
    return this.store.forget(thread);
  }

  /** Retention: the records last read before `olderThan` go, and so do those of a conversation that no longer exists (`dmThreads` are the ones that do). */
  async maintain(olderThan: number, dmThreads: Set<string>): Promise<number> {
    let removed = await this.store.purge(olderThan);
    for (const t of await this.store.threads('dm:')) if (!dmThreads.has(t)) removed += await this.store.forget(t);
    return removed;
  }
}
