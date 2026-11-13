// What a harness sent a reporter (#724), kept the same way by every harness's reporter: which hooks ran and which fields their events carried,
// as counts per session. The server compares one version of a harness with the one before it, so a hook that stopped running or a field that
// went missing after an update is found by the Admin, not by a person. Names and counts only: never a value, an argument, a path or text.
// Pure: no `$` here.

/** The most names one session reports, as the server takes (SPEC 7.7). */
export const MAX_SIGNAL_NAMES = 64;

/** Signal name to the number of times it was seen: `hook:<hook>` for a hook that ran, `field:<hook>.<field>` for a field its event carried. */
export type Signals = Record<string, number>;

const hasValue = (event: unknown, field: string): boolean => {
  if (event === null || typeof event !== 'object') return false;
  const v = (event as Record<string, unknown>)[field];
  return v !== undefined && v !== null;
};

/**
 * Counts one run of `hook`, and one for each of `fields` the event carried with a value, in `into` (changed in place). A name that is not there yet
 * is added only while there are fewer than MAX_SIGNAL_NAMES names. `fields` is the closed list of fields the reporter reads from this hook's event,
 * so a field is counted because the reporter relies on it, never because the event happened to have it.
 */
export function bumpSignals(into: Signals, hook: string, event: unknown, fields: readonly string[] = []): Signals {
  const add = (name: string): void => {
    if (!Object.hasOwn(into, name) && Object.keys(into).length >= MAX_SIGNAL_NAMES) return;
    into[name] = (Object.hasOwn(into, name) ? into[name]! : 0) + 1;
  };
  add(`hook:${hook}`);
  for (const f of fields) if (hasValue(event, f)) add(`field:${hook}.${f}`);
  return into;
}

/** What a report sends: a copy, with each name clipped by `clipName`. */
export function reportSignals(into: Signals, clipName: (name: string) => string): Signals {
  const out: Signals = {};
  for (const [name, n] of Object.entries(into)) out[clipName(name)] = (out[clipName(name)] ?? 0) + n;
  return out;
}
