import type { DatabaseSync } from 'node:sqlite';
import {
  ALLOW_HTTP_KEY, COUNTDOWN_KEY, FIELDS, REPORTER_FIELDS, SERVING_DEFAULTS, servingFieldError,
  type ReporterKey, type ServingSettings, type SettingKey,
} from '../../tlsRenew.js';
import type { ReporterSettings } from '../../tlsReporterRenew.js';

const reporterKeys = Object.keys(REPORTER_FIELDS) as ReporterKey[];
const keys = Object.keys(FIELDS) as SettingKey[];

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

  /** `tls.allowReportersOverHttp`. A missing row reads as on, so nothing stops before the server has decided (SPEC 6). */
  allowReportersOverHttp(): boolean {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(ALLOW_HTTP_KEY) as { value: string } | undefined;
    return row?.value !== 'false';
  }

  /** The first time TLS runs: on for an install that already has reporters, off for a fresh one. A row that exists is left alone. */
  seedAllowReportersOverHttp(existingInstall: boolean): void {
    this.db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(ALLOW_HTTP_KEY, String(existingInstall));
  }

  /** The setting for a person's certificate, one `settings` row.  A missing or invalid row reads as its default. */
  getReporter(): ReporterSettings {
    const out: ReporterSettings = { lifetimeDays: REPORTER_FIELDS['tls.reporter.lifetimeDays'].def };
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
      if (k === ALLOW_HTTP_KEY) {
        if (typeof patch[k] !== 'boolean') return { ok: false, error: 'Allow reporters over HTTP must be on or off' };
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
