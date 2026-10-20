// Lifecycle timers (SPEC 7.5): the sweep every second, the KPI tick every 2 s, retention hourly.
// Each timer body is guarded so a failing sweep is logged and the next one still runs.
import type { ActivityHistory } from './activityHistory.js';
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

/** A size for the Admin log: 1.5 MB, 320 KB, 12 B. */
function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * One run of the Activity history's purge (#432). A run that removed something writes one Admin log row and one log line;
 * a run that removed nothing is silent.
 */
export function purgeActivityHistory(history: ActivityHistory, people: PeopleStore, logger: Logger, now: number): void {
  const r = history.purge(now);
  if (r.entries === 0) return;
  const policy = history.current().policy;
  people.log(ACTIVITY_LOG_KINDS.purged, `${r.entries} entries (${sizeText(r.bytes)}) removed under ${policy}`, 'sweeper', now);
  logger.info('activity.purged', `podium: activity history purge removed ${r.entries} entries`, { entries: r.entries, bytes: r.bytes, sessions: r.sessions, freed: r.freed, policy });
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
export function startSweeper(fleet: Fleet, intervals: SweeperIntervals = DEFAULT_INTERVALS, log: Logger | ((line: string) => void) = createLogger(), onRetention?: () => void, onActivityPurge?: () => void): () => void {
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
  const activityPurge = guard('activity-purge', () => onActivityPurge?.());
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
