// The reporter's settings (#855). Pure: the environment is passed in, so a test can set it.
import { DEFAULTS, type ReporterOptions } from './reporter.ts';
import { VERSION } from './version.ts';

type Env = Readonly<Record<string, string | undefined>>;

const get = (opts: Readonly<Record<string, any>>, key: string, env: string, e: Env): string => {
  const v = opts[key];
  return typeof v === 'string' && v ? v : (e[env] ?? '');
};

/** The reporter's settings: plugin options first, then the environment, then the defaults. */
export function optionsOf(options: Readonly<Record<string, any>> | null | undefined, engineVersion: string | null, env: Env = process.env): ReporterOptions {
  const opts = options ?? {};
  const idle = Number(opts.idleSeconds ?? env.PODIUM_IDLE_SECONDS);
  return {
    serverUrl: get(opts, 'serverUrl', 'PODIUM_SERVER', env) || 'http://127.0.0.1:4317',
    token: get(opts, 'token', 'PODIUM_TOKEN', env),
    userName: get(opts, 'userName', 'PODIUM_USER', env) || null,
    machine: null,
    // Never below 5 s: a shorter wait would report `done` between two steps of one turn.
    idleMs: Number.isFinite(idle) && idle >= 5 ? idle * 1000 : DEFAULTS.idleMs,
    heartbeatMs: DEFAULTS.heartbeatMs,
    version: VERSION,
    engineVersion,
    hostSurface: null,
  };
}
