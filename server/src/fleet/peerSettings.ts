import type { DatabaseSync } from 'node:sqlite';
import { PEER_LIMITS } from './protocol.js';

/** The limits on every link (#347, SPEC 7.7). The Admin sets them in Admin > Settings; an owner can only be stricter. */
export interface PeerLimits {
  /** Round trips in one conversation before the owner approves the next message. */
  roundTrips: number;
  /** Messages per minute on one link. */
  perMinute: number;
  /** The longest message, in characters. Over it, a message is refused, never cut. */
  maxChars: number;
}

/** The Admin's messaging settings: the limits, and how long a conversation is kept after its last message. */
export interface PeerServerSettings extends PeerLimits {
  retainDays: number;
}

export const PEER_DEFAULTS: PeerServerSettings = { roundTrips: 10, perMinute: 6, maxChars: 20_000, retainDays: 30 };

/** The whole numbers each setting takes. An owner's stricter limit takes the same ranges, up to the Admin's value. */
export const PEER_RANGES: Record<keyof PeerServerSettings, { min: number; max: number }> = {
  roundTrips: { min: 1, max: 100 },
  perMinute: { min: 1, max: 60 },
  maxChars: { min: 1, max: PEER_LIMITS.message },
  retainDays: { min: 1, max: 365 },
};

export const PEER_LIMIT_KEYS: readonly (keyof PeerLimits)[] = ['roundTrips', 'perMinute', 'maxChars'];
const KEYS: readonly (keyof PeerServerSettings)[] = [...PEER_LIMIT_KEYS, 'retainDays'];

/** The words a refusal names a setting by, as Admin > Settings labels it. */
const LABELS: Record<keyof PeerServerSettings, string> = {
  roundTrips: 'Round trips',
  perMinute: 'Messages per minute',
  maxChars: 'Longest message',
  retainDays: 'Days kept',
};

/** Checks one setting's value against its range, and an upper bound when one applies. Returns the error, or null. */
export function peerSettingError(key: keyof PeerServerSettings, v: unknown, max = PEER_RANGES[key].max): string | null {
  const { min } = PEER_RANGES[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return `${LABELS[key]} must be a whole number from ${min} to ${max}`;
  return null;
}

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
