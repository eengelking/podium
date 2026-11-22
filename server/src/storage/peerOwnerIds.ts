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

/** The `settings` keys that say an upgrade step's rewrite of name-keyed rows has run. The step writes its key in the same transaction as the rewrite, and a step that finds it does nothing, so a rewrite that committed before its version was recorded (a crash between the two) never runs on rows it has already converted. */
export const PEER_IDS_DONE_KEY = 'upgrade.peer_person_ids_done';
export const CHAT_IDS_DONE_KEY = 'upgrade.chat_person_ids_done';

/** How one stored person's end of a link is rewritten (#1292): `to` for a row written when the person existed (`row time >= since`), `earlier` for a row older than the person. */
export interface EndRewrite { to: string; earlier: string; since: number }

/**
 * The rewrite of one stored person's end, given the people that exist by folded name. The Admin's key (#1251) is not a person's and stays (null, as does anything that is not `person:`). A
 * name-keyed end becomes `person:<id>` for a row written at or after the person was made, and `person:gone:<name>` for an older row, so a newcomer who took a deleted person's name is not
 * handed the links the earlier person left; a name no person has is `person:gone:<name>` for every row (`since` 0). Every `person:<text>` is read as a name here, an all-digit name and one that
 * begins `gone:` included (a person called `gone:x` is `person:<id>`, an unmatched name `gone:x` is `person:gone:gone:x`): the step runs once on name-keyed data (`PEER_IDS_DONE_KEY`), when
 * no key is in the new form yet, so a `person:gone:` key is never already rewritten and a name that begins `gone:` cannot be mistaken for one.
 */
export function personEndRewrite(old: string, people: PersonIndex): EndRewrite | null {
  if (!old.startsWith(PREFIX) || old === ADMIN_PERSON_KEY) return null;
  const name = old.slice(PREFIX.length);
  const gone = `${PREFIX}gone:${name}`;
  const p = people.get(nameKey(name));
  return p === undefined ? { to: gone, earlier: gone, since: 0 } : { to: `${PREFIX}${p.id}`, earlier: gone, since: p.createdAt };
}

/**
 * The id an owner's defaults (`peer_owner_settings`, which has no time column) are kept under, or null to drop the row so the person has the server's defaults (#1292). The row is kept only
 * when it is provably the person's own: the name matches a person, that person owns a row written since they were made (`ownIds`, the `owner_id`s the fills gave), and no row of that name is
 * older than the person (`olderNames`, the folded owners left without an id), which would show an earlier person held the name. A newcomer who took a deleted person's name gets nothing.
 */
export function keepOwnerSettings(name: string, people: PersonIndex, ownIds: ReadonlySet<number>, olderNames: ReadonlySet<string>): number | null {
  const p = people.get(name);
  return p !== undefined && ownIds.has(p.id) && !olderNames.has(name) ? p.id : null;
}

/** A link name (`<a>|<b>`, sorted) with one end renamed from `from` to `to`, sorted again; null when the link does not end in `from`. */
export function renameLinkEnd(link: string, from: string, to: string): string | null {
  if (link.startsWith(`${from}|`)) return linkKey(to, link.slice(from.length + 1));
  if (link.endsWith(`|${from}`)) return linkKey(link.slice(0, -(from.length + 1)), to);
  return null;
}

/** The columns that hold a person's end of a link, by table, with the column that holds the row's own time: each is rewritten by the same map, a row older than the person apart (`personEndRewrite`). */
export const PERSON_END_COLUMNS: readonly { table: string; columns: readonly string[]; at: string }[] = [
  { table: 'peer_rights', columns: ['from_key', 'to_key'], at: 'set_at' },
  { table: 'peer_requests', columns: ['from_key', 'to_key', 'from_session'], at: 'created_at' },
  { table: 'peer_messages', columns: ['from_key', 'to_key', 'from_session', 'to_session'], at: 'sent_at' },
];

/** The tables whose rows carry an `owner` name and get an `owner_id`, with the column that holds the row's own time, which a person must not be newer than (`ownerIdAt`). */
export const OWNED_PEER_TABLES: readonly { table: string; at: string }[] = [
  { table: 'peer_rights', at: 'set_at' },
  { table: 'peer_requests', at: 'created_at' },
  { table: 'peer_messages', at: 'sent_at' },
];

/** The tables whose rows say a person's name was in use, for `keepOwnerSettings`: each holds `owner` and an `owner_id` the fills gave only to a person who existed when the row was written. */
export const OWNER_EVIDENCE_TABLES: readonly string[] = ['sessions', 'reporters', 'peer_rights', 'peer_requests', 'peer_messages'];
