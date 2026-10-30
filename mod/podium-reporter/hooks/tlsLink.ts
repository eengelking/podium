// The mod's side of the TLS connection (#584, SPEC 5.9): find the reporter config file, find `node`, start helper.mjs
// and send the mod's requests through its Unix socket. The mod cannot give $.http.fetch a CA or a client certificate,
// so the helper makes the connection. Nothing here ever falls back from `https://` to `http://`.
import { configNamesNewestFirst, parseConfigHeaders, podiumHome, resolveHome, trimTrailingSeparators, socketPathFor, SOCKET_PATH_MAX, utf8Length, type ConfigHeaders } from './reporterConfig.ts';
import { trimTrailingSlashes } from './machine.ts';
import { CONTEXTS_FILE, contextFilePath, parseContexts } from './contexts.ts';
import type { FetchLike, HttpResult } from './transport.ts';

/** How long to wait for the helper's `ready` line. */
export const READY_MS = 5000;
/** Do not restart a helper that exited more often than this. */
export const RESTART_MIN_MS = 10_000;
const HELPER_ERROR_HEADER = 'x-podium-helper-error';
const NODE_PLACES = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', '/opt/local/bin/node', '/snap/bin/node'];

/** What is wrong, said so a person can act on it: a short word for the status line and a sentence for `/podium`. */
export interface Problem {
  code: string;
  status: string;
  text: string;
}

/** The slice of the engine's `$` this file uses, so a test can stand in for it. */
export interface LinkEngine {
  env: { get: (name: string) => Promise<string | undefined> };
  fs: {
    read: (path: string) => Promise<unknown>;
    list: (path?: string) => Promise<Array<{ name: string; kind: string }>>;
    exists: (path: string) => Promise<boolean>;
  };
  process: {
    run: (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string }>;
    spawn: (request: { argv: readonly string[]; env?: Record<string, string> }) => AsyncIterable<{ stream: string; text: string }>;
  };
  http: { fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; socketPath?: string }) => Promise<HttpResult & { headers: Record<string, string> }> };
  clock: { sleep: (ms: number) => Promise<void> };
  plugin: { root: string };
}

export interface EnvValues {
  config: string | undefined;
  /** `PODIUM_REPORTER_CONTEXT` (#606). */
  context?: string | undefined;
  home: string | undefined;
  /** The variable `home` came from (`HOME`, `USERPROFILE` or `HOMEDRIVE+HOMEPATH`), for `/podium` (#834). */
  homeFrom?: string | undefined;
  node: string | undefined;
  tmp: string | undefined;
  /** `ProgramFiles` and `LOCALAPPDATA`, where Windows installs node (#834). */
  programFiles?: string | undefined;
  localAppData?: string | undefined;
}

/** `$.env.get` takes a name written out in the source, so each one is spelled here; a lookup that throws, in its call or its promise, reads as unset. */
async function envValue(get: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await get();
  } catch {
    return undefined;
  }
}

/** The home folder and the variable it came from (#834): `HOME`, else `USERPROFILE`, else `HOMEDRIVE` plus `HOMEPATH`. */
export async function readHome($: Pick<LinkEngine, 'env'>): Promise<{ home: string | undefined; from: string | undefined }> {
  return resolveHome({
    HOME: await envValue(() => $.env.get('HOME')),
    USERPROFILE: await envValue(() => $.env.get('USERPROFILE')),
    HOMEDRIVE: await envValue(() => $.env.get('HOMEDRIVE')),
    HOMEPATH: await envValue(() => $.env.get('HOMEPATH')),
  });
}

async function readEnv($: LinkEngine): Promise<EnvValues> {
  const { home, from } = await readHome($);
  return {
    config: await envValue(() => $.env.get('PODIUM_REPORTER_CONFIG')),
    context: await envValue(() => $.env.get('PODIUM_REPORTER_CONTEXT')),
    home,
    homeFrom: from,
    node: await envValue(() => $.env.get('PODIUM_NODE')),
    programFiles: await envValue(() => $.env.get('ProgramFiles')),
    localAppData: await envValue(() => $.env.get('LOCALAPPDATA')),
    // TMPDIR where the platform has it; Windows names its private temporary folder TEMP, or TMP (#834).
    tmp: (await envValue(() => $.env.get('TMPDIR'))) || (await envValue(() => $.env.get('TEMP'))) || (await envValue(() => $.env.get('TMP'))),
  };
}

