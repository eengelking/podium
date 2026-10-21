// Built-in TLS (#577, T4): the serving certificate renews itself. It is checked at start and once a day, renewed when
// fewer than `tls.serving.renewBeforeDays` remain, and swapped into the running listener with `setSecureContext`, so
// nothing restarts: an open connection keeps the old certificate and a new one gets the new. A failure is logged,
// kept for the Admin API and retried at the next daily check.
import { X509Certificate } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from './logging/logger.js';
import { describeCert, listPrevious, renewServing, SERVING_DAYS, type CertInfo, type ServerNames } from './tlsCa.js';
import { REPORTER_DAYS } from './tlsPeople.js';
import type { ReporterSettings } from './tlsReporterRenew.js';

const DAY_MS = 86_400_000;

export interface ServingSettings {
  lifetimeDays: number;
  renewBeforeDays: number;
  /** `tls.header.countdown` (#586): show the healthy countdown in the header pill. A failed renewal and an expired certificate always show. */
  headerCountdown: boolean;
}

const COUNTDOWN_KEY = 'tls.header.countdown';

/** The settings this issue owns, by the key SPEC 6 gives them. */
const FIELDS = {
  'tls.serving.lifetimeDays': { field: 'lifetimeDays', label: 'The serving certificate lifetime', def: SERVING_DAYS, min: 30, max: 825 },
  'tls.serving.renewBeforeDays': { field: 'renewBeforeDays', label: 'Renew the serving certificate before expiry', def: 30, min: 7, max: 90 },
} as const;

/** A person's certificate (#585): how long it lasts, and how long after expiry the reporter may still renew it. */
const REPORTER_FIELDS = {
  'tls.reporter.lifetimeDays': { field: 'lifetimeDays', label: 'A person’s certificate lifetime', def: REPORTER_DAYS, min: 30, max: 365 },
  'tls.reporter.graceDays': { field: 'graceDays', label: 'The grace after a person’s certificate expires', def: 30, min: 0, max: 90 },
} as const;

type ReporterKey = keyof typeof REPORTER_FIELDS;
const reporterKeys = Object.keys(REPORTER_FIELDS) as ReporterKey[];

type SettingKey = keyof typeof FIELDS;
const keys = Object.keys(FIELDS) as SettingKey[];

export const SERVING_DEFAULTS: ServingSettings = { lifetimeDays: FIELDS['tls.serving.lifetimeDays'].def, renewBeforeDays: FIELDS['tls.serving.renewBeforeDays'].def, headerCountdown: true };

const isWhole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** The error for one setting's value (it names the range), or null when it is acceptable. */
export function servingFieldError(key: SettingKey | ReporterKey, v: unknown): string | null {
  const f = key in FIELDS ? FIELDS[key as SettingKey] : REPORTER_FIELDS[key as ReporterKey];
  return isWhole(v, f.min, f.max) ? null : `${f.label} must be a whole number of days from ${f.min} to ${f.max}`;
}

/** The two serving settings, one `settings` row each. A missing or invalid row reads as its default. */
export class TlsSettingsStore {
  constructor(private readonly db: DatabaseSync) {}

  get(): ServingSettings {
    const out: ServingSettings = { ...SERVING_DEFAULTS };
    for (const k of keys) {
      const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined;
      const n = row ? Number(row.value) : Number.NaN;
      if (servingFieldError(k, n) === null) out[FIELDS[k].field] = n;
    }
    const c = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(COUNTDOWN_KEY) as { value: string } | undefined;
    if (c?.value === 'false') out.headerCountdown = false;
    return out;
  }

  /** The two settings for a person's certificate, one `settings` row each. A missing or invalid row reads as its default. */
  getReporter(): ReporterSettings {
    const out: ReporterSettings = { lifetimeDays: REPORTER_FIELDS['tls.reporter.lifetimeDays'].def, graceDays: REPORTER_FIELDS['tls.reporter.graceDays'].def };
    for (const k of reporterKeys) {
      const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined;
      const n = row ? Number(row.value) : Number.NaN;
      if (servingFieldError(k, n) === null) out[REPORTER_FIELDS[k].field] = n;
    }
    return out;
  }

  /** Saves the given settings, keyed as in SPEC 6. Every value is checked first and nothing is saved when one fails. */
  set(patch: Record<string, unknown>): { ok: true; settings: ServingSettings; changed: string[] } | { ok: false; error: string } {
    const given = Object.keys(patch);
    if (!given.length) return { ok: false, error: 'nothing to change' };
    for (const k of given) {
      if (k === COUNTDOWN_KEY) {
        if (typeof patch[k] !== 'boolean') return { ok: false, error: 'The header countdown must be on or off' };
        continue;
      }
      if (!(keys as string[]).includes(k) && !(reporterKeys as string[]).includes(k)) return { ok: false, error: `unknown setting: ${k}` };
      const err = servingFieldError(k as SettingKey | ReporterKey, patch[k]);
      if (err) return { ok: false, error: err };
    }
    const put = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const k of given) put.run(k, String(patch[k]));
    return { ok: true, settings: this.get(), changed: given };
  }
}

export type RenewTrigger = 'start' | 'schedule' | 'manual';

export interface RenewFailure {
  at: string;
  reason: string;
  trigger: RenewTrigger;
}

