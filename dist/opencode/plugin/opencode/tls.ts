// The OpenCode reporter's secure connection (#948): find the reporter config file the way the Claude reporter does, make the mTLS
// client from core (`../core/tls/client.mjs`) in this process, and hand the Reporter a `fetch` that goes through it.
//
// What this file never does: read the file from a project's config (the path comes from `PODIUM_REPORTER_CONFIG`, a context in
// `~/.podium/contexts.json` or the newest file in `~/.podium/`, and the first two from `PODIUM_*` and `~/.podium/config.env` only, see
// `../core/settings.ts`); fall back from https to http once a file is found; or put the private key, a certificate or a CA in a log
// line, an error or a problem text. Every text that leaves this file passes `scrub`, which removes anything that looks like a PEM block.
import { access, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { trimTrailingSlashes } from '../core/machine.ts';
import { StartError } from '../core/tls/config.mjs';
import { createTlsClient, type TlsClient } from '../core/tls/client.mjs';
import { findConfig, readEnv, type ConfigSource, type FoundConfig } from '../core/tls/findConfig.ts';
import { configProblemFor, nameMismatchProblem, problemFor, type Problem } from '../core/tls/problems.ts';
import type { FetchLike } from '../core/transport.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** A PEM block, or the start of one that was cut off. */
const PEM = /-----BEGIN [A-Z ]*-----[\s\S]*?(?:-----END [A-Z ]*-----|$)/g;

/** `text` without anything that looks like a PEM block. The key never gets as far as a message, and this is the second lock on that door. */
export function scrub(text: string): string {
  return text.replace(PEM, '[removed]');
}

/** The secure connection for one location, as the Reporter uses it. */
export interface TlsLink {
  /** The address in the config file (https), or the configured one when the file could not be used. */
  serverUrl: string;
  /** The name in the config file; '' for a link that stands in for a file that could not be read. */
  user: string;
  /** The context that chose the file, or null. */
  context: string | null;
  configPath: string;
  /** Sends through the client. Never plain http; a link that cannot connect rejects with the problem's text. */
  fetch: FetchLike;
  /** What is wrong right now, or null. */
  problem: () => Problem | null;
  /** Starts the renewal check. */
  start: () => void;
  /** Stops the renewal check and closes the connection. */
  stop: () => void;
}

export interface LinkInputs {
  /** The trusted settings (`optionsOf`): the name the session reports as, the configured server, and which file or context to use. */
  options: { userName: string | null; serverUrl: string; reporterConfig: string; reporterContext: string };
  env: Env;
  home: string;
  now: () => number;
  /** One line per distinct problem. Default: `console.warn`. */
  warn?: (line: string) => void;
  /** Where files are read from. Default: node:fs. */
  source?: ConfigSource;
  /** Makes the client. Default: core's `createTlsClient`. */
  createClient?: typeof createTlsClient;
}

/** A source over node:fs and a set of environment values. The two reporter variables come from the trusted settings, not from `env`. */
export function nodeSource(env: Env, home: string, trusted: { reporterConfig: string; reporterContext: string }): ConfigSource {
  const values: Record<string, string | undefined> = { ...env, HOME: env.HOME || home, PODIUM_REPORTER_CONFIG: trusted.reporterConfig || undefined, PODIUM_REPORTER_CONTEXT: trusted.reporterContext || undefined };
  return {
    env: { get: async (name) => values[name] },
    fs: {
      read: (path) => readFile(path, 'utf8'),
      list: async (path = '.') => (await readdir(path, { withFileTypes: true })).map((d) => ({ name: d.name, kind: d.isFile() ? 'file' : d.isDirectory() ? 'dir' : 'other' })),
      exists: (path) => access(path).then(
        () => true,
        () => false,
      ),
    },
  };
}

/** A link that never connects and says why: nothing is sent, over https or http. */
function stoodIn(serverUrl: string, user: string, configPath: string, context: string | null, problem: Problem): TlsLink {
  return { serverUrl, user, context, configPath, fetch: () => Promise.reject(new Error(scrub(problem.text))), problem: () => problem, start: () => undefined, stop: () => undefined };
}

/** What a failure to make the client means: the config problems, or the address that is not https. */
function startProblem(err: unknown, path: string): Problem {
  const code = err instanceof StartError ? String((err as { code?: unknown }).code ?? '') : '';
  const why = err instanceof Error ? scrub(err.message) : String(err);
  const config = configProblemFor(code, why, path);
  if (config) return config;
  if (code === 'INSECURE_URL') return { code, status: 'server address not https', text: `The reporter config file ${path} names a server address that is not https, and a reporter never sends a credential over http.` };
  return { code: code || 'TLS_CLIENT', status: 'connection unavailable', text: `The secure connection to Podium could not be made: ${why}` };
}

/**
 * Finds the config file and makes the link, or null when there is no file (the reporter then works as it does without one, over the
 * configured server). Never rejects: a file that cannot be used becomes a link that says why.
 */
export async function openLink(i: LinkInputs): Promise<TlsLink | null> {
  const warn = i.warn ?? ((line: string) => console.warn(line));
  const said = new Set<string>();
  const say = (p: Problem | null): void => {
    if (p && !said.has(p.text)) {
      said.add(p.text);
      warn(`podium-reporter: ${scrub(p.text)}`);
    }
  };
  let found: Awaited<ReturnType<typeof findConfig>>;
  try {
    const source = i.source ?? nodeSource(i.env, i.home, i.options);
    found = await findConfig(source, await readEnv(source), null);
  } catch (err) {
    // Looking failed outright (an unexpected error): no file, no secure connection, as without one.
    warn(`podium-reporter: could not look for a reporter config file: ${scrub(err instanceof Error ? err.message : String(err))}`);
    return null;
  }
  say(found.contextProblem);
  if (found.problem) {
    // A file that PODIUM_REPORTER_CONFIG names and that cannot be used: nothing is sent.
    say(found.problem);
    return stoodIn(i.options.serverUrl, '', found.env.config ?? '', null, found.problem);
  }
  if (!found.found) return null;
  return makeLink(i, found.found, say);
}

function makeLink(i: LinkInputs, file: FoundConfig, say: (p: Problem | null) => void): TlsLink {
  const { headers } = file;
  const serverUrl = trimTrailingSlashes(headers.server);
  const context = file.context ?? null;
  const name = (i.options.userName ?? '').trim();
  if (name && name !== headers.user) {
    const p = nameMismatchProblem(headers.user, name, 'PODIUM_USER', true);
    say(p);
    return stoodIn(serverUrl, headers.user, file.path, context, p);
  }
  let client: TlsClient;
  try {
    client = (i.createClient ?? createTlsClient)({ configPath: file.path, serverUrl, log: (line) => say({ code: 'RENEWAL', status: 'renewal failed', text: line }), env: i.env });
  } catch (err) {
    const p = startProblem(err, file.path);
    say(p);
    return stoodIn(serverUrl, headers.user, file.path, context, p);
  }
  const host = new URL(serverUrl).host;
  const expires = headers.expires ? Date.parse(headers.expires) : Number.NaN;
  const expiredOn = Number.isFinite(expires) && expires < i.now() ? headers.expires?.slice(0, 10) : undefined;
  let problem: Problem | null = expiredOn ? problemFor('CERT_EXPIRED', '', undefined, expiredOn) : null;
  say(problem);
  // The server's clock minus this machine's, from the Date header of the last reply the server itself sent; undefined until one comes.
  let serverOffsetMs: number | undefined;
  const fetch: FetchLike = async (url, init) => {
    try {
      const res = await client.fetch(url, init);
      const sent = Date.parse(res.headers?.date ?? '');
      if (Number.isFinite(sent)) serverOffsetMs = sent - i.now();
      if (res.status === 401) {
        // The server read the certificate and turned it away. A person with a config file has no token to blame (#646).
        problem = problemFor('CLIENT_CERT_REJECTED', host) ?? problem;
        say(problem);
      } else if (res.ok) {
        problem = null;
      }
      return { status: res.status, ok: res.ok, text: res.text, headers: res.headers };
    } catch (err) {
      const code = String((err as { code?: unknown } | null)?.code ?? '');
      const since = code === 'CERT_EXPIRED' ? new Date(client.status().notAfter).toISOString().slice(0, 10) : expiredOn;
      // An outage has no words of its own: it must not wipe a standing certificate problem.
      const p = problemFor(code, host, { now: i.now(), serverNow: serverOffsetMs === undefined ? undefined : i.now() + serverOffsetMs }, since);
      if (p) {
        problem = p;
        say(p);
      }
      throw new Error(scrub(p?.text ?? (err instanceof Error ? err.message : String(err))));
    }
  };
  return { serverUrl, user: headers.user, context, configPath: file.path, fetch, problem: () => problem, start: () => client.start(), stop: () => client.stop() };
}

/** The options the Reporter runs with once the link is known: the file's address, and its name when the session had none. */
export function withLink<T extends { serverUrl: string; userName: string | null }>(o: T, link: TlsLink | null): T {
  if (!link) return o;
  return { ...o, serverUrl: link.serverUrl, userName: o.userName?.trim() ? o.userName : link.user || o.userName };
}

/** Where the plugin's home folder is: HOME, else the operating system's answer. */
export const homeOf = (env: Env): string => env.HOME || env.USERPROFILE || homedir();
