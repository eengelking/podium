// The Admin's Activity history choice on PostgreSQL (#822): JSON in the `settings` row `activity_history`, as in the SQLite store.
// A keep policy needs a sign-in token on the server.
import {
  ACTIVITY_HISTORY_DEFAULTS,
  type ActivityHistoryPolicy,
  type ActivityHistorySettings,
  type ActivityHistoryUnit,
} from '../../fleet/activityHistoryTypes.js';
import { FIELDS, activityHistoryFieldError } from '../settings.js';
import type { ActivityHistorySettingsApi } from '../types.js';
import type { PgDb } from './conn.js';

const KEY = 'activity_history';

export const pgActivityHistorySettings = (db: PgDb, authOn: boolean): ActivityHistorySettingsApi => {
  const get = async (): Promise<ActivityHistorySettings> => {
    const row = await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [KEY]);
    let saved: Record<string, unknown> = {};
    try {
      const parsed: unknown = row ? JSON.parse(row.value) : {};
      if (parsed && typeof parsed === 'object') saved = parsed as Record<string, unknown>;
    } catch {
      saved = {};
    }
    const out: ActivityHistorySettings = { ...ACTIVITY_HISTORY_DEFAULTS };
    if (activityHistoryFieldError('policy', saved.policy) === null) out.policy = saved.policy as ActivityHistoryPolicy;
    if (activityHistoryFieldError('n', saved.n) === null) out.n = saved.n as number;
    if (activityHistoryFieldError('unit', saved.unit) === null) out.unit = saved.unit as ActivityHistoryUnit;
    if (saved.capGb !== undefined && activityHistoryFieldError('capGb', saved.capGb) === null) out.capGb = saved.capGb as number | null;
    if (!authOn) out.policy = 'default';
    return out;
  };
  return {
    get,
    set: (patch) =>
      db.tx(async () => {
        const keys = Object.keys(patch);
        if (!keys.length) return { ok: false as const, error: 'nothing to change' };
        const next = await get();
        for (const k of keys) {
          if (!(FIELDS as readonly string[]).includes(k)) return { ok: false as const, error: `unknown setting: ${k}` };
          const err = activityHistoryFieldError(k as (typeof FIELDS)[number], patch[k]);
          if (err) return { ok: false as const, error: err };
          (next as unknown as Record<string, unknown>)[k] = patch[k];
        }
        if (next.policy !== 'default' && !authOn) {
          return { ok: false as const, error: 'Keeping activity needs the server to run with a sign-in token (PODIUM_TOKEN), so only the owner and an Admin can read it' };
        }
        await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [KEY, JSON.stringify(next)]);
        return { ok: true as const, settings: next };
      }),
  };
};
