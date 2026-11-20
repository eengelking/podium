// What editing and deleting one's own direct message decides (#1269), in one place for every adapter (#822): neither adapter imports the other, so
// the rules they share live here. Nothing in this file touches a database. The adapters read the rows, call `decideChange`, and write what it says.
import type { MessageRow, MessageState, PeerChange } from '../fleet/peerTypes.js';
import { MERGE_MS } from './peerText.js';

/** The states of a message that has been sent to an agent: its receiver's reporter has been handed it (`handed`), has queued it (`queued`) or has taken it (`delivered`). Such a message is locked. */
export const LOCKED_STATES: readonly MessageState[] = ['queued', 'handed', 'delivered'];

/**
 * Whether a message in this state has been sent to an agent, so it can no longer be changed. `approval` (waiting for another person to approve), `ready` (approved, not yet fetched), `declined` and `dropped`
 * (it never went) are not.
 */
export const isSentToAgent = (state: MessageState): boolean => LOCKED_STATES.includes(state);

/** The part of a message the thread's merge rule reads. */
type Mergeable = Pick<MessageRow, 'author' | 'text' | 'sentAt' | 'toSession' | 'fromName'>;

/**
 * Whether two stored rows are one message in the thread: a person's identical text, under the same name, to two different agents of one conversation, within `MERGE_MS`. The same rule as `shownCount`
 * (and `directMessages`, which the thread is built with); `peerEdit.test.ts` checks the two agree. One message to two agents is stored as one row per agent.
 */
export const mergesAsOne = (a: Mergeable, b: Mergeable): boolean =>
  a.author === 'person' && b.author === 'person' && a.text === b.text && Math.abs(a.sentAt - b.sentAt) <= MERGE_MS && a.fromName === b.fromName && a.toSession !== b.toSession;

/**
 * The decision of `editMessage` and `deleteMessage` on the row asked for and the rows of its conversation, the same in every adapter: the refusal, or the rows to change. The checks run in this order: the
 * row exists; it is a person's message whose `authorId` is this person's id (names are never compared, so an agent's message, another person's and one with no id are `not-yours`); it is not already a
 * tombstone; and it, with every row the thread merges with it (same author id, same text, same sender name, another agent, within `MERGE_MS`), has not been sent to an agent. `pair` is every row of the
 * conversation `row` is in, the row itself included.
 */
export function decideChange(row: MessageRow | null, pair: readonly MessageRow[], author: number): { ok: true; group: MessageRow[] } | Extract<PeerChange, { ok: false }> {
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.author !== 'person' || row.authorId === null || row.authorId !== author) return { ok: false, reason: 'not-yours' };
  if (row.deletedAt !== null) return { ok: false, reason: 'deleted' };
  const group = [row, ...pair.filter((m) => m.id !== row.id && m.deletedAt === null && m.authorId === author && mergesAsOne(row, m))];
  if (group.some((m) => isSentToAgent(m.state))) return { ok: false, reason: 'locked' };
  return { ok: true, group };
}
