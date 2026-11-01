// The Activity history on PostgreSQL (#822), in the `podium_activity` schema. The surface is `sqlite/activityHistory.ts`'s with the
// database work asynchronous. Not ported yet: every method that touches the database rejects until this file is filled in. What reads
// memory only (`enabled`, `current`, `lastPurge`, `busy`, `forgetSession`, `loopsToWatch`, `stop`, `idle`, `runExclusive`, `compactNow`)
// is final and keeps the SQLite shapes.
import type { ActivityEntryView } from '../../fleet/activity.js';
import type { ActivityHistoryNote, ActivityHistoryPreview, ActivityHistorySettings, LastPurge, StoredActivityList, StoredDeleteBody, StoredDeleteResult, StoredFilter, StoredTotals } from '../../fleet/activityHistoryTypes.js';
import { MAIN_LOOP, type Report } from '../../fleet/protocol.js';
import type { PurgeResult, SessionMeta } from '../rows.js';
import type { PgDb } from './conn.js';
import type { PgHistoryOptions } from './activityTypes.js';

const notYet = (name: string): Promise<never> => Promise.reject(new Error(`postgres adapter: activity history ${name} is not ported yet`));

export class PgActivityHistory {
  private last: LastPurge | null = null;
  private chain: Promise<void> = Promise.resolve();
  private running = 0;
  private closed = false;

  constructor(
    protected readonly db: PgDb,
    protected readonly opts: PgHistoryOptions,
  ) {}

  current(): ActivityHistorySettings {
    return this.opts.settings();
  }

  enabled(): boolean {
    return this.opts.authOn && this.opts.settings().policy !== 'default' && (this.opts.featureOn?.() ?? true);
  }

  /** The orchestrator (main loop) and every running agent, given by the caller because the agents come from the fleet store. */
  loopsToWatch(_sessionId: string, agents?: string[]): string[] {
    return [MAIN_LOOP, ...(agents ?? [])];
  }

  get lastPurge(): LastPurge | null {
    return this.last;
  }

  /** A purge or delete still running stops at its next chunk. */
  stop(): void {
    this.closed = true;
  }

  get stopped(): boolean {
    return this.closed;
  }

  /** Resolves when every heavy operation started so far has finished. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Whether a heavy operation (purge, delete, preview, retention) is running or waiting. */
  get busy(): boolean {
    return this.running > 0;
  }

  /** Runs `fn` as a heavy operation, one at a time with the purge and the deletes. The recordings share this turn-taking. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.running++;
    const run = this.chain.then(fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run.finally(() => {
      this.running--;
    });
  }

  /** Gives removed rows' space back. PostgreSQL has nothing to do here; resolves with 0 bytes freed. */
  compactNow(): Promise<number> {
    return Promise.resolve(0);
  }

  forgetSession(_sessionId: string): void {
    // Not ported yet: the per-loop tails the SQLite class keeps in memory are forgotten here.
  }

  ingest(_report: Report, _skewMs: number, _meta: SessionMeta): Promise<number> {
    return notYet('ingest');
  }

  addPodium(_sessionId: string, _loop: string, _ref: string, _e: { at: number; text: string; by: string; note: string | null }, _meta: SessionMeta): Promise<void> {
    return notYet('addPodium');
  }

  updatePodium(_sessionId: string, _ref: string, _note: string | null): Promise<void> {
    return notYet('updatePodium');
  }

  removePodium(_sessionId: string, _ref: string): Promise<void> {
    return notYet('removePodium');
  }

  page(_sessionId: string, _loop: string, _before: number | null, _limit?: number): Promise<{ entries: ActivityEntryView[]; olderBefore: number | null; total: number; since: number | null; keptUntil: number | null }> {
    return notYet('page');
  }

  note(_sessionId: string, _loop: string): Promise<Pick<ActivityHistoryNote, 'policy' | 'total' | 'since' | 'keptUntil'> | null> {
    return notYet('note');
  }

  totals(): Promise<StoredTotals> {
    return notYet('totals');
  }

  list(_filter: StoredFilter, _page?: number, _pageSize?: number): Promise<StoredActivityList> {
    return notYet('list');
  }

  preview(_settings: ActivityHistorySettings): Promise<ActivityHistoryPreview> {
    return notYet('preview');
  }

  purge(_now?: number): Promise<PurgeResult> {
    return notYet('purge');
  }

  deleteBy(_body: StoredDeleteBody, _stillWanted?: (sessionId: string) => Promise<boolean>): Promise<StoredDeleteResult> {
    return notYet('deleteBy');
  }

  deleteSession(_sessionId: string): Promise<StoredDeleteResult> {
    return notYet('deleteSession');
  }

  dropMissingSessions(_exists: (sessionId: string) => boolean | Promise<boolean>): Promise<number> {
    return notYet('dropMissingSessions');
  }
}