async function readText($: LinkEngine, path: string): Promise<string | null> {
  try {
    const t = await $.fs.read(path);
    return typeof t === 'string' ? t : null;
  } catch {
    return null;
  }
}

export interface FoundConfig {
  path: string;
  headers: ConfigHeaders;
  /** The context that chose this file (#606); absent when the file came from the environment or from the newest-file rule. */
  context?: string;
}

/** The config file the context `name` points at, or why it cannot be used. */
async function contextFile($: LinkEngine, home: string, name: string | null, fromEnv: boolean, held?: { path: string; context: string } | null): Promise<{ found: FoundConfig | null; problem: Problem | null }> {
  // The file this session's context chose at its start, kept across a reload so a later `use` does not move a running session (#606).
  if (held) {
    const text = await readText($, held.path);
    const headers = text === null ? null : parseConfigHeaders(text);
    if (headers) return { found: { path: held.path, headers, context: held.context }, problem: null };
  }
  const source = fromEnv ? 'PODIUM_REPORTER_CONTEXT' : 'the current context';
  const bad = (why: string): { found: null; problem: Problem } => ({
    found: null,
    problem: { code: 'CONTEXT_INVALID', status: 'context unusable', text: `${why} The newest reporter config file is used instead. Check it with /podium context.` },
  });
  const contextsPath = `${podiumHome(home)}/${CONTEXTS_FILE}`;
  const contextsText = await readText($, contextsPath);
  // A file that is there but cannot be read is a problem, not an absent file: the newest file may be another server.
  if (contextsText === null && (await $.fs.exists(contextsPath).catch(() => false))) return bad(`${contextsPath} cannot be read.`);
  if (contextsText === null) return fromEnv ? bad(`PODIUM_REPORTER_CONTEXT names "${name}", but there is no ${podiumHome(home)}/${CONTEXTS_FILE}.`) : { found: null, problem: null };
  const contexts = parseContexts(contextsText);
  if (!contexts) return bad(`${podiumHome(home)}/${CONTEXTS_FILE} is not a valid contexts file.`);
  const which = name ?? contexts.current;
  if (!which) return { found: null, problem: null };
  const file = Object.hasOwn(contexts.contexts, which) ? contexts.contexts[which] : undefined;
  if (!file) return bad(`${fromEnv ? source : 'The current context'} names "${which}", which is not one of the contexts.`);
  const path = contextFilePath(home, file);
  const text = await readText($, path);
  const headers = text === null ? null : parseConfigHeaders(text);
  if (!headers) return bad(`The context "${which}" points at ${path}, which is missing or is not a Podium reporter config file.`);
  return { found: { path, headers, context: which }, problem: null };
}

/**
 * The reporter config file, in this order (#606): `PODIUM_REPORTER_CONFIG`; the context `PODIUM_REPORTER_CONTEXT` names, or
 * else the current one in `~/.podium/contexts.json`; the newest `reporter-config-*.pem` in `~/.podium/` by the epoch in its name.
 * `held` is the file a context chose earlier in this session; it is used again while it is still a config file. A context that cannot be used comes back as `contextProblem` with the newest file in `found`, so the person is told and the
 * reporter still works. Null `found`: no config, the reporter works as today.
 */
