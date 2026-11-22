// What every adapter's rights store shares and holds no SQL (#1309): an owner's defaults as the stored row gives them, who may take part in a link, and what a link
// reaches. `effectiveOf` is the one rule for "what can `from` do to `to`", worked out from rows the adapter has already read, so the same rule serves one link and a
// thousand of them and cannot differ between adapters. Each adapter reads the rows: the reporters, the owners' defaults and the rights, in one statement each for any number of links.
import { OWNER_DEFAULTS, isPersonKey, type EffectiveRight, type OwnerDefaults, type ReporterRef, type RightRow } from '../fleet/peerTypes.js';
import { PEER_LIMIT_KEYS, peerSettingError, type PeerLimits } from './settings.js';

export const ON_REQUEST: readonly OwnerDefaults['onRequest'][] = ['ask', 'allow', 'decline'];
export const NEW_SEND: readonly OwnerDefaults['newSend'][] = ['ask', 'send'];

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An owner's row of `peer_owner_settings`. */
export interface DbDefaults {
  trust: number;
  on_request: string;
  new_send: string;
  limits_json: string | null;
}

/** An owner's defaults from the stored row, or the built-in ones for an owner with none. A saved limit that is not valid is left out. */
export function toDefaults(r: DbDefaults | undefined): OwnerDefaults {
  if (!r) return { ...OWNER_DEFAULTS, limits: {} };
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(r.limits_json ?? '{}');
    if (isObj(parsed)) saved = parsed;
  } catch {
    saved = {};
  }
  const limits: Partial<PeerLimits> = {};
  for (const k of PEER_LIMIT_KEYS) if (peerSettingError(k, saved[k]) === null) limits[k] = saved[k] as number;
  return {
    trust: r.trust === 1,
    onRequest: ON_REQUEST.find((v) => v === r.on_request) ?? OWNER_DEFAULTS.onRequest,
    newSend: NEW_SEND.find((v) => v === r.new_send) ?? OWNER_DEFAULTS.newSend,
    limits,
  };
}

/** The limits an owner works under: each of theirs, never above the Admin's. */
export const limitsOf = (own: Partial<PeerLimits>, server: PeerLimits): PeerLimits => ({
  roundTrips: Math.min(server.roundTrips, own.roundTrips ?? server.roundTrips),
  perMinute: Math.min(server.perMinute, own.perMinute ?? server.perMinute),
  maxChars: Math.min(server.maxChars, own.maxChars ?? server.maxChars),
});

export type Owned = ReporterRef & { owner: string; ownerId: number };

/** A reporter that can take part: owned by a person (it has their `people.id`), not by no one, and not on the admin secret. A reporter whose person was deleted has no id and takes no part. */
export const eligible = (r: ReporterRef): r is Owned => !r.adminSecret && r.owner !== null && r.ownerId !== null;

/** Who paused a stored right, for the answers that carry it. */
const pauser = (r: RightRow | null | undefined): Pick<RightRow, 'pausedBy' | 'pausedByAdmin'> => (r?.paused ? { ...(r.pausedBy ? { pausedBy: r.pausedBy } : {}), ...(r.pausedByAdmin ? { pausedByAdmin: r.pausedByAdmin } : {}) } : {});

/** The rows `effectiveOf` reads, already read: the stored right of a direction, a reporter by key, and whether an owner trusts their own reporters. */
export interface EffectiveRows {
  right(from: string, to: string): RightRow | undefined;
  reporter(key: string): ReporterRef | undefined;
  trusts(ownerId: number): boolean;
}

/** The owners whose trust `effectiveOf` reads for these links: the one both reporters of a link share. A link that is a person's, or that joins reporters that cannot, reads none. */
export function trustOwners(links: readonly (readonly [string, string])[], reporter: (key: string) => ReporterRef | undefined): number[] {
  const owners = new Set<number>();
  for (const [from, to] of links) {
    const ra = isPersonKey(from) ? undefined : reporter(from);
    const rb = from === to ? ra : reporter(to);
    if (ra && rb && eligible(ra) && eligible(rb) && ra.ownerId === rb.ownerId) owners.add(ra.ownerId);
  }
  return [...owners];
}

/** What `from` can do to `to` now: the stored right, or Send when the owner trusts their own reporters. */
export function effectiveOf(from: string, to: string, rows: EffectiveRows): EffectiveRight {
  // A person's link to another person's agent (#1034) has no Trust and no second owner: the row is the whole answer.
  if (isPersonKey(from)) {
    const link = rows.right(from, to);
    return { level: link?.level ?? 'none', paused: link?.paused ?? false, ...pauser(link) };
  }
  // Both reporters must exist, belong to a person, and be the same person's; any other pair has no right.
  const ra = rows.reporter(from);
  const rb = from === to ? ra : rows.reporter(to);
  if (!ra || !rb || !eligible(ra) || !eligible(rb) || ra.ownerId !== rb.ownerId) return { level: 'none', paused: false };
  const had = rows.right(from, to);
  return { level: rows.trusts(ra.ownerId) ? 'send' : (had?.level ?? 'none'), paused: had?.paused ?? false, ...pauser(had) };
}
