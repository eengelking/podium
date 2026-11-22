// One conversation's summary from its messages, the same in every adapter and with no SQL (#1309). It is built in two parts so a list of conversations needs the rights and the
// limits once for all of them, not once for each: `headOf` names the two ends and the links to look up, then `toSummary` puts the rights read for them into the summary.
import { canSend, type ConversationSummary, type EffectiveRight, type MessageRow } from '../fleet/peerTypes.js';
import { pausedByOf, roundTripsUsed, shownCount } from './peerText.js';

type End = ConversationSummary['a'];

/** The two ends of a conversation, ordered by session id, and the message whose names they carry. */
export interface SummaryHead {
  named: MessageRow;
  a: End;
  b: End;
}

/** The ends of a conversation from its messages in order. The names are those of the newest message an agent wrote; a person's message in a conversation between two agents carries the person's name. */
export function headOf(g: MessageRow[]): SummaryHead {
  const named = [...g].reverse().find((m) => m.author === 'agent') ?? (g.at(-1) as MessageRow);
  const from = { sessionId: named.fromSession, name: named.fromName, machine: named.fromMachine, reporterKey: named.fromKey };
  const to = { sessionId: named.toSession, name: named.toName, machine: named.toMachine, reporterKey: named.toKey };
  const [a, b] = from.sessionId <= to.sessionId ? [from, to] : [to, from];
  return { named, a, b };
}

/** The two directions of the conversation's link, `a` to `b` then `b` to `a`: what `toSummary` needs the rights of. */
export const linksOf = (h: SummaryHead): [[string, string], [string, string]] => [[h.a.reporterKey, h.b.reporterKey], [h.b.reporterKey, h.a.reporterKey]];

/** One conversation's summary, from its messages in order, the rights of its two directions and the most round trips its owner allows. */
export function toSummary(g: MessageRow[], h: SummaryHead, ab: EffectiveRight, ba: EffectiveRight, roundTripsCap: number): ConversationSummary {
  const paused = ab.paused || ba.paused;
  let state: ConversationSummary['state'] = 'active';
  if (g.some((m) => m.state === 'approval')) state = 'waiting';
  else if (paused) state = 'paused';
  return {
    link: h.named.link,
    a: h.a,
    b: h.b,
    owner: h.named.owner,
    ownerId: h.named.ownerId,
    messages: shownCount(g),
    lastAt: (g.at(-1) as MessageRow).sentAt,
    state,
    paused,
    ...(paused ? pausedByOf(ab, ba) : {}),
    aToB: canSend(ab.level),
    bToA: canSend(ba.level),
    roundTrips: { used: roundTripsUsed(g), cap: roundTripsCap },
  };
}

/** The conversations that exist, each pair of sessions once with its two ids in order, from the distinct (sender, receiver) rows an adapter reads (#1309). */
export function pairsOf(rows: readonly { from_session: string; to_session: string }[]): [string, string][] {
  const seen = new Map<string, [string, string]>();
  for (const r of rows) {
    const pair: [string, string] = r.from_session <= r.to_session ? [r.from_session, r.to_session] : [r.to_session, r.from_session];
    seen.set(`${pair[0]}|${pair[1]}`, pair);
  }
  return [...seen.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, pair]) => pair);
}
