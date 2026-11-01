// The session recordings on PostgreSQL (#822), in the `podium_activity` schema. The surface is `sqlite/recordings.ts`'s with the
// database work asynchronous. Not ported yet: every method that touches the database rejects until this file is filled in. What reads
// memory only (`enabled`, `noteOption`, `optionOn`, `forgetSession`, `forgetPodiumPrompt`) is final and keeps the SQLite shapes.
import type { StoredActivityList, StoredFilter } from '../../fleet/activityHistoryTypes.js';
import type { RecordingAdminRow, RecordingBatch, RecordingGrant, RecordingLoopInfo, RecordingRow, RecordingState, RecordingView } from '../../fleet/protocol.js';
import type { PurgeRecordingsResult, RecordingMeta, RecordingTotals, RecordingTrail, RemoveResult, StoredState } from '../rows.js';
import type { PgDb } from './conn.js';
import type { PgRecordingsOptions } from './activityTypes.js';

const notYet = (name: string): Promise<never> => Promise.reject(new Error(`postgres adapter: recordings ${name} is not ported yet`));

type Target = { ids: string[] } | { match: StoredFilter } | { all: true };

export class PgSessionRecordings {
  /** Set by the connection: where what a recording did on its own is told. */
  trail: ((t: RecordingTrail) => void) | null = null;
  private readonly options = new Map<string, boolean>();
  private readonly deliveries = new Map<string, { ref?: string }[]>();

  constructor(
    protected readonly db: PgDb,
    protected readonly opts: PgRecordingsOptions,
  ) {}

  enabled(): boolean {
    return this.opts.authOn && this.opts.flagOn();
  }

  /** Takes the reporter's `sessionRecording` option from a report. A reporter that does not send it is read as off. */
  noteOption(sessionId: string, on: boolean | undefined): void {
    this.options.set(sessionId, on === true);
  }

  optionOn(sessionId: string): boolean {
    return this.options.get(sessionId) === true;
  }

  forgetSession(sessionId: string): void {
    this.options.delete(sessionId);
    this.deliveries.delete(sessionId);
  }

  forgetPodiumPrompt(sessionId: string, ref: string): void {
    const list = this.deliveries.get(sessionId);
    if (list) this.deliveries.set(sessionId, list.filter((d) => d.ref !== ref));
  }

  has(_sessionId: string): Promise<boolean> {
    return notYet('has');
  }

  capturing(_sessionId: string): Promise<boolean> {
    return notYet('capturing');
  }

  acceptsUntil(_sessionId: string): Promise<number | null> {
    return notYet('acceptsUntil');
  }

  keptUntilOf(_sessionId: string): Promise<number | null> {
    return notYet('keptUntilOf');
  }

  grant(_sessionId: string): Promise<RecordingGrant> {
    return notYet('grant');
  }

  view(_sessionId: string, _loops?: { loop: string; name: string }[]): Promise<RecordingView | null> {
    return notYet('view');
  }

  loopInfo(_sessionId: string, _loops?: { loop: string; name: string }[]): Promise<RecordingLoopInfo[]> {
    return notYet('loopInfo');
  }

  totalBytes(): Promise<number> {
    return notYet('totalBytes');
  }

  totals(): Promise<RecordingTotals> {
    return notYet('totals');
  }

  start(_sessionId: string, _loops: string[], _by: string, _meta: RecordingMeta): Promise<'ok' | 'limit' | 'budget' | 'busy'> {
    return notYet('start');
  }

  choose(_sessionId: string, _loops: string[], _by: string, _meta: RecordingMeta, _available: string[]): Promise<'ended' | 'unknown-loop' | 'ok' | 'limit' | 'budget' | 'busy'> {
    return notYet('choose');
  }

  accept(_sessionId: string, _batch: RecordingBatch, _meta: RecordingMeta): Promise<
    { kind: 'ended'; held: boolean } | { kind: 'off' } | { kind: 'stored'; stored: number; before: RecordingState; recording: RecordingGrant }
  > {
    return notYet('accept');
  }

  stateFor(_sessionId: string): Promise<StoredState | undefined> {
    return notYet('stateFor');
  }

  stop(_sessionId: string, _by: string): Promise<{ grant: RecordingGrant; changed: boolean } | null> {
    return notYet('stop');
  }

  stopAll(_by: string): Promise<string[]> {
    return notYet('stopAll');
  }

  carryOver(_oldId: string, _newId: string, _meta: RecordingMeta): Promise<boolean> {
    return notYet('carryOver');
  }

  ingest(_sessionId: string, _batch: RecordingBatch, _meta?: RecordingMeta): Promise<number> {
    return notYet('ingest');
  }

  notePodiumPrompt(_sessionId: string, _loop: string, _e: { at: number; text: string; by: string }, _ref?: string): Promise<void> {
    return notYet('notePodiumPrompt');
  }

  page(_sessionId: string, _before: number | null, _limit: number, _loop: string | null): Promise<{ entries: RecordingRow[]; olderBefore: number | null; total: number }> {
    return notYet('page');
  }

  adminList(_opts: { page: number; pageSize: number; state?: StoredState; q?: string }): Promise<{ total: number; page: number; pageSize: number; rows: RecordingAdminRow[]; totals: RecordingTotals }> {
    return notYet('adminList');
  }

  listStored(_f: StoredFilter, _page: number, _pageSize: number): Promise<StoredActivityList> {
    return notYet('listStored');
  }

  idsFor(_body: Target): Promise<string[]> {
    return notYet('idsFor');
  }

  removeMany(_ids: string[]): Promise<RemoveResult> {
    return notYet('removeMany');
  }

  removeFor(_body: Target): Promise<RemoveResult> {
    return notYet('removeFor');
  }

  removeSession(_sessionId: string): Promise<RemoveResult> {
    return notYet('removeSession');
  }

  dropMissingSessions(_exists: (sessionId: string) => boolean | Promise<boolean>): Promise<number> {
    return notYet('dropMissingSessions');
  }

  purge(_now?: number): Promise<PurgeRecordingsResult> {
    return notYet('purge');
  }
}
