// The reporter's settings (#855, #856). Pure: the environment and the settings file's text are passed in, so a test can set them.
//
// Where a setting may come from is the rule in `core/settings.ts`: the server, the token, the user name and every consent option
// are read only from `PODIUM_*` and `~/.podium/config.env`. The plugin's own options come from `opencode.json`, which a cloned
// repo can ship, so they never reach those. Only `idleSeconds`, which no attacker gains from, is still taken from them.
import { trustedSettings, type Consent } from '../core/settings.ts';
import { DEFAULTS, type ReporterOptions } from './reporter.ts';
import { VERSION } from './version.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface OpenCodeOptions extends ReporterOptions {
  /** What this person allowed on this machine. Nothing in a project can change it. */
  consent: Consent;
}

/** The reporter's settings: the trusted sources first, `idleSeconds` from the plugin options, then the defaults. */
export function optionsOf(projectOptions: Readonly<Record<string, any>> | null | undefined, engineVersion: string | null, env: Env = process.env, settingsFile: string | null = null): OpenCodeOptions {
  const t = trustedSettings(env, settingsFile);
  const idle = Number(projectOptions?.idleSeconds ?? (t.idleSeconds || undefined));
  return {
    serverUrl: t.serverUrl,
    token: t.token,
    userName: t.userName,
    machine: null,
    // Never below 5 s: a shorter wait would report `done` between two steps of one turn.
    idleMs: Number.isFinite(idle) && idle >= 5 ? idle * 1000 : DEFAULTS.idleMs,
    heartbeatMs: DEFAULTS.heartbeatMs,
    version: VERSION,
    engineVersion,
    hostSurface: null,
    consent: t.consent,
  };
}
