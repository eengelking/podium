// An Admin reading a person's group or a Direct Message is recorded and the people in it are told (#1034). One record per Admin per reading session:
// reads of one thread by one Admin less than 30 minutes apart are one session. A reading is live while the Admin read it in the last 30 seconds.
// A record holds who, which thread and when, never any text. General is public and is never recorded.
import type { AdminReadKind, AdminReadRow, ChatAdminReadsApi } from '../storage/types.js';
import { NOTICE_TTL_MS, type AdminNotice } from './chatAdminNotices.js';
import { nameKey } from '../storage/rows.js';
import type { ChatCore } from './chatCore.js';
import type { AdminReading, ChatViewer } from './chatTypes.js';

/** Reads of one thread by one Admin this close together are one reading session. */
export const SESSION_GAP_MS = 30 * 60_000;
/** A reading is live this long after the Admin's last read. The Admin's open thread pings every 15 seconds to keep it so. */
export const LIVE_MS = 30_000;

export type AdminReadRecord = AdminReadRow;

/** What the callout says of a look at a person's list of conversations. */
export const LIST_PHRASE = 'is looking at your Podium conversation list';


/** A reporter session of the person that is told, and what the Admin stopped, in the words after "the Admin": `removed all messages in your Podium group`. */
export interface Told {
  sessionId: string;
  about: string;
}

/**
 * Whose thread an Admin is reading: the people who are told, what the callout says, and what the Admin log says it was. `phrase` is what the Admin is doing,
 * to be read after the Admin's name: `is reading your Podium group`. It names the conversation, so a person with several open knows which.
 */
export interface ReadSubject {
  scope: 'group' | 'dm' | 'list';
  thread: string;
  /** The people in the thread, folded: the group's person, or the owner and the person of a conversation. Each is told, in every live reporter session. */
  owners: string[];
  phrase: string;
  /** For a look at a person's list: the person's name as typed, for the Admin log. */
  person?: string;
}

/** The thread an Admin's look at a person's list of conversations is recorded under. */
export const listThread = (owner: string): string => `list:${nameKey(owner)}`;

/** A short stable code for an id: the same record gives the same code on every report, so a reporter shows its callout once. */
function codeOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

export class AdminReads {
  /** What a thread's callout says, from the last time it was noted or looked up, so a report costs no scan of the conversations. */
  private readonly known = new Map<string, { subject: ReadSubject; at: number }>();
  /** Replaced by the Chat service: what a direct-message thread's callout says, from the conversation. Null when there is none. */
  resolve: (thread: string) => Promise<ReadSubject | null> = async () => null;

  constructor(private readonly core: ChatCore) {}

  private get store(): ChatAdminReadsApi {
    return this.core.store.adminReads;
  }

  /**
   * `viewer`, an Admin, read (or pinged) a thread that is not theirs. Records it first (a failure stops the read, so nothing is read without a record), writes
   * `chat_admin_read` to the Admin log once per session, and tells the people in it on the stream when a reading starts or comes back, and at every ping (`ping`),
   * so their console keeps the Admin on screen for as long as the Admin reads. A plain read after the start does not signal: the Admin's own console reads again
   * on a signal, so a signal on every read would make it read, and signal, without end (#1051). The record is owed to the people in the thread until they have
   * seen it. Their reporter sessions are told from the record whenever a session reports (`noticesFor`), not once here.
   */
  async note(viewer: ChatViewer, s: ReadSubject, ping = false): Promise<void> {
    const got = await this.store.touch(s.thread, viewer.actor, SESSION_GAP_MS, s.owners);
    this.known.set(s.thread, { subject: s, at: this.core.host.now() });
    if (got.started) {
      if (s.scope === 'list') this.core.onEvent({ kind: 'admin_browse', by: viewer.actor, person: s.person ?? s.owners[0] ?? '' });
      else this.core.onEvent({ kind: 'admin_read', by: viewer.actor, scope: s.scope, thread: s.thread, owners: s.owners });
    }
    if (got.started || ping) for (const owner of new Set(s.owners)) this.core.signal({ scope: s.scope === 'dm' ? 'dm' : 'group', owner });
  }

  /** A thread's subject, from memory or the conversation; null when it has none (the conversation is gone, or the thread is not one that is read-recorded). */
  private async subjectOf(thread: string): Promise<ReadSubject | null> {
    const now = this.core.host.now();
    const hit = this.known.get(thread);
    if (hit && now - hit.at < NOTICE_TTL_MS) return hit.subject;
    let subject: ReadSubject | null = null;
    if (thread.startsWith('group:')) subject = { scope: 'group', thread, owners: [thread.slice('group:'.length)], phrase: 'is reading your Podium group' };
    else if (thread.startsWith('list:')) subject = { scope: 'list', thread, owners: [thread.slice('list:'.length)], phrase: LIST_PHRASE };
    else if (thread.startsWith('dm:')) subject = await this.resolve(thread);
    if (subject) this.known.set(thread, { subject, at: now });
    else this.known.delete(thread);
    return subject;
  }

