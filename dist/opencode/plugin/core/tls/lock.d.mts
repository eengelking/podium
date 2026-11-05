// Types for lock.mjs, so TypeScript can import it. (NodeNext looks for `lock.d.mts` beside `lock.mjs`.)
export const LOCK_STALE_MS: number;
export const LOCK_WAIT_MS: number;
/** The lock scheme this helper speaks. */
export const LOCK_SCHEME: number;
/** True when `file` exists and was last written more than `ms` ago. */
export function olderThan(file: string, ms: number): boolean;
/** The generations of a lock, `<lock>.<n>`, lowest first. */
export function generations(lockFile: string): Array<{ gen: number; file: string }>;
/** Records the scheme in `<lock>.scheme`; throws (code LOCK_SCHEME) for a newer one. */
export function checkScheme(lockFile: string): void;
/** Runs `fn` under the lock; null when the lock could not be had in `waitMs`. */
export function withLock<T>(lockFile: string, fn: () => Promise<T> | T, waitMs?: number, staleMs?: number): Promise<{ value: T } | null>;
