import type { DatabaseSync } from 'node:sqlite';
import { ActivityHistory } from './activityHistory.js';
import { SessionRecordings } from './recordings.js';
import type { ActivityHistoryApi, ActivityStorage, ActivityStoreOptions, SessionRecordingsApi } from '../types.js';
import { AsyncLock } from '../lock.js';
import type { RecordingTrail } from '../rows.js';

/**
 * The activity file (#432, #353) on its own connection and its own lock. The Activity history and the recordings are kept whole
 * as the synchronous classes they were. A call that was one synchronous turn is one step under the lock, so a consent check and
 * the write it allows, a stop and a late entry, or a delete's last settle and a new entry cannot be split by another task. A
 * chunked removal is not held under the lock for its whole run: each chunk is a step of its own, with a turn for the event loop
 * between, so a capture or a read goes in between chunks exactly where it did before. Nothing here waits on the main database
 * while it holds the lock: what the server must read from there is read first and passed in.
 */
export class ActivityConnection {
  readonly lock = new AsyncLock();
  private readonly services: { history: ActivityHistory; recordings: SessionRecordings }[] = [];

  constructor(readonly db: DatabaseSync) {}

  /** Builds the two services over the connection. */
  build(opts: ActivityStoreOptions): ActivityStorage {
    const { lock } = this;
    // What a recording did on its own is told to the routes after the step that caused it, outside the lock: the routes' reply
    // goes to the Admin log, which must not run in a task that holds this file.
    const pending: RecordingTrail[] = [];
    let trail: ((t: RecordingTrail) => void) | null = null;
    const flush = () => {
      for (const t of pending.splice(0)) {
        try {
          trail?.(t);
        } catch {
          // the Admin log is best effort here: a failing write must not undo a stop
        }
      }
    };
    const step = async <T>(fn: () => T): Promise<T> => {
      try {
        return await lock.run(fn);
      } finally {
        flush();
      }
    };

    const { agentsOf, ...historyOpts } = opts.history;
    const h = new ActivityHistory(this.db, { ...historyOpts, step });
    const { loopsOf, ...recOpts } = opts.recordings;
    const r = new SessionRecordings(this.db, {
      ...recOpts,
      // Always passed to `view` and `loopInfo` below, read from the fleet store before the step.
      loopsOf: () => [],
      exclusive: (fn) => h.runExclusive(fn),
      compact: () => h.compactNow(),
      step,
    });
    r.trail = (t) => void pending.push(t);
    this.services.push({ history: h, recordings: r });

    const history: ActivityHistoryApi = {
      current: () => h.current(),
      enabled: () => h.enabled(),
      get lastPurge() {
        return h.lastPurge;
      },
      get busy() {
        return h.busy;
      },
      forgetSession: (sessionId) => h.forgetSession(sessionId),
      loopsToWatch: async (sessionId) => h.loopsToWatch(sessionId, await agentsOf(sessionId)),
      ingest: (report, skewMs, meta) => step(() => h.ingest(report, skewMs, meta)),
      addPodium: (sessionId, loop, ref, e, meta) => step(() => h.addPodium(sessionId, loop, ref, e, meta)),
      updatePodium: (sessionId, ref, note) => step(() => h.updatePodium(sessionId, ref, note)),
      removePodium: (sessionId, ref) => step(() => h.removePodium(sessionId, ref)),
      page: (sessionId, loop, before, limit) => step(() => h.page(sessionId, loop, before, limit)),
      note: (sessionId, loop) => step(() => h.note(sessionId, loop)),
      totals: () => step(() => h.totals()),
      // The chunked ones take the lock one step at a time inside the class.
      list: (filter, page, pageSize) => h.list(filter, page, pageSize),
      preview: (settings) => h.preview(settings),
      purge: (now) => h.purge(now),
      deleteBy: (body) => h.deleteBy(body),
      deleteSession: (sessionId) => h.deleteSession(sessionId),
      dropMissingSessions: (exists) => h.dropMissingSessions(exists),
      idle: () => h.idle(),
    };

    const recordings: SessionRecordingsApi = {
      get trail() {
        return trail;
      },
      set trail(f) {
        trail = f;
      },
      enabled: () => r.enabled(),
      noteOption: (sessionId, on) => r.noteOption(sessionId, on),
      optionOn: (sessionId) => r.optionOn(sessionId),
      forgetSession: (sessionId) => r.forgetSession(sessionId),
      forgetPodiumPrompt: (sessionId, ref) => r.forgetPodiumPrompt(sessionId, ref),
      has: (sessionId) => step(() => r.has(sessionId)),
      capturing: (sessionId) => step(() => r.capturing(sessionId)),
      acceptsUntil: (sessionId) => step(() => r.acceptsUntil(sessionId)),
      keptUntilOf: (sessionId) => step(() => r.keptUntilOf(sessionId)),
      grant: (sessionId) => step(() => r.grant(sessionId)),
      view: async (sessionId) => {
        const loops = await loopsOf(sessionId);
        return step(() => r.view(sessionId, loops));
      },
      loopInfo: async (sessionId) => {
        const loops = await loopsOf(sessionId);
        return step(() => r.loopInfo(sessionId, loops));
      },
      totalBytes: () => step(() => r.totalBytes()),
      totals: () => step(() => r.totals()),
      start: (sessionId, loops, by, meta) => step(() => r.start(sessionId, loops, by, meta)),
      choose: (sessionId, loops, by, meta, available) => step(() => r.choose(sessionId, loops, by, meta, available)),
      accept: (sessionId, batch, meta) => step(() => r.accept(sessionId, batch, meta)),
      stateFor: (sessionId) => step(() => r.stateFor(sessionId)),
      stop: (sessionId, by) => step(() => r.stop(sessionId, by)),
      stopAll: (by) => step(() => r.stopAll(by)),
      carryOver: (oldId, newId, meta) => step(() => r.carryOver(oldId, newId, meta)),
      ingest: (sessionId, batch, meta) => step(() => r.ingest(sessionId, batch, meta)),
      notePodiumPrompt: (sessionId, loop, e, ref) => step(() => r.notePodiumPrompt(sessionId, loop, e, ref)),
      page: (sessionId, before, limit, loop) => step(() => r.page(sessionId, before, limit, loop)),
      adminList: (o) => step(() => r.adminList(o)),
      listStored: (f, page, pageSize) => step(() => r.listStored(f, page, pageSize)),
      idsFor: (body) => step(() => r.idsFor(body)),
      removeMany: (ids) => r.removeMany(ids),
      removeFor: (body) => r.removeFor(body),
      removeSession: (sessionId) => r.removeSession(sessionId),
      dropMissingSessions: (exists) => r.dropMissingSessions(exists),
      purge: (now) => r.purge(now),
    };
    return { history, recordings };
  }

  /**
   * Stops what runs in chunks at its next chunk, waits for it and for every queued step, then closes the file. Nothing is left
   * half done: a removal that was running ends on a chunk boundary, and its settle (or the next purge) finishes the totals.
   */
  async close(): Promise<void> {
    for (const s of this.services) s.history.stop();
    await Promise.all(this.services.map((s) => s.history.idle().catch(() => undefined)));
    await this.lock.drain();
    this.db.close();
  }
}
