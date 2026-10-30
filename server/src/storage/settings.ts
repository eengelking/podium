// What the Admin's settings accept (#313): limits, defaults, ranges and the checks on a value, the same for every adapter.
import { ACTIVITY_UNIT_MS, type ActivityHistorySettings, ACTIVITY_HISTORY_POLICIES, ACTIVITY_HISTORY_RANGES, ACTIVITY_HISTORY_UNITS } from '../fleet/activityHistoryTypes.js';
import { PEER_LIMITS } from '../fleet/protocol.js';

export const FIELDS = ['policy', 'n', 'unit', 'capGb'] as const;

/** The number of milliseconds a stored entry is kept under policy `after`. */
export function activityPeriodMs(s: ActivityHistorySettings): number {
  return s.n * ACTIVITY_UNIT_MS[s.unit];
}

export const isWhole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** The error for one field's value, or null when it is acceptable. */
export function activityHistoryFieldError(field: (typeof FIELDS)[number], v: unknown): string | null {
  switch (field) {
    case 'policy':
      return (ACTIVITY_HISTORY_POLICIES as readonly unknown[]).includes(v) ? null : `Keep must be one of ${ACTIVITY_HISTORY_POLICIES.join(', ')}`;
    case 'unit':
      return (ACTIVITY_HISTORY_UNITS as readonly unknown[]).includes(v) ? null : `The unit must be one of ${ACTIVITY_HISTORY_UNITS.join(', ')}`;
    case 'n': {
      const { min, max } = ACTIVITY_HISTORY_RANGES.n;
      return isWhole(v, min, max) ? null : `The period must be a whole number from ${min} to ${max}`;
    }
    case 'capGb': {
      const { min, max } = ACTIVITY_HISTORY_RANGES.capGb;
      return v === null || isWhole(v, min, max) ? null : `The size cap must be a whole number of gigabytes from ${min} to ${max}, or none`;
    }
  }
}

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

export const KEYS: readonly (keyof PeerServerSettings)[] = [...PEER_LIMIT_KEYS, 'retainDays'];

/** The words a refusal names a setting by, as Admin > Settings labels it. */
export const LABELS: Record<keyof PeerServerSettings, string> = {
  roundTrips: 'Round trips',
  perMinute: 'Messages per minute',
  maxChars: 'Longest message',
  retainDays: 'Keep conversations',
};

/** Checks one setting's value against its range, and an upper bound when one applies. Returns the error, or null. */
export function peerSettingError(key: keyof PeerServerSettings, v: unknown, max = PEER_RANGES[key].max): string | null {
  const { min } = PEER_RANGES[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return `${LABELS[key]} must be a whole number from ${min} to ${max}`;
  return null;
}
