// The feature flags on PostgreSQL (#822): the SQLite store's logic over `PgDb`, one `settings` row per flag.
import { FEATURES, isFeatureId, featureDefault } from '../features.js';
import type { FeatureFlagsApi } from '../types.js';
import type { PgDb } from './conn.js';

const PREFIX = 'feature.';

export const pgFeatureFlags = (db: PgDb): FeatureFlagsApi => {
  const get = async (key: string): Promise<string | undefined> => (await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]))?.value;
  const featureOn = async (id: string): Promise<boolean> => {
    const v = await get(PREFIX + id);
    if (v === '0') return false;
    if (v === '1') return true;
    return featureDefault(id);
  };
  return {
    featureOn,
    async setFeature(id, on) {
      if (!isFeatureId(id)) return false;
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [PREFIX + id, on ? '1' : '0']);
      return true;
    },
    async view() {
      const out: Record<string, boolean> = {};
      for (const f of FEATURES) out[f.id] = await featureOn(f.id);
      return out;
    },
  };
};
