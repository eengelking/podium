import type { DatabaseSync } from 'node:sqlite';
import { PEER_LIMITS } from '../../fleet/protocol.js';
import { type PeerLimits, type PeerServerSettings, PEER_DEFAULTS, KEYS, peerSettingError } from '../settings.js';

const KEY = 'peer_settings';

/** The Admin's messaging settings, in the settings table as one JSON value (`peer_settings`); unset values take the defaults. */
export class PeerSettings {
  constructor(private readonly db: DatabaseSync) {}

  get(): PeerServerSettings {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
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
  set(patch: Record<string, unknown>): { ok: true; settings: PeerServerSettings } | { ok: false; error: string } {
    const keys = Object.keys(patch);
    if (!keys.length) return { ok: false, error: 'nothing to change' };
    const next = this.get();
    for (const k of keys) {
      if (!(KEYS as readonly string[]).includes(k)) return { ok: false, error: `unknown setting: ${k}` };
      const err = peerSettingError(k as keyof PeerServerSettings, patch[k]);
      if (err) return { ok: false, error: err };
      next[k as keyof PeerServerSettings] = patch[k] as number;
    }
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(next));
    return { ok: true, settings: next };
  }

  limits(): PeerLimits {
    const { roundTrips, perMinute, maxChars } = this.get();
    return { roundTrips, perMinute, maxChars };
  }

  retainMs(): number {
    return this.get().retainDays * 86_400_000;
  }
}
