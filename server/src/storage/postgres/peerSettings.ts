import { type PeerLimits, type PeerServerSettings, PEER_DEFAULTS, KEYS, peerSettingError } from '../settings.js';
import type { PeerSettingsStoreApi } from '../types.js';
import type { PgDb } from './conn.js';

const KEY = 'peer_settings';

/** The Admin's messaging settings, in the settings table as one JSON value (`peer_settings`); unset values take the defaults. */
export class PgPeerSettings implements PeerSettingsStoreApi {
  constructor(private readonly db: PgDb) {}

  async get(): Promise<PeerServerSettings> {
    const row = await this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [KEY]);
    let saved: Record<string, unknown> = {};
    try {
      saved = row ? (JSON.parse(row.value) as Record<string, unknown>) : {};
    } catch {
      saved = {};
    }
    const out = { ...PEER_DEFAULTS };
    for (const k of KEYS) if (peerSettingError(k, saved[k]) === null) out[k] = saved[k] as number;
    return out;
  }

  /** Saves the given values. Every value is checked first, and nothing is saved when one fails. */
  async set(patch: Record<string, unknown>): Promise<{ ok: true; settings: PeerServerSettings } | { ok: false; error: string }> {
    const keys = Object.keys(patch);
    if (!keys.length) return { ok: false, error: 'nothing to change' };
    return this.db.tx(async () => {
      const next = await this.get();
      for (const k of keys) {
        if (!(KEYS as readonly string[]).includes(k)) return { ok: false as const, error: `unknown setting: ${k}` };
        const err = peerSettingError(k as keyof PeerServerSettings, patch[k]);
        if (err) return { ok: false as const, error: err };
        next[k as keyof PeerServerSettings] = patch[k] as number;
      }
      await this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [KEY, JSON.stringify(next)]);
      return { ok: true as const, settings: next };
    });
  }

  async limits(): Promise<PeerLimits> {
    const { roundTrips, perMinute, maxChars } = await this.get();
    return { roundTrips, perMinute, maxChars };
  }

  async retainMs(): Promise<number> {
    return (await this.get()).retainDays * 86_400_000;
  }
}
