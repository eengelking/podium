// Types for errors.mjs, so TypeScript can import it. (NodeNext looks for `errors.d.mts` beside `errors.mjs`.)
export const DAY_MS: number;
/** After a renewal fails for a reason that may pass, wait this long before asking again. */
export const RENEW_RETRY_MS: number;
/** A short name for what went wrong upstream, for the `X-Podium-Helper-Error` header. */
export function classifyError(err: unknown): string;
/** How long to wait after a 429, from its Retry-After header in seconds: never less than `usual`, never more than a day. */
export function retryDelayMs(header: unknown, usual?: number): number;
