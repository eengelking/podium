// The Admin's session recording limits (#353), kept as JSON in the `settings` row `recording_settings`, like the Activity history's
// (activityHistorySettings.ts). An unset row, or a field that is missing or out of range, takes the default. All three numbers are
// provisional until measured, so the server reads them from this row on every call and a change needs no code change.
import type { DatabaseSync } from 'node:sqlite';
import { RECORDING_DEFAULTS, RECORDING_RANGES, type RecordingSettings } from './protocol.js';

const KEY = 'recording_settings';
const FIELDS = ['keepHours', 'budgetMb', 'sessionMb'] as const;
type Field = (typeof FIELDS)[number];

export const MB = 1024 * 1024;
export const HOUR_MS = 3_600_000;

const isWhole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const LABELS: Record<Field, string> = { keepHours: 'Keep a recording for', budgetMb: 'The disk budget', sessionMb: 'The limit for one session' };
const UNITS: Record<Field, string> = { keepHours: 'hours', budgetMb: 'megabytes', sessionMb: 'megabytes' };

/** The error for one field's value, or null when it is acceptable. */
export function recordingFieldError(field: Field, v: unknown): string | null {
  const { min, max } = RECORDING_RANGES[field];
  return isWhole(v, min, max) ? null : `${LABELS[field]} must be a whole number of ${UNITS[field]} from ${min} to ${max}`;
}

export class RecordingSettingsStore {
  constructor(private readonly db: DatabaseSync) {}

  /** The saved settings; a missing or invalid field takes its default. */
  get(): RecordingSettings {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    let saved: Record<string, unknown> = {};
    try {
      const parsed: unknown = row ? JSON.parse(row.value) : {};
      if (parsed && typeof parsed === 'object') saved = parsed as Record<string, unknown>;
    } catch {
      saved = {};
    }
    const out: RecordingSettings = { ...RECORDING_DEFAULTS };
    for (const f of FIELDS) if (recordingFieldError(f, saved[f]) === null) out[f] = saved[f] as number;
    return out;
  }

  /** Saves the given fields. Every field is checked first, and nothing is saved when one fails. `before` is what was saved until now. */
  set(patch: Record<string, unknown>): { ok: true; before: RecordingSettings; settings: RecordingSettings } | { ok: false; error: string } {
    const keys = Object.keys(patch);
    if (!keys.length) return { ok: false, error: 'nothing to change' };
    const before = this.get();
    const next = { ...before };
    for (const k of keys) {
      if (!(FIELDS as readonly string[]).includes(k)) return { ok: false, error: `unknown setting: ${k}` };
      const err = recordingFieldError(k as Field, patch[k]);
      if (err) return { ok: false, error: err };
      next[k as Field] = patch[k] as number;
    }
    if (next.sessionMb > next.budgetMb) return { ok: false, error: 'The limit for one session cannot be above the disk budget' };
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(next));
    return { ok: true, before, settings: next };
  }
}