export async function findConfig($: LinkEngine, env?: EnvValues, held?: { path: string; context: string } | null): Promise<{ found: FoundConfig | null; problem: Problem | null; contextProblem: Problem | null; homeNote: string | null; env: EnvValues }> {
  const e = env ?? (await readEnv($));
  if (e.config) {
    const text = await readText($, e.config);
    const headers = text === null ? null : parseConfigHeaders(text);
    if (headers) return { found: { path: e.config, headers }, problem: null, contextProblem: null, homeNote: null, env: e };
    return {
      found: null,
      env: e,
      contextProblem: null,
      homeNote: null,
      problem: { code: 'CONFIG_INVALID', status: 'config unreadable', text: `PODIUM_REPORTER_CONFIG names ${e.config}, which is missing or is not a Podium reporter config file (version 1, with a name, an https server and an issued-at line).` },
    };
  }
  if (!e.home) {
    const homeNote = 'no home folder found (HOME, USERPROFILE and HOMEDRIVE+HOMEPATH are all empty), so no reporter config file can be read. Set PODIUM_REPORTER_CONFIG to its full path.';
    return { found: null, problem: null, contextProblem: null, homeNote, env: e };
  }
  const chosen = await contextFile($, e.home, e.context || null, !!e.context, held);
  if (chosen.found) return { found: chosen.found, problem: null, contextProblem: null, homeNote: null, env: e };
  const dir = podiumHome(e.home);
  let names: Array<{ name: string; kind: string }> = [];
  try {
    names = await $.fs.list(dir);
  } catch {
    return { found: null, problem: null, contextProblem: chosen.problem, homeNote: null, env: e };
  }
  // Newest by the epoch in the name, and the first that parses wins: the key of a file that is not chosen is never read (#607).
  for (const name of configNamesNewestFirst(names.filter((n) => n.kind === 'file').map((n) => n.name))) {
    const text = await readText($, `${dir}/${name}`);
    const headers = text === null ? null : parseConfigHeaders(text);
    if (headers) return { found: { path: `${dir}/${name}`, headers }, problem: null, contextProblem: chosen.problem, homeNote: null, env: e };
  }
  return { found: null, problem: null, contextProblem: chosen.problem, homeNote: null, env: e };
}

