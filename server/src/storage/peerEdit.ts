// What editing and deleting one's own direct message decides (#1269), in one place for every adapter (#822): neither adapter imports the other, so
// the rules they share live here. Nothing in this file touches a database. The adapters read the rows, call `decideChange`, and write what it says.
import type { MessageRow, MessageState, PeerChange } from '../fleet/peerTypes.js';
import { MERGE_MS } from './peerText.js';

/** The states of a message that has been sent to an agent: its receiver's reporter has been handed it (`handed`), has queued it (`queued`) or has taken it (`delivered`). Such a message is locked. */
export const LOCKED_STATES: readonly MessageState[] = ['queued', 'handed', 'delivered'];

/**
 * Whether a message has been sent to an agent, so it can no longer be changed: one in `LOCKED_STATES`, and a `ready` one its owner approved, since the text the owner saw is the text the agent must get and the
 * agent has only not fetched it yet. A `ready` message that needed no approval (its link was already open) is not, until it is handed over. `approval` (waiting for another person to approve), `declined` and
 * `dropped` (it never went) are not.
 */
export const isSentToAgent = (row: Pick<MessageRow, 'state' | 'approved'>): boolean => LOCKED_STATES.includes(row.state) || (row.state === 'ready' && row.approved);

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
 * tombstone; and it, with every row the thread merges with it (same author id, same text, same sender name, another agent, within `MERGE_MS`), has not been sent to an agent (including an approved message the agent has not fetched yet). `pair` is every row of the
 * conversation `row` is in, the row itself included.
 */
export function decideChange(row: MessageRow | null, pair: readonly MessageRow[], author: number): { ok: true; group: MessageRow[] } | Extract<PeerChange, { ok: false }> {
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.author !== 'person' || row.authorId === null || row.authorId !== author) return { ok: false, reason: 'not-yours' };
  if (row.deletedAt !== null) return { ok: false, reason: 'deleted' };
  const group = [row, ...pair.filter((m) => m.id !== row.id && m.deletedAt === null && m.authorId === author && mergesAsOne(row, m))];
  if (group.some((m) => isSentToAgent(m))) return { ok: false, reason: 'locked' };
  return { ok: true, group };
}

/** What a person is told when a message is over the owner's length limit, on a send and on an edit (#1269): one sentence for both, so the two refuse in the same words. */
export const overLimitWords = (length: number, max: number): string => `The message is ${length.toLocaleString('en-US')} characters, over the limit of ${max.toLocaleString('en-US')}. Send a shorter one.`;
