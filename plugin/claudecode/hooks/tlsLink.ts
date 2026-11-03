// The mod's side of the TLS connection (#584, SPEC 5.9): find the reporter config file, find `node`, start helper.mjs
// and send the mod's requests through its Unix socket. The mod cannot give $.http.fetch a CA or a client certificate,
// so the helper makes the connection. Nothing here ever falls back from `https://` to `http://`.
// What chooses the config file (core/tls/findConfig.ts) and what its problems are called (core/tls/problems.ts) is shared with the other reporters;
// what is here is what only the Claude mod does: find `node`, start the helper and talk to it.
import { decodeBase64Utf8, isWindowsPath, mailboxDirFor, socketPathFor, SOCKET_PATH_MAX, utf8Length } from './reporterConfig.ts';
import { trimTrailingSlashes } from '../../core/machine.ts';
import { envValue, findConfig, readEnv, type ConfigSource, type EnvValues, type FoundConfig } from '../../core/tls/findConfig.ts';
import { configProblemFor, nameMismatchProblem, problemFor, type Problem } from '../../core/tls/problems.ts';
import { podiumHome, trimTrailingSeparators, type ConfigHeaders } from '../../core/tls/reporterConfig.ts';
import type { FetchLike, HttpResult } from '../../core/transport.ts';

/** How long to wait for the helper's `ready` line. */
export const READY_MS = 5000;
/** How long a request waits for the helper's reply through the mailbox (#834); the upstream timeout is shorter, so a live helper always answers first. */
export const REPLY_MS = 45_000;
/** Do not restart a helper that exited more often than this. */
export const RESTART_MIN_MS = 10_000;
const HELPER_ERROR_HEADER = 'x-podium-helper-error';
const NODE_PLACES = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', '/opt/local/bin/node', '/snap/bin/node'];

/** What the helper sends back for a mailbox request (#834). */
interface MailboxAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/** The slice of the engine's `$` this file uses, so a test can stand in for it. */
export interface LinkEngine extends ConfigSource {
  fs: ConfigSource['fs'] & { write: (path: string, text: string) => Promise<void> };
  process: {
    run: (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string }>;
    spawn: (request: { argv: readonly string[]; env?: Record<string, string> }) => AsyncIterable<{ stream: string; text: string }>;
  };
  http: { fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; socketPath?: string }) => Promise<HttpResult & { headers: Record<string, string> }> };
  clock: { sleep: (ms: number) => Promise<void> };
  plugin: { root: string };
}

/** The variables the link reads: those that choose the config file (shared) and those that find `node` and a place for the socket. */
export interface LinkEnv extends EnvValues {
  node: string | undefined;
  tmp: string | undefined;
  /** `ProgramFiles` and `LOCALAPPDATA`, where Windows installs node (#834). */
  programFiles?: string | undefined;
  localAppData?: string | undefined;
}

/** The environment the link reads. `$.env.get` takes a name written out in the source, so each one is spelled here. */
export async function readLinkEnv($: Pick<LinkEngine, 'env'>): Promise<LinkEnv> {
  return {
    ...(await readEnv($)),
    node: await envValue(() => $.env.get('PODIUM_NODE')),
    programFiles: await envValue(() => $.env.get('ProgramFiles')),
    localAppData: await envValue(() => $.env.get('LOCALAPPDATA')),
    tmp: await envValue(() => $.env.get('TMPDIR')),
  };
}

/** The shared choice of a config file (`findConfig` in core), with the environment the link needs read as well and handed back in `env`. */
export async function findLinkConfig($: LinkEngine, env?: LinkEnv, held?: { path: string; context: string } | null): Promise<Omit<Awaited<ReturnType<typeof findConfig>>, 'env'> & { env: LinkEnv }> {
  const e = env ?? (await readLinkEnv($));
  return { ...(await findConfig($, e, held)), env: e };
}