/** A POSIX path (`/usr/bin/node`) or a Windows drive path (`C:\Program Files\nodejs\node.exe`, `C:/x`). */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/** `node` by `PODIUM_NODE`, then the PATH the mod runs with, then the usual places (a desktop launcher often has neither nvm's nor Homebrew's PATH). */
export async function findNode($: LinkEngine, env: EnvValues): Promise<string | null> {
  if (env.node) return (await $.fs.exists(env.node).catch(() => false)) ? env.node : null;
  try {
    const r = await $.process.run(['node', '-p', 'process.execPath'], { timeoutMs: 5000 });
    const p = r.stdout.trim();
    if (r.exitCode === 0 && isAbsolutePath(p)) return p;
  } catch {
    // not on this PATH
  }
  const home = env.home === undefined ? undefined : trimTrailingSlashes(env.home);
  const places = [...NODE_PLACES];
  if (home) {
    places.push(`${home}/.volta/bin/node`, `${home}/.local/bin/node`);
    try {
      const versions = (await $.fs.list(`${home}/.nvm/versions/node`)).map((v) => v.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
      for (const v of versions) places.push(`${home}/.nvm/versions/node/${v}/bin/node`);
    } catch {
      // no nvm
    }
  }
  // Windows (#834): the machine-wide installer, the per-user installer, and Volta.
  if (env.programFiles) places.push(`${trimTrailingSeparators(env.programFiles)}/nodejs/node.exe`);
  if (env.localAppData) places.push(`${trimTrailingSeparators(env.localAppData)}/Programs/nodejs/node.exe`, `${trimTrailingSeparators(env.localAppData)}/Volta/bin/node.exe`);
  for (const p of places) if (await $.fs.exists(p).catch(() => false)) return p;
  return null;
}

/** Clocks closer than this are not the reason a certificate looks expired or not yet valid. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** The two clocks a certificate date is judged by: this machine's now, and the server's when a reply has told us (epoch ms). */
export interface ClockView {
  now: number;
  serverNow?: number;
}

const stamp = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * A server certificate that looks expired or not yet valid says the clock may be wrong when the server's time is unknown
 * (the handshake failed before any reply) or differs from this machine's by more than CLOCK_SKEW_MS (#650). It never says
 * the clock is wrong for certain: the certificate could be expired. Null when the clock is not in question.
 */
function clockProblem(code: string, clock: ClockView | undefined): Problem | null {
  if (!clock || (code !== 'CERT_HAS_EXPIRED' && code !== 'CERT_NOT_YET_VALID')) return null;
  const look = code === 'CERT_HAS_EXPIRED' ? 'expired' : 'not yet valid';
  if (clock.serverNow === undefined) {
    return { code, status: 'check the clock', text: `The server's certificate looks ${look} from here. This machine's clock says it is ${stamp(clock.now)}; if that is not right, a wrong clock is the likely cause. Check the system date and time. If it is right, tell whoever runs the Podium server.` };
  }
  if (Math.abs(clock.serverNow - clock.now) <= CLOCK_SKEW_MS) return null;
  return { code, status: 'check the clock', text: `The server's certificate looks ${look} from here. This machine's clock says it is ${stamp(clock.now)}, and the server's says ${stamp(clock.serverNow)}. Clocks that far apart can make a good certificate look wrong. Check the system date and time. If this machine's is right, the server's clock may be the wrong one: tell whoever runs the Podium server.` };
}

/** What a helper error code means to the person. Null for a network failure, which is an outage the reporter retries as today. */
export function problemFor(code: string, host: string, clock?: ClockView, expiredOn?: string): Problem | null {
  const skewed = clockProblem(code, clock);
  if (skewed) return skewed;
  switch (code) {
    case 'CLIENT_CERT_REJECTED':
      return { code, status: 'certificate refused', text: 'The server did not accept your certificate: it was revoked, has expired, or the server was reset. Ask an Admin to reissue your reporter config.' };
    case 'CERT_EXPIRED':
      return { code, status: 'certificate expired', text: `Your Podium certificate expired${expiredOn ? ` on ${expiredOn}` : ''}. Ask an Admin to generate a new reporter config.` };
    case 'CERT_RENEWAL_REFUSED':
      return { code, status: 'certificate refused', text: 'The server would not renew your certificate: it was revoked, or is not one this server issued. Ask an Admin to reissue your reporter config.' };
    case 'CLOSED_AFTER_HANDSHAKE':
      return { code, status: 'server closed connection', text: 'The server closed the connection right after the handshake. Either it restarted, or it did not accept your certificate (revoked or expired). If this goes on, ask an Admin to reissue your reporter config.' };
    case 'CERT_HAS_EXPIRED':
      return { code, status: 'server certificate expired', text: "The server's own certificate has expired. Tell whoever runs the Podium server." };
    case 'ALTNAME':
      return { code, status: 'wrong server name', text: `The server's certificate is not for ${host}. The address in the reporter config file does not match the server.` };
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return { code, status: 'server not trusted', text: 'The server’s certificate is not signed by the CA in your reporter config file. Ask an Admin for a new file.' };
    default:
      return code.startsWith('CERT_') ? { code, status: 'server certificate refused', text: `The server's certificate was refused (${code}).` } : null;
  }
}

/** The helper's first line of output when it cannot start: `error CODE message`. Split by hand: one regex over the line could backtrack. */
function startupWords(line: string): [string, string] | null {
  const t = line.trim();
  if (!t.startsWith('error ')) return null;
  const rest = t.slice(6);
  const space = rest.search(/\s/);
  const code = space < 0 ? rest : rest.slice(0, space);
  return code ? [code, space < 0 ? '' : rest.slice(space).trim()] : null;
}

const STATUS_REASON_MAX = 60

/** `config unreadable`, with the helper's reason after it (cut to fit a status line) so the status says what is wrong with the file (#672). */
function configStatus(reason: string | undefined): string {
  const short = reason && reason.length > STATUS_REASON_MAX ? `${reason.slice(0, STATUS_REASON_MAX - 1)}…` : reason
  return short ? `config unreadable: ${short}` : 'config unreadable'
}
export function problemFromStartup(line: string, path: string): Problem {
  const w = startupWords(line);
  const code = w?.[0] ?? 'HELPER_EXITED';
  if (code === 'CONFIG_PERMISSIONS') return { code, status: 'config too open', text: `The reporter config file ${path} can be read by other people, and it holds your private key. Run: chmod 600 ${path}` };
  if (code === 'CONFIG_INVALID' || code === 'CONFIG_MISSING') return { code, status: configStatus(w?.[1]), text: `The reporter config file ${path} cannot be used: ${w?.[1] ?? code}.` };
  return { code, status: 'helper stopped', text: `The Podium connection helper stopped${w ? `: ${w[1] || code}` : ''}. It restarts on the next session.` };
}

export interface Link {
  /** The address in the config file. */
  serverUrl: string;
  /** The name in the config file. */
  user: string;
  configPath: string;
  /** Null for a link that stands in for a file that could not be read. */
  headers: ConfigHeaders | null;
  fetch: FetchLike;
  /** What is wrong right now, or null. */
  problem: () => Problem | null;
  /** Ends the helper (the session is over; a `clear` does not call this). */
  stop: () => void;
}

/** A link that never connects and says why: nothing is sent, and nothing falls back to http. */
function brokenLink(found: FoundConfig, problem: Problem): Link {
  return {
    serverUrl: found.headers.server,
    user: found.headers.user,
    configPath: found.path,
    headers: found.headers,
    fetch: () => Promise.reject(new Error(problem.text)),
    problem: () => problem,
    stop: () => {},
  };
}

/** Stands in for a config file that was named and cannot be used: nothing is sent, over https or http, and the status line says why (#645). */
export function unusableLink(configPath: string, serverUrl: string, problem: Problem): Link {
  return { serverUrl, user: '', configPath, headers: null, fetch: () => Promise.reject(new Error(problem.text)), problem: () => problem, stop: () => {} };
}

export interface LinkOptions {
  /** The name this session reports as; empty when it has none, and then the file's name is taken. */
  sessionName: string;
  /** Where that name came from, in words for the message (#647); empty when unknown. */
  nameSource?: string;
  /** True when that name is a setting the person can empty; false when it is the identity the session holds (change it with `/podium name`). */
  nameIsSetting?: boolean;
  /** Epoch milliseconds now. */
  now: () => number;
  log?: (line: string) => void;
}

/**
 * Starts the helper for `found` and returns a link whose `fetch` sends through it, or a link that says what is wrong.
 * Checked before anything starts: the name matches the session's and `node` exists. An expired certificate does not stop it: the helper says it has expired, with the date, instead of connecting.
 */
export async function startLink($: LinkEngine, found: FoundConfig, env: EnvValues, o: LinkOptions): Promise<Link> {
  const { headers } = found;
  const log = o.log ?? (() => {});
  if (o.sessionName && o.sessionName !== headers.user) {
    return brokenLink(found, { code: 'NAME_MISMATCH', status: 'wrong config for this name', text: `The reporter config file is for "${headers.user}", but this session reports as "${o.sessionName}"${o.nameSource ? `, and "${o.sessionName}" comes from ${o.nameSource}` : ''}. Use the file for "${o.sessionName}", or ${o.nameSource && o.nameIsSetting ? `leave that empty so the session takes the file's name` : 'change the name'}.` });
  }
  // An expired certificate is not renewed (#665): the server's reporter port drops it at the handshake. The status line says so from the start.
  const expires = headers.expires ? Date.parse(headers.expires) : Number.NaN;
  const expiredOn = Number.isFinite(expires) && expires < o.now() ? headers.expires?.slice(0, 10) : undefined;
  const expiredNote: Problem | null = expiredOn ? problemFor('CERT_EXPIRED', '', undefined, expiredOn) : null;
  const node = await findNode($, env);
  if (!node) {
    return brokenLink(found, {
      code: 'NO_NODE',
      status: 'no node',
      text: 'Podium needs node to make its secure connection and cannot find it. Install Node.js, put it on the PATH Claude Code starts with, or set PODIUM_NODE to its full path.',
    });
  }

  const home = env.home === undefined ? undefined : trimTrailingSlashes(env.home);
  // The home folder first. The temporary folder is the fallback only where the platform names a private one (TMPDIR); a shared /tmp is never assumed.
  const dirs = [home ? `${podiumHome(home)}/run` : null, env.tmp ? `${trimTrailingSlashes(env.tmp)}/podium-run` : null];
  const sessionKey = `${found.path}:${o.now()}`;
  const socket = dirs.filter((d): d is string => !!d).map((d) => socketPathFor(d, sessionKey)).find((p) => utf8Length(p) < SOCKET_PATH_MAX);
  if (!socket) {
    return brokenLink(found, { code: 'SOCKET_PATH', status: 'helper cannot start', text: 'No folder is short enough to hold the helper’s socket (a Unix socket path is at most 104 bytes).' });
  }

  const helper = `${$.plugin.root}/hooks/helper.mjs`;
  const serverUrl = trimTrailingSlashes(headers.server);
  const host = new URL(serverUrl).host;

  let problem: Problem | null = null;
  let running = false;
  let starting: Promise<boolean> | null = null;
  let lastStart = 0;
  let iterator: AsyncIterator<{ stream: string; text: string }> | null = null;
  let stopped = false;
  // The server's clock minus this machine's, from the Date header of the last reply the server itself sent; undefined until one comes.
  let serverOffsetMs: number | undefined;

  const start = (): Promise<boolean> => {
    if (starting) return starting;
    lastStart = o.now();
    starting = new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      // The environment is cleared of the two variables that turned verification off in the spike (the helper also forces it on).
      const stream = $.process.spawn({ argv: [node, helper, found.path, socket, serverUrl], env: { NODE_TLS_REJECT_UNAUTHORIZED: '', NODE_OPTIONS: '' } });
      void (async () => {
        let said = '';
        try {
          iterator = stream[Symbol.asyncIterator]();
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            for (const line of next.value.text.split('\n')) {
              if (line.trim() === 'ready') {
                running = true;
                problem = expiredNote;
                settle(true);
              } else if (line.startsWith('error ')) said = line;
              else if (line.trim()) log(`podium-reporter helper: ${line.trim().slice(0, 200)}`);
            }
          }
        } catch (err) {
          log(`podium-reporter helper: ${err instanceof Error ? err.message : String(err)}`);
        }
        running = false;
        iterator = null;
        if (!stopped) problem = problemFromStartup(said, found.path);
        settle(false);
      })();
      // A sleep the engine abandons (the module unloads) rejects: nothing is waiting on it then.
      void $.clock
        .sleep(READY_MS)
        .then(() => {
          if (!settled) {
            problem = { code: 'HELPER_SLOW', status: 'helper not ready', text: 'The Podium connection helper did not say it was ready in time.' };
            settle(false);
          }
        })
        .catch(() => {});
    }).finally(() => {
      starting = null;
    });
    return starting;
  };

  // Not awaited: a helper that is slow to start must not hold up session.start. The first request waits for it instead.
  void start();

  const link: Link = {
    serverUrl,
    user: headers.user,
    configPath: found.path,
    headers,
    problem: () => problem,
    stop: () => {
      stopped = true;
      void iterator?.return?.();
    },
    fetch: async (url, init) => {
      if (url !== serverUrl && !url.startsWith(`${serverUrl}/`)) throw new Error('refusing to send to a server other than the one in the reporter config file');
      if (stopped) throw new Error('the Podium connection helper has been stopped');
      if (!running) {
        if (starting) await starting;
        else if (o.now() - lastStart >= RESTART_MIN_MS) await start();
        if (!running) throw new Error(problem?.text ?? 'the Podium connection helper is not running');
      }
      const res = await $.http.fetch(`http://podium${url.slice(serverUrl.length) || '/'}`, { ...init, socketPath: socket });
      const code = res.headers?.[HELPER_ERROR_HEADER];
      if (code) {
        // An outage has no words of its own: it must not wipe a standing certificate problem.
        problem = problemFor(code, host, { now: o.now(), serverNow: serverOffsetMs === undefined ? undefined : o.now() + serverOffsetMs }, expiredOn) ?? problem;
        return res;
      }
      // A reply without the helper's error header came from the server and carries its Date (#650).
      const sent = Date.parse(res.headers?.date ?? '');
      if (Number.isFinite(sent)) serverOffsetMs = sent - o.now();
      if (res.status === 401) {
        // The server read the certificate and turned it away (revoked, expired, not one it issued). A person with a config file has no token to blame (#646).
        problem = problemFor('CLIENT_CERT_REJECTED', host) ?? problem;
      } else if (res.ok) {
        problem = null;
      }
      return res;
    },
  };
  return link;
}
