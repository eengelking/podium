// Reading `@` mentions out of a Chat message (#1034). Pure. A mention is `@name@location` (one agent or person; `location` is a machine, or
// `console` for a person) with an optional `#id` to tell same-named agents apart, `@group`, `@everyone`, or a plain `@Name` the server
// resolves when only one agent or person has that name. An address in the middle of a word (an email) is not a mention.

export type ParsedMention =
  | { kind: 'address'; name: string; location: string; id: string | null; typed: string }
  | { kind: 'plain'; name: string; typed: string }
  | { kind: 'group'; typed: 'group' }
  | { kind: 'everyone'; typed: 'everyone' };

const WORD = '[A-Za-z0-9._-]+';
/** An @ that does not follow a word character or another @: the start of a mention. */
const MENTION = new RegExp(`(?<![\\w.@-])@(${WORD})(?:@(${WORD})(?:#([A-Za-z0-9_-]+))?)?(?![\\w@])`, 'g');

/** A name or location without the full stop or dash a sentence ends on. */
const trimEnd = (s: string): string => {
  let end = s.length;
  while (end > 0 && (s[end - 1] === '.' || s[end - 1] === '-')) end--;
  return s.slice(0, end);
};

export function parseMentions(text: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  const seen = new Set<string>();
  const add = (m: ParsedMention): void => {
    const key = m.typed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };
  for (const hit of text.matchAll(MENTION)) {
    const name = trimEnd(hit[1] ?? '');
    const where = hit[2] === undefined ? null : trimEnd(hit[2]);
    if (!name) continue;
    if (where === null) {
      const word = name.toLowerCase();
      if (word === 'group') add({ kind: 'group', typed: 'group' });
      else if (word === 'everyone') add({ kind: 'everyone', typed: 'everyone' });
      else add({ kind: 'plain', name, typed: name });
    } else if (where) {
      const id = hit[3] === undefined ? null : trimEnd(hit[3]) || null;
      add({ kind: 'address', name, location: where, id, typed: `${name}@${where}${id ? `#${id}` : ''}` });
    }
  }
  return out;
}