export interface RenewerOptions {
  dir: string;
  /** The names a renewed certificate is valid for (bind address and PODIUM_ALLOWED_HOSTS). */
  names: ServerNames;
  /** The running listener the new certificate is swapped into. */
  server: { setSecureContext(o: { cert: string; key: string; ca?: string[] }): void };
  /** The CA certificate(s) client certificates are verified against, passed again with each new serving certificate (#583). */
  ca?: string[];
  /** The CA certificate PEM, for the Admin page to describe and offer (#586). Never the key. */
  caCert?: string;
  /** The serving certificate the listener started with. */
  serving: CertInfo;
  settings: () => ServingSettings;
  logger: Logger;
  openssl?: string;
  now?: () => number;
  /** How often the due check runs; a day unless a test says otherwise. */
  checkEveryMs?: number;
}

export interface CertificateView {
  /** The CA certificate (never its key), or null when the renewer was not given it. */
  ca: CertInfo | null;
  serving: CertInfo;
  /** What a renewal would put on the certificate, and what the running one carries. */
  names: ServerNames;
  certificateNames: ServerNames;
  previous: CertInfo[];
  settings: ServingSettings;
  lastRenewed: { at: string; trigger: RenewTrigger } | null;
  lastFailure: RenewFailure | null;
}

/** The DNS and IP names in a certificate's subjectAltName. */
export function namesOf(pem: string): ServerNames {
  const out: ServerNames = { dns: [], ip: [] };
  for (const part of (new X509Certificate(pem).subjectAltName ?? '').split(',')) {
    const p = part.trim();
    if (p.startsWith('DNS:')) out.dns.push(p.slice(4));
    else if (p.startsWith('IP Address:')) out.ip.push(p.slice(11).toLowerCase());
  }
  return out;
}

export class ServingRenewer {
  private serving: CertInfo;
  private certPem: string;
  private lastFailure: RenewFailure | null = null;
  private lastRenewed: { at: string; trigger: RenewTrigger } | null = null;
  private inflight: Promise<{ ok: true; serving: CertInfo } | { ok: false; error: string }> | null = null;
  private inflightTrigger: RenewTrigger | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly o: RenewerOptions, certPem: string) {
    this.serving = o.serving;
    this.certPem = certPem;
    this.now = o.now ?? Date.now;
  }

  /** Runs the start check, then once a day. A check that fails is logged, never thrown. */
  async start(): Promise<void> {
    await this.checkDue('start');
    this.timer = setInterval(() => void this.checkDue('schedule'), this.o.checkEveryMs ?? DAY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Renews when fewer than renewBeforeDays remain. A certificate made less than a day ago is left alone, so a
   * renew-before that is longer than the lifetime renews once a day instead of at every check.
   */
  async checkDue(trigger: Exclude<RenewTrigger, 'manual'>): Promise<boolean> {
    const now = this.now();
    const left = (Date.parse(this.serving.notAfter) - now) / DAY_MS;
    const age = now - Date.parse(this.serving.notBefore);
    if (left > this.o.settings().renewBeforeDays || age < DAY_MS) return false;
    const out = await this.renew(trigger);
    return out.ok;
  }

  /** Renews at once, whatever the dates say; also takes up a changed bind address or allowed host. */
  renewNow(): Promise<{ ok: true; serving: CertInfo } | { ok: false; error: string }> {
    return this.renew('manual');
  }

  private async renew(trigger: RenewTrigger): Promise<{ ok: true; serving: CertInfo } | { ok: false; error: string }> {
    // One renewal at a time. A caller joins one that is running, except a manual renewal behind an automatic one: that
    // one may have started before the Admin changed what is asked for, so the manual one waits and then runs itself.
    if (this.inflight && trigger === 'manual' && this.inflightTrigger !== 'manual') await this.inflight;
    if (!this.inflight) {
      this.inflightTrigger = trigger;
      this.inflight = this.doRenew(trigger).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async doRenew(trigger: RenewTrigger): Promise<{ ok: true; serving: CertInfo } | { ok: false; error: string }> {
    const { logger } = this.o;
    try {
      const out = await renewServing({ dir: this.o.dir, names: this.o.names, servingDays: this.o.settings().lifetimeDays, openssl: this.o.openssl, now: this.now });
      // `setSecureContext` replaces the whole context, so the CA list that client certificates are verified against goes too unless it is given again.
      this.o.server.setSecureContext({ cert: out.cert, key: out.key, ...(this.o.ca ? { ca: this.o.ca } : {}) });
      const replaced = this.serving;
      this.serving = out.serving;
      this.certPem = out.cert;
      this.lastFailure = null;
      this.lastRenewed = { at: new Date(this.now()).toISOString(), trigger };
      logger.info('tls.serving_renewed', 'podium: renewed the serving certificate', {
        trigger,
        fingerprint_sha256: out.serving.fingerprintSha256,
        not_after: out.serving.notAfter,
        replaced_fingerprint_sha256: replaced.fingerprintSha256,
      });
      return { ok: true, serving: out.serving };
    } catch (err) {
      const reason = (err as Error).message;
      this.lastFailure = { at: new Date(this.now()).toISOString(), reason, trigger };
      logger.error('tls.renew_failed', `podium: could not renew the serving certificate: ${reason}; the current one stays in use${trigger === 'manual' ? '' : ' and the next check retries'}`, { trigger, reason });
      return { ok: false, error: reason };
    }
  }

  /** The CA certificate PEM, or null when not given. Public by nature. */
  caPem(): string | null {
    return this.o.caCert ?? null;
  }

  view(): CertificateView {
    return {
      ca: this.o.caCert ? describeCert(this.o.caCert) : null,
      serving: this.serving,
      names: this.o.names,
      certificateNames: namesOf(this.certPem),
      previous: listPrevious(this.o.dir),
      settings: this.o.settings(),
      lastRenewed: this.lastRenewed,
      lastFailure: this.lastFailure,
    };
  }
}