/** A POSIX path (`/usr/bin/node`) or a Windows drive path (`C:\Program Files\nodejs\node.exe`, `C:/x`). */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/** `node` by `PODIUM_NODE`, then the PATH the mod runs with, then the usual places (a desktop launcher often has neither nvm's nor Homebrew's PATH). */
export async function findNode($: LinkEngine, env: LinkEnv): Promise<string | null> {
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

/** The helper's first line of output when it cannot start: `error CODE message`. Split by hand: one regex over the line could backtrack. */
function startupWords(line: string): [string, string] | null {
  const t = line.trim();
  if (!t.startsWith('error ')) return null;
  const rest = t.slice(6);
  const space = rest.search(/\s/);
  const code = space < 0 ? rest : rest.slice(0, space);
  return code ? [code, space < 0 ? '' : rest.slice(space).trim()] : null;
}

export function problemFromStartup(line: string, path: string, helper?: string): Problem {
  const w = startupWords(line);
  if (!w && !line.trim() && helper) return { code: 'HELPER_EXITED', status: 'helper stopped', text: `The Podium connection helper exited before it was ready and printed nothing (started from ${helper}). It restarts on the next session.` };
  const code = w?.[0] ?? 'HELPER_EXITED';
  const aboutConfig = configProblemFor(code, w?.[1], path);
  if (aboutConfig) return aboutConfig;
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
export async function startLink($: LinkEngine, found: FoundConfig, env: LinkEnv, o: LinkOptions): Promise<Link> {
  const { headers } = found;
  const log = o.log ?? (() => {});
  if (o.sessionName && o.sessionName !== headers.user) {
    return brokenLink(found, nameMismatchProblem(headers.user, o.sessionName, o.nameSource, o.nameIsSetting));
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
  const sessionKey = `${found.path}:${o.now()}`;
  // Windows has no socket the mod can reach (#834): the requests go through a folder the helper watches, and its replies come back on its stdout.
  const windows = isWindowsPath(found.path);
  let socket: string | undefined;
  if (windows) {
    if (home) socket = `mailbox:${mailboxDirFor(`${podiumHome(home)}/run`, sessionKey)}`;
    else return brokenLink(found, { code: 'SOCKET_PATH', status: 'helper cannot start', text: 'No home folder was found to hold the helper’s request folder. Set HOME or USERPROFILE.' });
  } else {
    // The home folder first. The temporary folder is the fallback only where the platform names a private one (TMPDIR); a shared /tmp is never assumed.
    const dirs = [home ? `${podiumHome(home)}/run` : null, env.tmp ? `${trimTrailingSlashes(env.tmp)}/podium-run` : null];
    socket = dirs.filter((d): d is string => !!d).map((d) => socketPathFor(d, sessionKey)).find((p) => utf8Length(p) < SOCKET_PATH_MAX);
  }
  if (!socket) {
    return brokenLink(found, { code: 'SOCKET_PATH', status: 'helper cannot start', text: 'No folder is short enough to hold the helper’s socket (a Unix socket path is at most 104 bytes).' });
  }
  const mailbox = windows ? socket.slice('mailbox:'.length) : null;

  const helper = `${$.plugin.root}/plugin/core/tls/helper.mjs`;
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

  // Requests through the mailbox (#834), waiting for the helper's `res <id> <base64>` line.
  const pending = new Map<string, { resolve: (a: MailboxAnswer) => void; reject: (e: Error) => void }>();
  let sequence = 0;
  const idBase = o.now().toString(36);
  const answerFromHelper = (line: string) => {
    const [, id, body] = line.trim().split(' ');
    const waiting = id ? pending.get(id) : undefined;
    if (!waiting || !body) return;
    try {
      const a = JSON.parse(decodeBase64Utf8(body)) as MailboxAnswer;
      if (typeof a.status !== 'number') throw new Error('no status');
      waiting.resolve(a);
    } catch {
      log(`podium-reporter helper: a reply for ${id} could not be read`);
    }
  };
  /**
   * One request through the mailbox: a file the helper takes, and the reply line it answers with. The file holds no header: the reporter sends only
   * Content-Type, which the helper sets, and the token, which the server ignores when the certificate is present and which should not sit in a file.
   */
  const viaMailbox = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } | undefined): Promise<HttpResult & { headers: Record<string, string> }> => {
    const id = `${idBase}-${++sequence}`;
    const answer = new Promise<MailboxAnswer>((resolve, reject) => pending.set(id, { resolve, reject }));
    answer.catch(() => {});
    try {
      await $.fs.write(`${mailbox}/req-${id}.json`, JSON.stringify({ id, method: init?.method ?? 'GET', path: url.slice(serverUrl.length) || '/', body: init?.body ?? '' }));
      const late = $.clock.sleep(REPLY_MS).then(() => {
        throw new Error('the Podium connection helper did not answer in time');
      });
      late.catch(() => {});
      const a = await Promise.race([answer, late]);
      return { status: a.status, ok: a.status >= 200 && a.status < 300, text: a.body ?? '', headers: a.headers ?? {} };
    } finally {
      pending.delete(id);
    }
  };

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
          // A line may arrive in two pieces; only a finished line is read.
          let carry = '';
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            const lines = (carry + next.value.text).split('\n');
            carry = lines.pop() as string;
            for (const line of lines) {
              if (line.trim() === 'ready') {
                running = true;
                problem = expiredNote;
                settle(true);
              } else if (line.startsWith('error ')) said = line;
              else if (line.startsWith('res ')) answerFromHelper(line);
              else if (line.trim()) log(`podium-reporter helper: ${line.trim().slice(0, 200)}`);
            }
          }
        } catch (err) {
          log(`podium-reporter helper: ${err instanceof Error ? err.message : String(err)}`);
        }
        running = false;
        iterator = null;
        if (!stopped) problem = problemFromStartup(said, found.path, helper);
        for (const [id, p] of pending) {
          pending.delete(id);
          p.reject(new Error(problem?.text ?? 'the Podium connection helper stopped'));
        }
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
      const res = mailbox === null ? await $.http.fetch(`http://podium${url.slice(serverUrl.length) || '/'}`, { ...init, socketPath: socket }) : await viaMailbox(url, init);
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
