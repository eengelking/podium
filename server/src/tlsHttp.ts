// Reporters over HTTP (#577, T11). With TLS on, the HTTP listener serves the reporter routes only while the Admin allows
// it (`tls.allowReportersOverHttp`) or the caller is on loopback; the console is never touched, so an Admin can always sign in.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from './logging/logger.js';
import { isLoopback } from './hostCheck.js';
import { REPORTING_MS } from './fleet/reporters.js';

/**
 * The calls the mod makes, each behind the reporter's credential: reports, hooks, and the held requests for peers and answers.
 * `:id` stands for one path segment. The mod's helper (`mod/podium-reporter/hooks/helper.mjs`) forwards only these and keeps a copy
 * of the list; `reporterHelper.test.ts` fails if the two differ, the way `protocol.test.ts` does for the protocol block (#668).
 */
export const REPORTER_ROUTE_TEMPLATES: ReadonlyArray<readonly [method: string, path: string]> = [
  ['POST', '/api/fleet/report'],
  ['POST', '/api/fleet/hook'],
  ['GET', '/api/fleet/sessions/:id/peers'],
  ['POST', '/api/fleet/sessions/:id/peers/messages'],
  ['POST', '/api/fleet/sessions/:id/peers/access'],
  ['POST', '/api/fleet/sessions/:id/peers/requests/:id'],
  ['POST', '/api/fleet/sessions/:id/peers/deliveries/:id/result'],
  ['PUT', '/api/fleet/sessions/:id/diffs/:id'],
  ['PUT', '/api/fleet/sessions/:id/asks/:id'],
  ['GET', '/api/fleet/sessions/:id/asks/:id/answer'],
  ['POST', '/api/fleet/sessions/:id/recording'],
  ['POST', '/api/fleet/sessions/:id/asks/:id/close'],
  ['POST', '/api/fleet/sessions/:id/deliveries/:id/result'],
];
const REPORTER_ROUTES: Array<[string, RegExp]> = REPORTER_ROUTE_TEMPLATES.map(([method, path]) => [method, new RegExp(`^${path.replaceAll(':id', '[^/]+')}$`)]);

/** `s` without the `/` characters at its end. A loop, not `/\/+$/`, which is quadratic on a long run of slashes followed by another character. */
export const trimTrailingSlashes = (s: string): string => {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
};

/** Express routes case-insensitively and ignores one trailing slash, so the match must too, or `/API/fleet/report/` would slip past the gate. */
export const isReporterRoute = (method: string, path: string): boolean => {
  const p = trimTrailingSlashes(path.toLowerCase());
  return REPORTER_ROUTES.some(([m, re]) => m === method && re.test(p));
};

/** `POST /api/reporter/renew`, matched the way Express does (case-insensitive, one trailing slash ignored). */
export const isRenewRoute = (path: string): boolean => trimTrailingSlashes(path.toLowerCase()) === '/api/reporter/renew';

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
