import type { DatabaseSync } from 'node:sqlite';
import { FEATURES, isFeatureId, featureDefault } from '../features.js';

const PREFIX = 'feature.';

/**
 * Server-wide feature flags (Admin > Settings > Feature flags): one on/off switch per feature, each with its own default.
 * They live in the settings table with the other Admin settings (`feature.<id>`, '0' when off and '1' when on; unset is
 * the default), so they apply to every browser and survive a restart. `onChange` lets the fleet act on a change and
 * tell open browsers.
 */
export class FeatureFlags {
  constructor(
    private readonly db: DatabaseSync,
    private readonly onChange: (id: string, on: boolean) => void = () => {},
  ) {}

  private get(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value;
  }

  featureOn(id: string): boolean {
    const v = this.get(PREFIX + id);
    if (v === '0') return false;
    if (v === '1') return true;
    return featureDefault(id);
  }

  /** Returns false for an id that is not a known flag. */
  setFeature(id: string, on: boolean): boolean {
    if (!isFeatureId(id)) return false;
    const value = on ? '1' : '0';
    const was = this.get(PREFIX + id);
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(PREFIX + id, value);
    // An unset flag takes its default, so writing the default over nothing is no change.
    if ((was ?? (featureDefault(id) ? '1' : '0')) !== value) this.onChange(id, on);
    return true;
  }

  /** Every flag by id, as `StateBody.features` sends it to the console. */
  view(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const f of FEATURES) out[f.id] = this.featureOn(f.id);
    return out;
  }
}
