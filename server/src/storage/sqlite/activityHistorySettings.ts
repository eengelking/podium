// The Admin's Activity history choice (#432), kept as JSON in the `settings` row `activity_history`, like the messaging
// settings (peerSettings.ts). Under the default policy nothing is stored. A keep policy needs a sign-in token on the server:
// without one nobody could be allowed to read what is kept.
import type { DatabaseSync } from 'node:sqlite';
import {
  ACTIVITY_HISTORY_DEFAULTS,
  ACTIVITY_HISTORY_POLICIES,
  ACTIVITY_HISTORY_RANGES,
  ACTIVITY_HISTORY_UNITS,
  ACTIVITY_UNIT_MS,
  type ActivityHistoryPolicy,
  type ActivityHistorySettings,
  type ActivityHistoryUnit,
} from '../../fleet/activityHistoryTypes.js';
import { FIELDS, activityHistoryFieldError } from '../settings.js';

const KEY = 'activity_history';

export class ActivityHistorySettingsStore {
  constructor(
    private readonly db: DatabaseSync,
    /** Whether the server runs with a sign-in token. */
    private readonly authOn: boolean,
  ) {}

  /** The saved settings; a missing or invalid field takes its default. Without a token the policy is always `default`. */
  get(): ActivityHistorySettings {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
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
    if (!this.authOn) out.policy = 'default';
    return out;
  }

  /** Saves the given fields. Every field is checked first, and nothing is saved when one fails. */
  set(patch: Record<string, unknown>): { ok: true; settings: ActivityHistorySettings } | { ok: false; error: string } {
    const keys = Object.keys(patch);
    if (!keys.length) return { ok: false, error: 'nothing to change' };
    const next = this.get();
    for (const k of keys) {
      if (!(FIELDS as readonly string[]).includes(k)) return { ok: false, error: `unknown setting: ${k}` };
      const err = activityHistoryFieldError(k as (typeof FIELDS)[number], patch[k]);
      if (err) return { ok: false, error: err };
      (next as unknown as Record<string, unknown>)[k] = patch[k];
    }
    if (next.policy !== 'default' && !this.authOn) {
      return { ok: false, error: 'Keeping activity needs the server to run with a sign-in token (PODIUM_TOKEN), so only the owner and an Admin can read it' };
    }
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(next));
    return { ok: true, settings: next };
  }
}