  /**
   * The callouts for a session's person from the readings now on record (#1051): every Admin who read a thread of that person in the last few minutes, whichever
   * session of the person asks and whenever it started. The id comes from the record, so a reporter shows each once however many reports carry it, and a
   * restart of the server loses none. The Admin's stops are held in `core.notices` and come after.
   */
  async noticesFor(sessionId: string): Promise<AdminNotice[]> {
    const live = this.core.host.peers.messages.live(sessionId);
    const held = this.core.notices.for(sessionId);
    if (!live) return held;
    const person = nameKey(live.owner);
    const out: AdminNotice[] = [];
    for (const r of await this.store.recent(this.core.host.now() - NOTICE_TTL_MS)) {
      const subject = await this.subjectOf(r.thread);
      if (!subject || !subject.owners.includes(person)) continue;
      out.push({ id: `rd-${r.startedAt.toString(36)}-${codeOf(`${r.thread}|${nameKey(r.admin)}`)}`, at: r.startedAt, text: `${this.whoIs(r.admin)} ${subject.phrase}.` });
    }
    return [...out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)), ...held];
  }

  /** How a callout names an Admin. */
  who(viewer: ChatViewer): string {
    return this.whoIs(viewer.actor);
  }

  whoIs(admin: string): string {
    return `${admin} (an Admin)`;
  }

  /** Shows a person's reporter session a callout, for the person only. Content-free. */
  tell(sessionId: string, text: string): void {
    this.core.notices.push(sessionId, text);
  }

  /**
   * An Admin paused, resumed or removed links of `owner`'s reporters (#1077): every live session of that person is told once, in the words after the Admin's
   * name (`paused all messaging links of your reporter box-a`). Content-free, and for the person only. A bulk stop is one call, so a person is not told per link.
   */
  toldLinkStop(admin: string, owner: string, what: string): number {
    const ids = this.sessionsOf(owner);
    for (const id of ids) this.tell(id, `${this.whoIs(admin)} ${what}.`);
    return ids.length;
  }

  /** The live reporter sessions of `owner` (folded), or of everyone when it is null. */
  sessionsOf(owner: string | null): string[] {
    const out: string[] = [];
    for (const id of this.core.host.liveIds()) {
      const o = this.core.host.peers.messages.live(id);
      if (o && (owner === null || nameKey(o.owner) === nameKey(owner))) out.push(id);
    }
    return out;
  }

  /**
   * An Admin is about to stop something of a person's: remove all of a thread's messages, or pause or resume it. Called before the stop is done, so a failure
   * to record it stops the stop and none goes unrecorded. It stays on the thread's record, owed to `people` until they have seen it, and their sessions are
   * told now.
   */
  async stopped(viewer: ChatViewer, thread: string, kind: Exclude<AdminReadKind, 'read'>, tells: Told[], people: string[]): Promise<void> {
    await this.store.mark(thread, viewer.actor, kind, people);
    const verb = kind === 'cleared' ? 'removed all messages in' : kind;
    for (const t of tells) this.tell(t.sessionId, `${this.who(viewer)} ${verb} ${t.about}.`);
  }

  /** The records `person` is owed and has not seen, of every thread, newest first. */
  unseenFor(person: string): Promise<(AdminReadRow & { thread: string })[]> {
    return this.store.unseenFor(person);
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

  /**
   * `person` has loaded the thread's records (their own thread, or their overview for a look at their list): what is owed to them there is seen. The
   * smallest meaning of "seen" that is true: Podium sent the record to that person's console. Records of a conversation they can no longer open are
   * never seen, so they stay.
   */
  seen(thread: string, person: string): Promise<number> {
    return this.store.seen(thread, person);
  }

  /**
   * The thread's conversation is deleted: the records nobody is still owed a look at go with it. One that a person has not seen stays, so a writer deleting a
   * conversation cannot erase what its owner was never shown (#1051). Remove all messages does not call this, because it must not erase the evidence.
   */
  forget(thread: string): Promise<number> {
    return this.store.forget(thread);
  }

  /**
   * Retention: the records last read before `olderThan` go, and so do those of a conversation that no longer exists (`dmThreads` are the ones that do), except
   * a record a person has not seen yet (#1051). The purge of a hidden conversation's messages never reaches the records.
   */
  async maintain(olderThan: number, dmThreads: Set<string>): Promise<number> {
    let removed = await this.store.purge(olderThan);
    for (const t of await this.store.threads('dm:')) if (!dmThreads.has(t)) removed += await this.store.forget(t);
    return removed;
  }
}
