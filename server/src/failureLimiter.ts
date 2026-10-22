// A brake on failed requests from one address, ahead of every /api route. Wrong secrets already have their own lockouts
// (lockout.ts); this limits the rest of what a client can do from one address by failing (a refused certificate, a bad request, a
// probe for a route), so that cannot be used to keep the server busy. Successful requests are never counted, so one busy reporter
// or an open console does not trip it. Past the limit, that address's valid requests are refused too until the window ends, so
// behind a proxy that is not named in PODIUM_TRUST_PROXY (every client then shares the proxy's address) the limit can be raised
// with PODIUM_FAILURE_LIMIT.
import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import type { Logger } from './logging/logger.js';

export interface FailureLimiterOptions {
  /** Failed requests one address may make in a window. */
  max?: number;
  windowMs?: number;
  logger?: Logger;
}

export const FAILURE_LIMIT = 300;
export const FAILURE_WINDOW_MS = 60_000;

/** Reads PODIUM_FAILURE_LIMIT: a whole number of at least 1, or the default when unset. Throws on anything else, so a typo stops the server at start. */
export function parseFailureLimit(raw: string | undefined): number {
  const value = (raw ?? '').trim();
  if (value === '') return FAILURE_LIMIT;
  if (!/^\d{1,9}$/.test(value) || Number(value) < 1) throw new Error(`PODIUM_FAILURE_LIMIT: "${value}" is not a whole number of at least 1`);
  return Number(value);
}

export function failureLimiter(o: FailureLimiterOptions = {}): RequestHandler {
  // The address and the end of the window it was last logged for, so a window logs its first refusal once and the log is not
  // what gets flooded. Entries for a window that has ended are dropped when the map grows.
  const logged = new Map<string, number>();
  return rateLimit({
    windowMs: o.windowMs ?? FAILURE_WINDOW_MS,
    limit: o.max ?? FAILURE_LIMIT,
    // A response of 400 or more counts; a 2xx or 3xx is given back.
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      const resetAt = (req as unknown as { rateLimit: { resetTime: Date } }).rateLimit.resetTime.getTime();
      const retryAfterSec = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      const source = req.ip ?? '';
      if (logged.get(source) !== resetAt) {
        if (logged.size >= 1000) for (const [k, end] of logged) if (end <= Date.now()) logged.delete(k);
        logged.set(source, resetAt);
        o.logger?.warn('auth.throttled', `podium: too many failed requests from ${source}; refusing its requests for ${retryAfterSec} seconds`, { source, status: 429, reason: 'too many failed requests', retry_after_sec: retryAfterSec });
      }
      res.set('Retry-After', String(retryAfterSec));
      res.status(429).json({ ok: false, error: 'too many failed requests', retryAfterSec });
    },
  });
}
