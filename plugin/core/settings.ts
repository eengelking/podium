// Where a reporter may read its security-relevant settings from (#856). Pure: the environment and the file's text are passed in.
//
// A project's own config (OpenCode's `opencode.json`, a repo's `.opencode/`) is part of a clone, so whoever wrote the repo wrote
// it. It must not be able to point the reporter at another server (the token goes along), name the person, or switch on answering
// or recording. The server URL, the token, the user name and every consent option therefore come only from `PODIUM_*`
// environment variables and from `~/.podium/config.env`, never from project config. Each reporter calls this once; none keeps its own copy.

import { trimTrailingSlashes } from './machine.ts';

/** The folder under the home directory that holds the person's own Podium files. */
export const PODIUM_DIR_NAME = '.podium';
/** The settings file in that folder, `KEY=value` lines. */
export const SETTINGS_FILE = 'config.env';

/** The consent options, as the `PODIUM_*` variables that turn them on. Each is off unless set to exactly `true`. */
export const CONSENT_VARS = {
  respond: 'PODIUM_RESPOND',
  peers: 'PODIUM_PEERS',
  sessionRecording: 'PODIUM_SESSION_RECORDING',
  fullPrompts: 'PODIUM_FULL_PROMPTS',
  activityFeed: 'PODIUM_ACTIVITY_FEED',
  activityOutput: 'PODIUM_ACTIVITY_OUTPUT',
  fileDiff: 'PODIUM_FILE_DIFF',
} as const;

export type ConsentName = keyof typeof CONSENT_VARS;
export type Consent = Record<ConsentName, boolean>;

export interface TrustedSettings {
  serverUrl: string;
  token: string;
  userName: string | null;
  /** PODIUM_IDLE_SECONDS as text; the reporter parses it. */
  idleSeconds: string;
  /** The only source of a consent decision. A reporter that answers or records must read it here, never from a project option. */
  consent: Consent;
}

type Env = Readonly<Record<string, string | undefined>>;

/** `KEY=value` lines: comments and blank lines skipped, one pair of quotes taken off. Later lines win. */
export function parseSettingsFile(text: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    out[key] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

/** Where `config.env` lives; null when the home directory is not an absolute path. */
export function settingsPath(home: string | undefined): string | null {
  const h = trimTrailingSlashes((home ?? '').trim());
  return /^(\/|[A-Za-z]:[\\/])/.test(h) ? `${h}/${PODIUM_DIR_NAME}/${SETTINGS_FILE}` : null;
}

/** Whether a file mode lets anyone but the owner read it. A token file should be 0600. */
export function tooOpen(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

/** The settings a reporter may act on: the environment first, then the file. Project config is not an input. */
export function trustedSettings(env: Env, fileText: string | null | undefined): TrustedSettings {
  const file = parseSettingsFile(fileText);
  const get = (k: string): string => {
    // A variable that is set, even to nothing, wins over the file, so `PODIUM_RESPOND= opencode` opts out for one run.
    const v = env[k];
    return typeof v === 'string' ? v : (file[k] ?? '');
  };
  const consent = {} as Consent;
  for (const name of Object.keys(CONSENT_VARS) as ConsentName[]) consent[name] = get(CONSENT_VARS[name]) === 'true';
  return {
    serverUrl: get('PODIUM_SERVER') || 'http://127.0.0.1:4317',
    token: get('PODIUM_TOKEN'),
    userName: get('PODIUM_USER') || null,
    idleSeconds: get('PODIUM_IDLE_SECONDS'),
    consent,
  };
}
