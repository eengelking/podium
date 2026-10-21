// The header's certificate countdown (#586, T8): what GET /api/tls/status answers, how it becomes a pill, and the hook that
// asks for it. The route is open to every reader and carries no token, fingerprint or name.
import { useEffect, useState } from "react";

export type TlsStage = "ok" | "soon" | "serious" | "critical" | "expired";
export type TlsStatus =
  | { enabled: false }
  | { enabled: true; expiresAt: string; subject: "ca" | "serving"; daysLeft: number; stage: TlsStage; renewalFailed: boolean; showCountdown: boolean };

/** Where the pill and the Admin menu lead. Admin already follows `#/admin/<page>` for Settings (the wall's notices). */
export const CERTS_HASH = "#/admin/certificates";
/** How often the header asks again. A certificate's days change once a day, so a few minutes is plenty. */
export const TLS_POLL_MS = 5 * 60_000;

export interface PillView {
  /** The `.pill` modifier: `soon` (blue), `serious` (orange) or `bad` (red). */
  tone: "soon" | "serious" | "bad";
  icon: "clock" | "warn" | "cross";
  text: string;
  title: string;
}

const DAY_MS = 86_400_000;
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const dayWord = (days: number) => (days <= 0 ? "today" : `in ${plural(days, "day")}`);

/**
 * The pill for a status, or null when the header shows nothing. A healthy certificate never shows. The blue, orange and red
 * countdown follows the Admin's switch; a failed renewal and an expired certificate always show (decision 12).
 */
export function pillOf(s: TlsStatus | null, now: number): PillView | null {
  if (!s?.enabled) return null;
  const expiresMs = Date.parse(s.expiresAt);
  const what = s.subject === "ca" ? "The CA" : "The serving certificate";
  const open = "Open Admin > Server > Certificates.";
  const date = s.expiresAt.slice(0, 10);
  // The server counts whole days, so the last day reads as 0 and expired. The pill says "today" until the moment passes.
  const stage: TlsStage = s.stage === "expired" && expiresMs > now ? "critical" : s.stage;
  if (stage === "expired") return { tone: "bad", icon: "cross", text: "Certificate expired", title: `${what} expired on ${date}. ${open}` };
  if (stage === "ok") {
    if (!s.renewalFailed) return null;
    return { tone: "serious", icon: "warn", text: "Certificate renewal failed", title: `The last renewal of the serving certificate failed. ${open}` };
  }
  if (!s.showCountdown && !s.renewalFailed) return null;
  const tone = stage === "soon" ? "soon" : stage === "serious" ? "serious" : "bad";
  return { tone, icon: stage === "soon" ? "clock" : "warn", text: `Certificate expires ${dayWord(Math.max(0, s.daysLeft))}`, title: `${what} expires on ${date}. ${open}` };
}

/** The shape the route answers; anything else (another route's reply, a proxy's page) is ignored. */
function isTlsStatus(b: unknown): b is TlsStatus {
  const s = b as { enabled?: boolean; expiresAt?: unknown; stage?: unknown } | null;
  return s?.enabled === false || (s?.enabled === true && typeof s.expiresAt === "string" && typeof s.stage === "string");
}

/** Reads the status once, then every few minutes. A failed read keeps what was known and shows nothing new. */
export function useTlsStatus(): TlsStatus | null {
  const [status, setStatus] = useState<TlsStatus | null>(null);
  useEffect(() => {
    let live = true;
    const read = async () => {
      // Nobody is looking at a hidden tab, and the answer changes once a day.
      if (document.visibilityState === "hidden") return;
      try {
        const r = await fetch("/api/tls/status", { cache: "no-store" });
        const body = r.ok ? ((await r.json()) as TlsStatus | null) : null;
        if (live && isTlsStatus(body)) setStatus(body);
      } catch {
        // No answer, or no TLS route: the header simply shows nothing new.
      }
    };
    void read();
    const id = setInterval(() => void read(), TLS_POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return status;
}

/** Whole days from `now` to a date, floored as the server does; negative once it has passed. */
export function daysUntil(iso: string, now: number): number {
  return Math.floor((Date.parse(iso) - now) / DAY_MS);
}
