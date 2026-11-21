// The pure part of the step that binds the peer-messaging tables to a person by id (#1284), shared by the three adapters' migrations so they rewrite the same keys the same way. A
// person's end of a link was `person:<folded name>` and is now `person:<people.id>`; a name that matches no person becomes `person:gone:<name>`, which no live person's key can ever equal
// (a live key is `person:` and digits), so a newcomer who takes the name never receives what was kept under it.
import { linkKey, ADMIN_PERSON_KEY } from '../fleet/peerTypes.js';
import { localDay } from '../fleet/rollups.js';
import type { PersonIndex } from './chatRows.js';
import { nameKey } from './rows.js';

const PREFIX = 'person:';

// The guard every owner fill shares (#1284): a person is given a row only if the person existed when the row was written. An older server kept a deleted person's rows as name text, so a
// person who took the name later (a newcomer, `people.created_at` after the row's own time) must not be handed them: the row stays detached, as one whose name matches nobody does. The
// fills write `... AND <row time> >= people.created_at` (both in milliseconds), and a daily row, which has only a day, `day >= personFirstDay(created_at)`.

/** The first `day` (`YYYY-MM-DD`, server-local) a person can own a daily row of: the day the person was made. A row of an earlier day is not theirs. */
export const personFirstDay = (createdAt: number): string => localDay(createdAt);

/** `people.name_lower` to id, for the key rewrite. */
export const idsOf = (people: PersonIndex): Map<string, number> => new Map([...people].map(([name, p]) => [name, p.id]));

/** The `settings` keys that say an upgrade step's rewrite of name-keyed rows has run. The step writes its key in the same transaction as the rewrite, and a step that finds it does nothing, so a rewrite that committed before its version was recorded (a crash between the two) never runs on rows it has already converted. */
export const PEER_IDS_DONE_KEY = 'upgrade.peer_person_ids_done';
export const CHAT_IDS_DONE_KEY = 'upgrade.chat_person_ids_done';

/**
 * The key one stored person's end takes, given the people that exist by folded name. The Admin's key (#1251) is not a person's and stays. A name-keyed end becomes `person:<id>` (every old-form
 * key, an all-digit name included), or `person:gone:<name>` when no person has the name. A key already in the new form (`person:gone:<name>`) stays. A key `person:<digits>` is read as a name here,
 * so the step that calls this must run once on name-keyed data; it does, by `PEER_IDS_DONE_KEY`.
 */
export function personEndKey(old: string, ids: ReadonlyMap<string, number>): string {
  if (!old.startsWith(PREFIX) || old === ADMIN_PERSON_KEY || old.startsWith(`${PREFIX}gone:`)) return old;
  const name = old.slice(PREFIX.length);
  const id = ids.get(nameKey(name));
  return id === undefined ? `${PREFIX}gone:${name}` : `${PREFIX}${id}`;
}

/** A link name (`<a>|<b>`, sorted) with one end renamed from `from` to `to`, sorted again; null when the link does not end in `from`. */
export function renameLinkEnd(link: string, from: string, to: string): string | null {
  if (link.startsWith(`${from}|`)) return linkKey(to, link.slice(from.length + 1));
  if (link.endsWith(`|${from}`)) return linkKey(link.slice(0, -(from.length + 1)), to);
  return null;
}

/** The columns that hold a person's end of a link, by table: each is rewritten by the same map. */
export const PERSON_END_COLUMNS: readonly { table: string; columns: readonly string[] }[] = [
  { table: 'peer_rights', columns: ['from_key', 'to_key'] },
  { table: 'peer_requests', columns: ['from_key', 'to_key', 'from_session'] },
  { table: 'peer_messages', columns: ['from_key', 'to_key', 'from_session', 'to_session'] },
];

/** The tables whose rows carry an `owner` name and get an `owner_id`, with the column that holds the row's own time, which a person must not be newer than (`ownerIdAt`). */
export const OWNED_PEER_TABLES: readonly { table: string; at: string }[] = [
  { table: 'peer_rights', at: 'set_at' },
  { table: 'peer_requests', at: 'created_at' },
  { table: 'peer_messages', at: 'sent_at' },
];
