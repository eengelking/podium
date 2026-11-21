// Who an @ in a Direct Message names (#1282). Pure. A conversation (#1278) has members, each a person or one of the writer's own agents, and an @ here can only mean one of them:
// a message with no @ is for everyone in it, a message that names members is for those members, and a name that is not a member is refused with words, so nothing is handed to
// an agent the person did not mean. The same `@name@location` reading as a channel's (`chatMentions.ts`), against the members and not the whole server.
import { nameKey } from '../storage/rows.js';
import type { ConversationMemberKind, ConversationTargetInput } from '../storage/types.js';
import { parseMentions, type ParsedMention } from './chatMentions.js';

/** A member the way an @ reads it. `machine` and `agentId` are known for an agent that is running, and null for a person and for an agent that has ended. */
export interface TargetMember {
  kind: ConversationMemberKind;
  ref: string;
  name: string;
  machine: string | null;
  agentId: number | null;
}

export type TargetResult = { ok: true; targets: ConversationTargetInput[] | null } | { ok: false; error: string };

/** Code is not addressed: an @ inside a code span or block is a package name or a path, never a person. A scoped name such as `@types/node` is text too. */
function scrub(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/(^|[^\w.@-])@[A-Za-z0-9._-]+\//g, '$1 ');
}

const label = (m: TargetMember, twins: boolean): string => (m.kind === 'person' ? `${m.name}@console` : `${m.name}@${m.machine ?? 'unknown'}${twins && m.agentId !== null ? `#${m.agentId}` : ''}`);

function tell(name: string, hits: TargetMember[]): string {
  const keys = hits.map((h) => label(h, false));
  const twins = new Set(keys).size !== keys.length;
  return `More than one member is called ${name}, so Podium cannot tell which you mean. Address one as ${hits.map((h) => label(h, twins)).join(', ')}.`;
}

function candidates(m: ParsedMention, members: TargetMember[]): TargetMember[] {
  if (m.kind === 'plain') return members.filter((x) => nameKey(x.name) === nameKey(m.name));
  if (m.kind !== 'address') return [];
  if (nameKey(m.location) === 'console') return members.filter((x) => x.kind === 'person' && nameKey(x.name) === nameKey(m.name));
  const here = members.filter((x) => x.kind === 'agent' && nameKey(x.name) === nameKey(m.name) && (x.machine === null || nameKey(x.machine) === nameKey(m.location)));
  const id = m.id;
  if (!id) return here;
  // A numeric `#id` is an agent id and nothing else (#1284); anything else is the start of a session id.
  return here.filter((x) => (/^\d+$/.test(id) ? String(x.agentId) === id : x.ref.toLowerCase().startsWith(id.toLowerCase())));
}

/**
 * The members `text` is for. `members` are the people and agents in the conversation now, `author` is who writes. No @ gives `targets: null` (for everyone). An @ of the author, and a
 * plain `@word` that names nobody in the conversation, are only text. An `@name@location` that names nobody in it, an `@group` and an `@everyone` are refused, in words.
 */
export function resolveTargets(text: string, members: TargetMember[], author: { kind: ConversationMemberKind; ref: string }): TargetResult {
  const out: ConversationTargetInput[] = [];
  const seen = new Set<string>();
  // A name with a space in it (a person called Maya Kim, a session titled by its model) cannot be read by the word-by-word reading below, and the @ list types it whole. So the whole address of
  // such a member is looked for first, and taken out of the text, so a message that names one is never read as one for everyone.
  let rest = scrub(text);
  for (const x of members) {
    if (x.kind === author.kind && x.ref === author.ref) continue;
    const address = x.kind === 'person' ? `${x.name}@console` : x.machine === null ? null : `${x.name}@${x.machine}`;
    if (address === null || /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(address)) continue;
    const found = new RegExp(String.raw`(?<![\w.@-])@${address.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}(?![\w@])`, 'gi');
    if (!found.test(rest)) continue;
    rest = rest.replaceAll(found, ' ');
    const key = `${x.kind}:${x.ref}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind: x.kind, ref: x.ref, name: x.name, named: true });
    }
  }
  for (const m of parseMentions(rest)) {
    if (m.kind === 'group' || m.kind === 'everyone') return { ok: false, error: '@group and @everyone are not available in a Direct Message, so nothing was sent. Address a member as name@location, or remove the @.' };
    const hits = candidates(m, members).filter((x) => !(x.kind === author.kind && x.ref === author.ref));
    if (hits.length === 0) {
      // A plain word that names nobody is only text; a full address that names nobody is a mistake worth stopping for.
      if (m.kind === 'address' && !candidates(m, members).length) return { ok: false, error: `${m.typed} is not in this conversation, so nothing was sent. Add it from Members, or remove the @.` };
      continue;
    }
    if (hits.length > 1) return { ok: false, error: tell(m.kind === 'plain' ? m.name : `${m.name}@${m.location}`, hits) };
    const hit = hits[0]!;
    const key = `${hit.kind}:${hit.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: hit.kind, ref: hit.ref, name: hit.name, named: true });
  }
  return { ok: true, targets: out.length ? out : null };
}
