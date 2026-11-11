// The options the MariaDB Activity history and session recordings take (#823). They are the SQLite ones from `rows.ts`, with the
// steps asynchronous: a step is a database round trip, so `step` runs a function that returns a promise.
import type { ActivityHistoryOpts, RecordingsOpts } from '../rows.js';

/** Runs one step of a chunked operation under the activity connection's lock, and tells the recordings' trail afterward. */
export type MariaStep = <T>(fn: () => Promise<T>) => Promise<T>;

export type MariaHistoryOptions = Omit<ActivityHistoryOpts, 'step'> & { step?: MariaStep };

export type MariaRecordingsOptions = Omit<RecordingsOpts, 'exclusive' | 'compact' | 'step'> & {
  /** Runs a heavy operation one at a time with the Activity history's own. */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Gives the removed rows' space back (a no-op the history decides on MariaDB). */
  compact?: () => Promise<void>;
  step?: MariaStep;
};
