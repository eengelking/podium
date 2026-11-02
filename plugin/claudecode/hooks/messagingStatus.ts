/**
 * What `/podium` says about orchestrator messaging and how the reporter signs in (#825). Everything here is a fact the mod
 * already holds, so the lines reveal no token and no secret. The rule for who takes part is SPEC 5.3 "When the mod takes
 * part"; this only says which part of it failed.
 */

export interface MessagingFacts {
  /** The `peers` option, as the mod read it. */
  option: boolean;
  /** Whether a person's client is on the session (false for a `claude -p` run). */
  interactive: boolean;
  /** The surface the session started on, or null. */
  surface: string | null;
  /** What the last reply said about taking part; meaningless until `reported`. */
  serverSays: boolean;
  /** Whether the session reports as a person: a per-person token with a userName, or a reporter config file. */
  signedIn: boolean;
  /** Whether Podium has answered a report from this session. */
  reported: boolean;
  ended: boolean;
}

/** The options that are switches. A value of another type for one of these is a mistake `/podium` names. */
const BOOLEAN_OPTIONS = ['showStatus', 'explainFailures', 'fullPrompts', 'activityFeed', 'activityOutput', 'fileDiff', 'fileDiffPreload', 'peers', 'sessionRecording'];

/**
 * The cause of messaging being off, in the order the mod can know it, in plain words; null when it is on. The server's
 * flag and the admin secret look the same from here (Podium says no), so that answer names both.
 */
export function messagingOffReason(f: MessagingFacts): string | null {
  if (f.ended) return 'the session has ended';
  if (!f.option) return "the peers option is off on this machine: turn it on in podium-reporter's settings";
  if (!f.interactive) return 'the session is not interactive (a `claude -p` run has no client on it), so it never takes part';
  if (!f.signedIn) return "there is no per-person token with a userName, or reporter config file: messaging is only between one person's own reporters, so set both";
  if (!f.reported) return 'the session has not reported yet: send it a prompt';
  if (!f.serverSays) return "Podium's messaging flag is off (Admin > Settings), or this reporter signs in with the admin secret, which belongs to no person";
  return null;
}

/** The `Messaging:` line of `/podium`: the verdict, then each fact behind it. */
export function messagingLine(f: MessagingFacts): string {
  const why = messagingOffReason(f);
  const says = !f.reported ? 'nothing yet' : f.serverSays ? 'takes part' : 'does not take part';
  const facts = `peers option: ${f.option ? 'on' : 'off'}; interactive: ${f.interactive ? 'yes' : 'no'} (started on ${f.surface ?? 'no surface'}); Podium says: ${says}`;
  return `Messaging: ${why === null ? 'on' : `off, because ${why}`}. ${facts}`;
}

/** The text of a value for a message: short, and never a whole object. */
function describeValue(v: unknown): string {
  // Only "true" or "false" is echoed: any other text could be a token pasted into the wrong field.
  if (typeof v === 'string') return /^(true|false)$/i.test(v.trim()) ? JSON.stringify(v.trim()) : 'a text';
  if (Array.isArray(v)) return 'a list';
  if (typeof v === 'object') return 'an object';
  return String(v);
}

/** Each switch option whose value is set but is not true or false, with what the mod got. Unset is not a mistake. */
export function nonBooleanOptions(o: Record<string, unknown>): { name: string; got: string }[] {
  return BOOLEAN_OPTIONS.filter((name) => o[name] !== undefined && o[name] !== null && typeof o[name] !== 'boolean').map((name) => ({ name, got: describeValue(o[name]) }));
}

/** The `Sign-in:` line: a plain token or a reporter config file (mTLS), and which file. */
export function connectionLine(c: { configPath: string | null; tokenSet: boolean }): string {
  if (c.configPath) return `Sign-in: reporter config file ${c.configPath} (mTLS)`;
  if (c.tokenSet) return 'Sign-in: a plain token (not a reporter config file)';
  return 'Sign-in: none (no token and no reporter config file)';
}

/**
 * The `Option problem:` line for one mistyped switch. The mod does not read `"true"` as true: a consent option such as
 * `peers` or `sessionRecording` turned on by a stray text is worse than one left off with a line that says so (#825).
 */
export function optionProblem(b: { name: string; got: string }): string {
  return `Option problem: ${b.name} must be true or false, but the mod got ${b.got}, so it ignores it and uses the default. Fix it in podium-reporter's settings.`;
}
