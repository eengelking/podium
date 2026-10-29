// The Admin's notices and feature flags (#313): the tables and their ids, which every adapter and the app read the same way.

/** An informational notice the wall can show at the bottom. A later notice adds one entry here. SPEC 8.1. */
export interface NoticeDef {
  id: string;
  name: string;
  description: string;
}

export const NOTICES: readonly NoticeDef[] = [
  {
    id: 'background-sessions',
    name: 'Background sessions',
    description: 'Says how many sessions nobody is attached to are set aside, with a link to show them.',
  },
];

export function isNoticeId(id: string): boolean {
  return NOTICES.some((n) => n.id === id);
}

/** A feature the Admin can turn off for everyone on this server. A later flag adds one entry here. SPEC 8.1. */
export interface FeatureDef {
  id: string;
  name: string;
  description: string;
  /** Whether the flag is on until the Admin changes it. */
  defaultOn: boolean;
}

export const ACTIVITY_FEED = 'activity-feed';

/** A Bash command's output in the Activity feed (#431): off until the Admin turns it on. Needs `activity-feed` on as well. */
export const ACTIVITY_OUTPUT = 'activity-output';

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
    id: ACTIVITY_OUTPUT,
    name: 'Bash output in the activity feed',
    description:
      "Lets a person open a Bash row in the Activity feed to see what the command printed and how it exited. Needs the Agent activity feed on, and the reporter's activityOutput option on the machine as well. Output is held in memory while the panel is open and is never stored. Off, no output is captured or sent.",
    defaultOn: false,
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

export function featureDefault(id: string): boolean {
  return FEATURES.find((f) => f.id === id)?.defaultOn ?? true;
}
