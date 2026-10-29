// The shapes the Activity history shares between its store, its routes and the Admin pages (#432). Types and constants
// only: no behavior lives here, so the store, the routes and the frontend can be written against it side by side.
//
// Activity history is the agent Activity feed kept in the Activity store, apart from the main one, when the
// Admin chooses a keep policy. Under the default policy nothing here is used and the feed stays in memory (activity.ts).
import type { ActivityEntryView } from './activity.js';

export const ACTIVITY_HISTORY_POLICIES = ['default', 'after', 'end', 'all'] as const;
/**
 * `default`: not stored (today's behavior). `after`: purge entries older than n units. `end`: keep while the session runs,
 * remove when it ends. `all`: no automatic purge. A session's own retention (30 days) still removes its rows: the shorter wins.
 */
export type ActivityHistoryPolicy = (typeof ACTIVITY_HISTORY_POLICIES)[number];

export const ACTIVITY_HISTORY_UNITS = ['hours', 'days', 'weeks', 'months'] as const;
export type ActivityHistoryUnit = (typeof ACTIVITY_HISTORY_UNITS)[number];

/** Milliseconds per unit. A month is 30 days. */
export const ACTIVITY_UNIT_MS: Record<ActivityHistoryUnit, number> = {
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 7 * 86_400_000,
  months: 30 * 86_400_000,
};

/** The Admin's choice, stored as JSON in the `settings` row `activity_history`. `n` and `unit` matter only for `after`. */
export interface ActivityHistorySettings {
  policy: ActivityHistoryPolicy;
  n: number;
  unit: ActivityHistoryUnit;
  /** Optional total size in gigabytes; the oldest entries go first when it is passed. null is no cap. */
  capGb: number | null;
}

export const ACTIVITY_HISTORY_DEFAULTS: ActivityHistorySettings = { policy: 'default', n: 30, unit: 'days', capGb: null };

/** Accepted ranges, whole numbers. */
export const ACTIVITY_HISTORY_RANGES = { n: { min: 1, max: 3650 }, capGb: { min: 1, max: 1000 } } as const;

/** The Admin log kinds this feature writes. Each run of the purge that removes something writes one `activity_purged`. */
export const ACTIVITY_LOG_KINDS = {
  changed: 'activity_history_changed',
  deleted: 'activity_deleted',
  purged: 'activity_purged',
} as const;

/**
 * What is stored now, in total. `bytes` is the estimate of the entries' size (the same measure every preview, list row and
 * delete result uses, and the size cap counts); `fileBytes` is the activity file's pages in use, for "on disk".
 */
export interface StoredTotals {
  entries: number;
  bytes: number;
  sessions: number;
  fileBytes: number;
}

/** The last run of the purge that removed something, or null if none has since the server started. */
export interface LastPurge {
  at: number;
  entries: number;
  bytes: number;
}

/** Part of the reply to `GET /api/admin/settings` (`activityHistory`) and of the Data page. */
export interface ActivityHistoryState {
  settings: ActivityHistorySettings;
  totals: StoredTotals;
  lastPurge: LastPurge | null;
  /** False when the server runs without a token: a keep policy cannot be chosen then, since nobody could be allowed to read it. */
  authOn: boolean;
}

/** `POST /api/admin/activity-history/preview` request: what saving these settings would remove now. */
export interface ActivityHistoryPreviewBody {
  settings: ActivityHistorySettings;
}

/**
 * Its reply. For a keep policy: what saving would remove now, and `stopsCapturing` false. For `default` nothing is removed:
 * `entries`, `bytes` and `sessions` are what is stored now, and `stopsCapturing` is true when anything is stored.
 */
export interface ActivityHistoryPreview {
  entries: number;
  bytes: number;
  /** Sessions that would lose at least one entry (for `default`: sessions with anything stored). */
  sessions: number;
  stopsCapturing: boolean;
}

/** A filter for the stored sessions. Every field is optional; the fields combine with AND. Times are epoch milliseconds. */
export interface StoredFilter {
  /** Matches the session name or id, case-insensitively. */
  q?: string;
  loop?: 'all' | 'main' | 'agents';
  project?: string;
  owner?: string;
  /** Entries older than this many days. */
  olderThanDays?: number;
  /** Entries at or after `from` and before `to`. */
  from?: number;
  to?: number;
  /** Which store the rows come from: the Activity history (the default) or session recordings (#353). */
  source?: 'activity' | 'recordings';
}

/** One row of the Stored activity table: a session and what is stored for it (after the filter's entry window, if any). */
export interface StoredSessionRow {
  sessionId: string;
  name: string;
  project: string | null;
  owner: string | null;
  /** True while the session is running or waiting. */
  live: boolean;
  entries: number;
  bytes: number;
  /** Epoch ms of the oldest stored entry. */
  oldestAt: number;
}

/** `GET /api/admin/stored-activity?page=&pageSize=&q=&loop=&project=&owner=&olderThanDays=&from=&to=` */
export interface StoredActivityList {
  total: number;
  page: number;
  pageSize: number;
  rows: StoredSessionRow[];
  /** Everything stored, whatever the filter. */
  totals: StoredTotals;
  /** What the filter matches: sessions, entries and bytes, for "Delete all N that match". */
  match: Omit<StoredTotals, 'fileBytes'>;
  /** Distinct values for the filter's selects. */
  projects: string[];
  owners: string[];
}

/**
 * `POST /api/admin/stored-activity/delete`: by ticked sessions, by the filter, or everything. `source` says which store the ids,
 * or everything, belong to (the Activity history when absent); a filter carries its own `source`.
 */
export type StoredDeleteBody = { ids: string[]; source?: 'activity' | 'recordings' } | { match: StoredFilter } | { all: true; source?: 'activity' | 'recordings' };

export interface StoredDeleteResult {
  entries: number;
  /** Sessions that lost at least one entry. */
  sessions: number;
  /** Size of the entries removed. */
  bytes: number;
  /** Bytes the file gave back after compaction. */
  freed: number;
}

/**
 * Part of an `ActivityReply` (the live feed's reply): counts only, no entry text, so it needs no sign-in. Present only when a
 * keep policy is on and the loop has stored entries.
 */
export interface ActivityHistoryNote {
  policy: ActivityHistoryPolicy;
  /** Entries stored for this loop. */
  total: number;
  /** Epoch ms of the oldest stored entry of this loop. */
  since: number | null;
  /** When the newest stored entry will go under `after` (its time plus the period); null under `end` and `all`. */
  keptUntil: number | null;
  /** The signed-in viewer may read the entries (the session's owner or an Admin). The entries come from the history route. */
  canRead: boolean;
  /** The owner's name, for "Only Ed and the Admin can open it". */
  owner: string | null;
}

/** `GET /api/fleet/respond/sessions/:id/activity-history?loop=&before=&limit=`: signed-in owner or Admin only. */
export interface ActivityHistoryPage {
  /** Oldest first, like the live feed. */
  entries: ActivityEntryView[];
  /** Pass as `before` to get the next older page; null when there is no older entry. */
  olderBefore: number | null;
  total: number;
  since: number | null;
  keptUntil: number | null;
}

/** Page size the window asks for, and the most the route returns. */
export const ACTIVITY_HISTORY_PAGE = 20;
export const ACTIVITY_HISTORY_PAGE_MAX = 100;
