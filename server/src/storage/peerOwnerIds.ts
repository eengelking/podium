// The pure part of the step that binds the peer-messaging tables to a person by id (#1284), shared by the three adapters' migrations so they rewrite the same keys the same way. A
// person's end of a link was `person:<folded name>` and is now `person:<people.id>`; a name that matches no person becomes `person:gone:<name>`, which no live person's key can ever equal
// (a live key is `person:` and digits), so a newcomer who takes the name never receives what was kept under it.
import { linkKey, ADMIN_PERSON_KEY } from '../fleet/peerTypes.js';
import { nameKey } from './rows.js';

const PREFIX = 'person:';

/** The key one stored person's end takes, given the people that exist by folded name. The Admin's key (#1251) is not a person's and stays. */
export function personEndKey(old: string, ids: ReadonlyMap<string, number>): string {
  if (!old.startsWith(PREFIX) || old === ADMIN_PERSON_KEY) return old;
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

/** The tables whose rows carry an `owner` name and get an `owner_id`. */
export const OWNED_PEER_TABLES: readonly string[] = ['peer_rights', 'peer_requests', 'peer_messages'];
