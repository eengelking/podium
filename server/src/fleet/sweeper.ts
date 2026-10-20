// Lifecycle timers (SPEC 7.5): the sweep every second, the KPI tick every 2 s, retention hourly.
// Each timer body is guarded so a failing sweep is logged and the next one still runs.
import type { ActivityHistory } from './activityHistory.js';
import { sizeText } from './sizeText.js';
import { capWords, countWords, policyWords } from './activityHistoryWords.js';
import { ACTIVITY_LOG_KINDS } from './activityHistoryTypes.js';
import type { Fleet } from './fleet.js';
import type { PeopleStore } from './people.js';
import type { ReporterStore } from './reporters.js';
import { createLogger, loggerFromLine, type Logger } from '../logging/logger.js';

export interface SweeperIntervals {
  sweepMs: number;
  tickMs: number;
  retentionMs: number;
  /** How often the Activity history's purge runs (#432); 5 minutes when absent. */
  activityPurgeMs?: number;
}

export const DEFAULT_INTERVALS: SweeperIntervals & { activityPurgeMs: number } = { sweepMs: 1000, tickMs: 2000, retentionMs: 3600_000, activityPurgeMs: 300_000 };

/** The stores whose purge is running now, so a tick that fires before it finishes skips instead of stacking. */
const purging = new WeakSet<ActivityHistory>();

/**
 * One run of the Activity history's purge (#432). A run that removed something writes one Admin log row and one log line;
 * a run that removed nothing is silent. The purge works in chunks, so this returns when it is done; a run that starts while
 * the last one is still going is skipped.
 */
export async function purgeActivityHistory(history: ActivityHistory, people: PeopleStore, logger: Logger, now: number): Promise<void> {
  if (purging.has(history)) return;
  purging.add(history);
  try {
    const r = await history.purge(now);
    if (r.entries === 0) return;
    const current = history.current();
    const policy = current.policy;
    const cap = current.capGb === null ? '' : `, ${capWords(current)}`;
    people.log(ACTIVITY_LOG_KINDS.purged, `${countWords(r.entries, 'entry', 'entries')} (${sizeText(r.bytes)}) removed under ${policyWords(current)}${cap}`, 'sweeper', now);
    logger.info('activity.purged', `podium: activity history purge removed ${r.entries} entries`, { entries: r.entries, bytes: r.bytes, sessions: r.sessions, freed: r.freed, policy });
  } finally {
    purging.delete(history);
  }
}

/**
 * Removes reporters not heard from for the Admin's number of days, when that setting is on (issue #167), and says so in the
 * log and the Admin log. Silent when nothing went.
 */
export function forgetReporters(reporters: ReporterStore, people: PeopleStore, logger: Logger, now: number): void {
  const removed = reporters.forgetStale(now);
  if (removed === 0) return;
  const { days } = reporters.forgetSetting();
  const detail = `Forgot ${removed} reporter${removed === 1 ? '' : 's'} not heard from for ${days} days`;
  people.log('reporters_forgotten', detail, 'sweeper', now);
  logger.info('reporters.forgotten', `podium: ${detail}`, { count: removed, days });
}

/** `log` is the server's logger, or a plain line sink as before the logger existed (#140). */
export function startSweeper(fleet: Fleet, intervals: SweeperIntervals = DEFAULT_INTERVALS, log: Logger | ((line: string) => void) = createLogger(), onRetention?: () => void, onActivityPurge?: () => void | Promise<void>): () => void {
  const logger = typeof log === 'function' ? loggerFromLine(log) : log;
  const guard = (name: string, fn: () => void) => () => {
    try {
      fn();
    } catch (err) {
      logger.error('sweeper.failed', `podium sweeper: ${name} failed: ${(err as Error).message}`, { timer: name, reason: (err as Error).message });
    }
  };
  // Each job is guarded on its own, so a failing one never stops the other.
  const retention = () => {
    guard('retention', () => void fleet.retain())();
    guard('forget-reporters', () => onRetention?.())();
  };
  // The purge is async: a failure after its first chunk arrives as a rejection, which is logged the same way.
  const activityPurge = guard('activity-purge', () => {
    void Promise.resolve(onActivityPurge?.()).catch((err: Error) => {
      logger.error('sweeper.failed', `podium sweeper: activity-purge failed: ${err.message}`, { timer: 'activity-purge', reason: err.message });
    });
  });
  const timers = [
    setInterval(guard('sweep', () => fleet.sweep()), intervals.sweepMs),
    setInterval(guard('tick', () => fleet.tick()), intervals.tickMs),
    setInterval(retention, intervals.retentionMs),
    setInterval(activityPurge, intervals.activityPurgeMs ?? DEFAULT_INTERVALS.activityPurgeMs),
  ];
  // Retention also runs once at start, so a server that restarts often still prunes.
  retention();
  activityPurge();
  for (const t of timers) t.unref?.();
  return () => {
    for (const t of timers) clearInterval(t);
  };
}
