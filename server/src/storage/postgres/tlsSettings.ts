// The TLS settings on PostgreSQL (#822): one `settings` row each, as in the SQLite store.
import {
  ALLOW_HTTP_KEY, COUNTDOWN_KEY, FIELDS, REPORTER_FIELDS, SERVING_DEFAULTS, servingFieldError,
  type ReporterKey, type ServingSettings, type SettingKey,
} from '../../tlsRenew.js';
import type { ReporterSettings } from '../../tlsReporterRenew.js';
import type { TlsSettingsApi } from '../types.js';
import type { PgDb } from './conn.js';

const reporterKeys = Object.keys(REPORTER_FIELDS) as ReporterKey[];
const keys = Object.keys(FIELDS) as SettingKey[];

export const pgTlsSettings = (db: PgDb): TlsSettingsApi => {
  const value = async (key: string): Promise<string | undefined> => (await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]))?.value;
  const get = async (): Promise<ServingSettings> => {
    const out: ServingSettings = { ...SERVING_DEFAULTS };
    for (const k of keys) {
      const v = await value(k);
      const n = v === undefined ? Number.NaN : Number(v);
      if (servingFieldError(k, n) === null) out[FIELDS[k].field] = n;
    }
    if ((await value(COUNTDOWN_KEY)) === 'false') out.headerCountdown = false;
    return out;
  };
  return {
    get,
    async allowReportersOverHttp() {
      return (await value(ALLOW_HTTP_KEY)) !== 'false';
    },
    async seedAllowReportersOverHttp(existingInstall) {
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING', [ALLOW_HTTP_KEY, String(existingInstall)]);
    },
    async getReporter() {
      const out: ReporterSettings = { lifetimeDays: REPORTER_FIELDS['tls.reporter.lifetimeDays'].def };
      for (const k of reporterKeys) {
        const v = await value(k);
        const n = v === undefined ? Number.NaN : Number(v);
        if (servingFieldError(k, n) === null) out[REPORTER_FIELDS[k].field] = n;
      }
      return out;
    },
    set: (patch) =>
      db.tx(async () => {
        const given = Object.keys(patch);
        if (!given.length) return { ok: false as const, error: 'nothing to change' };
        for (const k of given) {
          if (k === COUNTDOWN_KEY) {
            if (typeof patch[k] !== 'boolean') return { ok: false as const, error: 'The header countdown must be on or off' };
            continue;
          }
          if (k === ALLOW_HTTP_KEY) {
            if (typeof patch[k] !== 'boolean') return { ok: false as const, error: 'Allow reporters over HTTP must be on or off' };
            continue;
          }
          if (!(keys as string[]).includes(k) && !(reporterKeys as string[]).includes(k)) return { ok: false as const, error: `unknown setting: ${k}` };
          const err = servingFieldError(k as SettingKey | ReporterKey, patch[k]);
          if (err) return { ok: false as const, error: err };
        }
        for (const k of given) {
          await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, String(patch[k])]);
        }
        return { ok: true as const, settings: await get(), changed: given };
      }),
  };
};
