// The console's read of the certificate countdown (#586, T8). Only the facts the header pill needs: no fingerprint,
// name or path. The client decides whether to show it: `ok` never, `soon`/`serious`/`critical` when the Admin's
// countdown switch is on or a renewal failed, `expired` always.
import { Router } from 'express';
import type { CertificateView } from './tlsRenew.js';

const DAY_MS = 86_400_000;

export type TlsStage = 'ok' | 'soon' | 'serious' | 'critical' | 'expired';

/** Blue at 30 days or fewer, orange at 10, red at 5, expired at 0 (SPEC 6). */
export function stageForDays(daysLeft: number): TlsStage {
  if (daysLeft <= 0) return 'expired';
  if (daysLeft <= 5) return 'critical';
  if (daysLeft <= 10) return 'serious';
  if (daysLeft <= 30) return 'soon';
  return 'ok';
}

export type TlsStatus =
  | { enabled: false }
  | { enabled: true; expiresAt: string; subject: 'ca' | 'serving'; daysLeft: number; stage: TlsStage; renewalFailed: boolean; showCountdown: boolean };

type StatusView = Pick<CertificateView, 'serving' | 'lastFailure'> & { ca: CertificateView['ca']; settings: Pick<CertificateView['settings'], 'headerCountdown'> };

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
    stage: stageForDays(daysLeft),
    renewalFailed: view.lastFailure !== null,
    showCountdown: view.settings.headerCountdown,
  };
}

export function createTlsStatusRouter(o: { view: () => StatusView | null; now?: () => number }): Router {
  const router = Router();
  router.get('/status', (_req, res) => {
    res.json(tlsStatus(o.view(), (o.now ?? Date.now)()));
  });
  return router;
}
