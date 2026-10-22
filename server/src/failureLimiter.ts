// A brake on failed requests from one address, ahead of every route that checks a token or a certificate. Wrong secrets already
// have their own lockouts (lockout.ts); this limits the rest of what a client can do from one address by failing (a refused
// certificate, a bad request, a probe for a route), so that cannot be used to keep the server busy. Successful requests are never
// counted, so one busy reporter or an open console never trips it.
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

export function failureLimiter(o: FailureLimiterOptions = {}): RequestHandler {
  const limit = o.max ?? FAILURE_LIMIT;
  return rateLimit({
    windowMs: o.windowMs ?? FAILURE_WINDOW_MS,
    limit,
    // A response of 400 or more counts; a 2xx or 3xx is given back.
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      const info = (req as { rateLimit?: { used: number; resetTime?: Date } }).rateLimit;
      const retryAfterSec = Math.max(1, Math.ceil(((info?.resetTime?.getTime() ?? Date.now()) - Date.now()) / 1000));
      // Once per window and address, not once per refused request, or the log becomes the thing being flooded.
      if (info && info.used === limit + 1) {
        o.logger?.warn('auth.throttled', `podium: too many failed requests from ${req.ip ?? 'unknown'}; refusing its requests for ${retryAfterSec} seconds`, { source: req.ip, status: 429, reason: 'too many failed requests', retry_after_sec: retryAfterSec });
      }
      res.set('Retry-After', String(retryAfterSec));
      res.status(429).json({ ok: false, error: 'too many failed requests', retryAfterSec });
    },
  });
}
