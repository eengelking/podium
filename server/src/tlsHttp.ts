// Reporters over HTTP (#577, T11). With TLS on, the HTTP listener serves the reporter routes only while the Admin allows
// it (`tls.allowReportersOverHttp`) or the caller is on loopback; the console is never touched, so an Admin can always sign in.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from './logging/logger.js';
import { isLoopback } from './hostCheck.js';
import { REPORTING_MS } from './fleet/reporters.js';

const SESSION = '/api/fleet/sessions/[^/]+';
/** The calls the mod makes, each behind the reporter's credential: reports, hooks, and the held requests for peers and answers. */
const REPORTER_ROUTES: Array<[string, RegExp]> = [
  ['POST', /^\/api\/fleet\/(report|hook)$/],
  ['GET', new RegExp(`^${SESSION}/peers$`)],
  ['POST', new RegExp(`^${SESSION}/peers/(messages|access|requests/[^/]+|deliveries/[^/]+/result)$`)],
  ['PUT', new RegExp(`^${SESSION}/(diffs|asks)/[^/]+$`)],
  ['GET', new RegExp(`^${SESSION}/asks/[^/]+/answer$`)],
  ['POST', new RegExp(`^${SESSION}/recording$`)],
  ['POST', new RegExp(`^${SESSION}/(asks/[^/]+/close|deliveries/[^/]+/result)$`)],
];

/** Express routes case-insensitively and ignores one trailing slash, so the match must too, or `/API/fleet/report/` would slip past the gate. */
export const isReporterRoute = (method: string, path: string): boolean => {
  const p = path.toLowerCase().replace(/\/+$/, '');
  return REPORTER_ROUTES.some(([m, re]) => m === method && re.test(p));
};

/** `POST /api/reporter/renew`, matched the way Express does (case-insensitive, one trailing slash ignored). */
export const isRenewRoute = (path: string): boolean => path.toLowerCase().replace(/\/+$/, '') === '/api/reporter/renew';

/** Whether a request came in over the HTTPS listener (the socket, never a forwarded header). */
export const isEncrypted = (req: Pick<Request, 'socket'>): boolean => (req.socket as { encrypted?: boolean }).encrypted === true;

/** Whether a request is one the gate can refuse: plain HTTP from an address that is not loopback. Loopback and HTTPS are never refused, so they are not counted as on HTTP. */
export const refusableOverHttp = (req: Pick<Request, 'socket' | 'ip'>): boolean => !isEncrypted(req) && !isLoopback((req.ip ?? '').replace(/^::ffff:/, ''));

/** Which reporters were heard from lately, and over which transport, for "the 3 reporters connected over HTTP". Held in memory: it describes who is connected now. */
export class ReporterTransport {
  private readonly seen = new Map<string, { https: boolean; at: number }>();

  /** `https` is true for any request the gate would not refuse: HTTPS, or loopback. */
  note(key: string, https: boolean, now: number): void {
    this.seen.set(key, { https, at: now });
  }

  count(now: number): { overHttp: number; total: number } {
    let overHttp = 0;
    let total = 0;
    for (const [key, s] of this.seen) {
      if (now - s.at >= REPORTING_MS) {
        this.seen.delete(key);
        continue;
      }
      total++;
      if (!s.https) overHttp++;
    }
    return { overHttp, total };
  }
}

export interface ReporterHttpGateOptions {
  /** True while the HTTPS listener runs. With TLS off, or failed to start, nothing is refused. */
  active: () => boolean;
  /** `tls.allowReportersOverHttp`, read each time. */
  allowed: () => boolean;
  logger: Logger;
  /** Told of every refusal, for the Reporters page's rejected list. */
  rejected?: (source: string | null, reason: string) => void;
}

export const HTTP_REFUSED = 'reporters must use a reporter config over HTTPS; the Admin has turned off reporters over HTTP';

export function reporterHttpGate(o: ReporterHttpGateOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isEncrypted(req) || !isReporterRoute(req.method, req.path) || !o.active() || o.allowed()) return next();
    // `req.ip` follows X-Forwarded-For only from a hop named in PODIUM_TRUST_PROXY (#305), so a header cannot claim loopback.
    const ip = req.ip ?? '';
    if (!refusableOverHttp(req)) return next();
    o.logger.warn('tls.http_refused', `podium: refused ${req.method} ${req.path} from ${ip || 'unknown'} over HTTP: ${HTTP_REFUSED}`, { route: req.path, method: req.method, status: 403, source: ip || null });
    o.rejected?.(ip || null, HTTP_REFUSED);
    res.status(403).json({ ok: false, error: HTTP_REFUSED, path: '$' });
  };
}
