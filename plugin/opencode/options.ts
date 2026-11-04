// The reporter's settings (#855, #856). Pure: the environment and the settings file's text are passed in, so a test can set them.
//
// Where a setting may come from is the rule in `core/settings.ts`: the server, the token, the user name and every consent option
// are read only from `PODIUM_*` and `~/.podium/config.env`. The plugin's own options come from `opencode.json`, which a cloned
// repo can ship, so they never reach those. Only `idleSeconds`, `flushIntervalMs`, `heartbeatMs` and `sessionName`, which no attacker gains from, are still taken from them.
import { trustedSettings, type Consent } from '../core/settings.ts';
import { DEFAULTS, type ReporterOptions } from './reporter.ts';
import { VERSION } from './version.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface OpenCodeOptions extends ReporterOptions {
  /** What this person allowed on this machine. Nothing in a project can change it. */
  consent: Consent;
  /** `flushIntervalMs` (1000, at least 200): how often the flush timer runs. */
  flushMs: number;
  /** The `sessionName` option, trimmed; null when unset. Below the name OpenCode gives the session, as in the Claude Code reporter (SPEC 6.6). */
  sessionName: string | null;
  /** PODIUM_REPORTER_CONFIG and PODIUM_REPORTER_CONTEXT (#948): which reporter config file to use. Like consent, only a trusted source names them. */
  reporterConfig: string;
  reporterContext: string;
}

/** A finite number at or above `min`; `fallback` for anything else. The Claude Code reporter's rule for the same options. */
const atLeast = (v: unknown, fallback: number, min: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : fallback);

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
    flushMs: atLeast(projectOptions?.flushIntervalMs, DEFAULTS.flushMs, 200),
    heartbeatMs: atLeast(projectOptions?.heartbeatMs, DEFAULTS.heartbeatMs, 1000),
    sessionName: typeof projectOptions?.sessionName === 'string' && projectOptions.sessionName.trim() ? projectOptions.sessionName.trim() : null,
    version: VERSION,
    engineVersion,
    hostSurface: null,
    consent: t.consent,
    reporterConfig: t.reporterConfig,
    reporterContext: t.reporterContext,
  };
}
