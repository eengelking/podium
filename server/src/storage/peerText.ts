// Pure helpers both messaging stores share (#822): neither adapter imports the other, so what they have in common lives here.
// Nothing in this file touches a database.
import type { MessageState } from '../fleet/peerTypes.js';

/** Notices kept for one orchestrator; the oldest goes first. */
export const MAX_NOTICES = 20;
/** The part of a message round trips are counted from. */
export interface TripRow {
  fromSession: string;
  state: MessageState;
  approved: boolean;
}

/**
 * Text with every control character other than a line break or a tab replaced by a space. A loop over char codes, not
 * a regex with control characters in it (SonarCloud typescript:S6324).
 */
export function cleanPeerText(raw: string): string {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    out.push((c < 32 && c !== 9 && c !== 10) || c === 127 ? ' ' : raw[i]);
  }
  return out.join('');
}

/**
 * Round trips in a conversation since its owner last approved a message: the stored messages that were not declined
 * or dropped, from the newest approved one on (all of them when none was), in order; each change of direction is half
 * a round trip, rounded up.
 */
export function roundTripsUsed(rows: readonly TripRow[]): number {
  const kept = rows.filter((r) => r.state !== 'declined' && r.state !== 'dropped');
  let start = 0;
  kept.forEach((r, i) => {
    if (r.approved) start = i;
  });
  let changes = 0;
  for (let i = start + 1; i < kept.length; i++) if (kept[i].fromSession !== kept[i - 1].fromSession) changes++;
  return Math.ceil(changes / 2);
}
