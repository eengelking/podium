// How many conversations each person takes part in (#1046), from one grouped read of `peer_messages` with no text in it. The same code backs every
// adapter, so a person's count cannot differ between them. It must agree with `ownerConversations(owner).length`: a person is in a conversation they own
// and in one they started with another person's agent (`person:<id>` is one of its two ends), and a conversation is hidden only when every row is.
import { personKeyOf } from '../fleet/peerTypes.js';

/** One row of the grouped read each adapter runs, one row per owner and direction of a pair and never a message: `SELECT owner_id, from_session, to_session, MIN(CASE WHEN hidden_at IS NULL THEN 0 ELSE 1 END) AS all_hidden FROM peer_messages GROUP BY owner_id, from_session, to_session`. The owner is the person's `people.id` (#1284), null for a row whose owner matched no person. */
export interface ConversationGroupRow {
  owner_id: number | null;
  from_session: string;
  to_session: string;
  all_hidden: number;
}

const ordered = (x: string, y: string): string => (x <= y ? `${x}|${y}` : `${y}|${x}`);

/** The shown (not hidden) conversations of each of the people with these ids, keyed by the id. Like `ownerConversations`, a person's view of a pair is only the rows they own or are an end of, and it is hidden when every one of those rows is. */
export function countConversations(rows: ConversationGroupRow[], ownerIds: number[]): Record<number, number> {
  const pairs = new Map<string, { ownerId: number | null; from: string; to: string; hidden: boolean }[]>();
  for (const r of rows) {
    const pair = ordered(r.from_session, r.to_session);
    const g = pairs.get(pair) ?? [];
    g.push({ ownerId: r.owner_id === null ? null : Number(r.owner_id), from: r.from_session, to: r.to_session, hidden: Number(r.all_hidden) === 1 });
    pairs.set(pair, g);
  }
  const out: Record<number, number> = {};
  for (const id of ownerIds) {
    const me = personKeyOf(id);
    let n = 0;
    for (const g of pairs.values()) {
      const mine = g.filter((x) => x.ownerId === id || x.from === me || x.to === me);
      if (mine.length > 0 && mine.some((x) => !x.hidden)) n++;
    }
    out[id] = n;
  }
  return out;
}
