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
  /** A person's message is no half round trip and approves nothing (#1034). Absent means an agent's. */
  author?: 'agent' | 'person';
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
  const kept = rows.filter((r) => r.state !== 'declined' && r.state !== 'dropped' && r.author !== 'person');
  let start = 0;
  kept.forEach((r, i) => {
    if (r.approved) start = i;
  });
  let changes = 0;
  for (let i = start + 1; i < kept.length; i++) if (kept[i].fromSession !== kept[i - 1].fromSession) changes++;
  return Math.ceil(changes / 2);
}

/** The part of a message the thread's merge rule reads. */
export interface ShownRow {
  author: 'agent' | 'person';
  text: string;
  sentAt: number;
  toSession: string;
  fromName: string;
}

/** Window in which a person's identical text to the agents of one conversation shows as one message (the thread's merge rule, #1034). */
export const MERGE_MS = 2000;

/**
 * How many messages the thread shows for a conversation's stored rows, in order: a person's text stored once per agent
 * (same author, same text, within `MERGE_MS` of the one before) is one message, as `directMessages` shows it.
 */
export function shownCount(rows: readonly ShownRow[]): number {
  let shown = 0;
  let last: { row: ShownRow; to: Set<string> } | null = null;
  for (const m of rows) {
    if (m.author === 'person' && last && last.row.author === 'person' && last.row.text === m.text && Math.abs(m.sentAt - last.row.sentAt) <= MERGE_MS && last.row.fromName === m.fromName && !last.to.has(m.toSession)) {
      last.to.add(m.toSession);
      continue;
    }
    shown++;
    last = { row: m, to: new Set([m.toSession]) };
  }
  return shown;
}

/** What a paging read throws for a cursor it did not give out (a person or a script made it up). */
export const BAD_CURSOR = 'The cursor is not one this server gave out.';

/** A paging cursor: the time and insertion number of the oldest row of the page, as `<ms>.<seq>`. A page back starts strictly before it, so the row itself need not exist any more. */
export const encodeCursor = (at: number, seq: number): string => `${at}.${seq}`;

/** The time and insertion number a cursor names; throws `BAD_CURSOR` for any other text. */
export function decodeCursor(cursor: string): { at: number; seq: number } {
  const m = /^(\d{1,16})\.(\d{1,16})$/.exec(cursor);
  if (!m) throw new Error(BAD_CURSOR);
  return { at: Number(m[1]), seq: Number(m[2]) };
}

/** A page size kept to a whole number from 1 to 500. */
export const pageSize = (limit: number): number => Math.min(500, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 50)));

/** What an agent is told when it answers a person who wrote to it through Chat (#1034). Shared by every adapter, so they refuse in the same words. */
export const REPLY_WORDS = {
  unseen: (address: string): string => `You cannot see an orchestrator called ${address}. Run podium_peers for the list.`,
  removed: (owner: string, person: string): string => `${owner} removed the link between ${person} and this session, so Podium did not send the answer. ${owner} can open it again.`,
  paused: (person: string): string => `The link between ${person} and this session is paused, so Podium did not send the answer. Try again once the link is resumed.`,
  rate: (n: number, person: string): string => `There have been ${n} answers to ${person} in the last minute, the limit on this link. Wait a minute, then send again.`,
};
