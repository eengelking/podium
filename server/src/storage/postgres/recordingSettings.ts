// The Admin's session recording limits on PostgreSQL (#822): JSON in the `settings` row `recording_settings`, as in the SQLite store.
import { RECORDING_DEFAULTS, RECORDING_RANGES, type RecordingSettings } from '../../fleet/protocol.js';
import type { RecordingSettingsApi } from '../types.js';
import type { PgDb } from './conn.js';

const KEY = 'recording_settings';
const FIELDS = ['keepHours', 'budgetMb', 'sessionMb'] as const;
type Field = (typeof FIELDS)[number];

const isWhole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const LABELS: Record<Field, string> = { keepHours: 'Keep a recording for', budgetMb: 'The disk budget', sessionMb: 'The limit for one session' };
const UNITS: Record<Field, string> = { keepHours: 'hours', budgetMb: 'megabytes', sessionMb: 'megabytes' };

const fieldError = (field: Field, v: unknown): string | null => {
  const { min, max } = RECORDING_RANGES[field];
  return isWhole(v, min, max) ? null : `${LABELS[field]} must be a whole number of ${UNITS[field]} from ${min} to ${max}`;
};

export const pgRecordingSettings = (db: PgDb): RecordingSettingsApi => {
  const get = async (): Promise<RecordingSettings> => {
    const row = await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [KEY]);
    let saved: Record<string, unknown> = {};
    try {
      const parsed: unknown = row ? JSON.parse(row.value) : {};
      if (parsed && typeof parsed === 'object') saved = parsed as Record<string, unknown>;
    } catch {
      saved = {};
    }
    const out: RecordingSettings = { ...RECORDING_DEFAULTS };
    for (const f of FIELDS) if (fieldError(f, saved[f]) === null) out[f] = saved[f] as number;
    return out;
  };
  return {
    get,
    set: (patch) =>
      db.tx(async () => {
        const keys = Object.keys(patch);
        if (!keys.length) return { ok: false as const, error: 'nothing to change' };
        const before = await get();
        const next = { ...before };
        for (const k of keys) {
          if (!(FIELDS as readonly string[]).includes(k)) return { ok: false as const, error: `unknown setting: ${k}` };
          const err = fieldError(k as Field, patch[k]);
          if (err) return { ok: false as const, error: err };
          next[k as Field] = patch[k] as number;
        }
        if (next.sessionMb > next.budgetMb) return { ok: false as const, error: 'The limit for one session cannot be above the disk budget' };
        await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [KEY, JSON.stringify(next)]);
        return { ok: true as const, before, settings: next };
      }),
  };
};
