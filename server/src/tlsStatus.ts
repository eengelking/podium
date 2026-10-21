// The console's read of the certificate countdown (#586, T8). Only the facts the header pill needs: no fingerprint,
// name or path. The client decides whether to show it: `ok` never, `soon`/`serious`/`critical` when the Admin's
// countdown switch is on or a renewal failed, `expired` always.
import { Router } from 'express';
import type { CertificateView } from './tlsRenew.js';

const DAY_MS = 86_400_000;

export type TlsStage = 'ok' | 'soon' | 'serious' | 'critical' | 'expired';

/** Blue at 30 days or fewer, orange at 10, red at 5 (SPEC 6). A negative count is past the end; the last day (0) is still red. */
export function stageForDays(daysLeft: number): TlsStage {
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= 5) return 'critical';
  if (daysLeft <= 10) return 'serious';
  if (daysLeft <= 30) return 'soon';
  return 'ok';
}

export type TlsStatus =
  | { enabled: false }
  | { enabled: true; expiresAt: string; subject: 'ca' | 'serving'; daysLeft: number; stage: TlsStage; renewalFailed: boolean; showCountdown: boolean };

/** What the pill needs, from `ServingRenewer.statusView()`: held in memory, nothing parsed or read from disk. */
export interface StatusView {
  serving: { notAfter: string };
  ca: { notAfter: string } | null;
  lastFailure: CertificateView['lastFailure'];
  settings: Pick<CertificateView['settings'], 'headerCountdown'>;
}

export function tlsStatus(view: StatusView | null, now: number): TlsStatus {
  if (!view) return { enabled: false };
  const serving = Date.parse(view.serving.notAfter);
  const ca = view.ca ? Date.parse(view.ca.notAfter) : Number.POSITIVE_INFINITY;
  const caFirst = ca < serving;
  const end = caFirst ? ca : serving;
  const daysLeft = Math.floor((end - now) / DAY_MS);
  return {
    enabled: true,
    expiresAt: new Date(end).toISOString(),
    subject: caFirst ? 'ca' : 'serving',
    daysLeft,
    // The notice window covers the last day: expired is the moment the certificate ends, not when the day count reaches 0.
    stage: end <= now ? 'expired' : stageForDays(Math.max(0, daysLeft)),
    renewalFailed: view.lastFailure !== null,
    showCountdown: view.settings.headerCountdown,
  };
}

/** How long an answer is reused. The route is open and every console tab asks, so most asks cost nothing. */
export const STATUS_CACHE_MS = 30_000;

export function createTlsStatusRouter(o: { view: () => StatusView | null; now?: () => number }): Router {
  const router = Router();
  // The answer is reused for a short while, and never past the moment a certificate ends, so expiry shows at once.
  let cached: { body: TlsStatus; until: number } | null = null;
  router.get('/status', (_req, res) => {
    const now = (o.now ?? Date.now)();
    if (!cached || now >= cached.until) {
      const body = tlsStatus(o.view(), now);
      cached = { body, until: Math.min(now + STATUS_CACHE_MS, body.enabled ? Date.parse(body.expiresAt) : Number.POSITIVE_INFINITY) };
    }
    res.json(cached.body);
  });
  return router;
}
