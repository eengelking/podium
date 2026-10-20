import type { DatabaseSync } from 'node:sqlite';

/** A feature the Admin can turn off for everyone on this server. A later flag adds one entry here. SPEC 8.1. */
export interface FeatureDef {
  id: string;
  name: string;
  description: string;
  /** Whether the flag is on until the Admin changes it. */
  defaultOn: boolean;
}

export const ACTIVITY_FEED = 'activity-feed';
/** Respond from Podium (#206): off until the Admin turns it on. */
export const RESPOND = 'respond';
/** A changed file's diff, opened by the session's owner (#319): off until the Admin turns it on. */
export const FILE_DIFF = 'file-diff';
/** Orchestrator messaging between one person's own reporters (#347, #412): off until the Admin turns it on. */
export const PEER_MESSAGING = 'peer-messaging';
/** The release check (#499): on until the Admin turns it off. Off, the server makes no request to GitHub. */
export const UPDATE_CHECK = 'update-check';

/** Session recording (#353): a session's owner, or an Admin, records what an orchestrator and its agents do. Off until the Admin turns it on, and never on without a token. */
export const SESSION_RECORDING = 'session-recording';

export const FEATURES: readonly FeatureDef[] = [
  {
    id: ACTIVITY_FEED,
    name: 'Agent activity feed',
    description:
      "Shows an agent's recent tool calls and text in its panel while someone watches. Needs the reporter's activityFeed option on the machine as well. Nothing is kept after the panel closes unless the Admin chooses to keep activity in Admin > Server > Data. Off, nothing is captured or kept.",
    defaultOn: true,
  },
  {
    id: RESPOND,
    name: 'Respond from Podium',
    description: 'Lets people answer and message the sessions they own. Each answer is written to the admin log with who sent it.',
    defaultOn: false,
  },
  {
    id: FILE_DIFF,
    name: 'File diff',
    description:
      "Lets the owner of a session, and only the owner, open a changed file's diff in the console. The diff is source code, read from the machine only when asked, with secrets hidden, and never stored. Needs the reporter's fileDiff option on the machine as well.",
    defaultOn: false,
  },
  {
    id: PEER_MESSAGING,
    name: 'Orchestrator messaging',
    description:
      "Lets a person's orchestrators find and message each other, on the machines they choose, through this server. Only between one person's own reporters. Each machine must also turn it on in podium-reporter, and the owner gives each pair the right on My reporters.",
    defaultOn: false,
  },
  {
    id: SESSION_RECORDING,
    name: 'Session recording',
    description:
      "Lets a session's owner, or an Admin, record everything an orchestrator and its agents do, so a run can be replayed to see what happened and why. Needs sign-in on the server. Off by default.",
    defaultOn: false,
  },
  {
    id: UPDATE_CHECK,
    name: 'Release check',
    description: 'Asks GitHub once a day for the latest Podium release and says at the bottom of the wall when a newer one is out. Off, this server makes no request to GitHub.',
    defaultOn: true,
  },
];

export function isFeatureId(id: string): boolean {
  return FEATURES.some((f) => f.id === id);
}

const PREFIX = 'feature.';

function defaultOf(id: string): boolean {
  return FEATURES.find((f) => f.id === id)?.defaultOn ?? true;
}

/**
 * Server-wide feature flags (Admin > Settings > Feature flags): one on/off switch per feature, each with its own default.
 * They live in the settings table with the other Admin settings (`feature.<id>`, '0' when off and '1' when on; unset is
 * the default), so they apply to every browser and survive a restart. `onChange` lets the fleet act on a change and
 * tell open browsers.
 */
export class FeatureFlags {
  constructor(
    private readonly db: DatabaseSync,
    private readonly onChange: (id: string, on: boolean) => void = () => {},
  ) {}

  private get(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value;
  }

  featureOn(id: string): boolean {
    const v = this.get(PREFIX + id);
    if (v === '0') return false;
    if (v === '1') return true;
    return defaultOf(id);
  }

  /** Returns false for an id that is not a known flag. */
  setFeature(id: string, on: boolean): boolean {
    if (!isFeatureId(id)) return false;
    const value = on ? '1' : '0';
    const was = this.get(PREFIX + id);
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(PREFIX + id, value);
    // An unset flag takes its default, so writing the default over nothing is no change.
    if ((was ?? (defaultOf(id) ? '1' : '0')) !== value) this.onChange(id, on);
    return true;
  }

  /** Every flag by id, as `StateBody.features` sends it to the console. */
  view(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const f of FEATURES) out[f.id] = this.featureOn(f.id);
    return out;
  }
}
