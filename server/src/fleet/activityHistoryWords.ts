// The plain words the Admin log uses for the Activity history (#432): one wording for the choice, the purge and the delete.
// Counts and sizes only, never the text of an entry.
import type { ActivityHistorySettings } from './activityHistoryTypes.js';

/** A count with its digits grouped: 72,000. */
export const groupedCount = (n: number): string => n.toLocaleString('en-US');

/** `1 entry`, `72,000 entries`; `1 session`, `20 sessions`. */
export const countWords = (n: number, one: string, many: string): string => `${groupedCount(n)} ${n === 1 ? one : many}`;

/** The choice in words: `purge after 1 hour`, `purge after 2 hours`, `purge when the session ends`, and so on. */
export function policyWords(s: ActivityHistorySettings): string {
  const unit = s.n === 1 ? s.unit.replace(/s$/, '') : s.unit;
  return { default: 'not kept (the default)', after: `purge after ${s.n} ${unit}`, end: 'purge when the session ends', all: 'keep everything, no automatic purge' }[s.policy];
}

/** The size cap in words: `no size cap`, `size cap 5 GB`. */
export const capWords = (s: ActivityHistorySettings): string => (s.capGb === null ? 'no size cap' : `size cap ${s.capGb} GB`);
