// Which reporter config file to use (#584, #606, #607, #834, #948). The choice is the same for every reporter, so it works over a
// small interface a harness fills in: the Claude mod passes its engine's `$` unchanged, and OpenCode passes an adapter over node:fs.
// No `node:` import here. Only the headers of a file are read, and only for the files tried, newest first.
import { CONTEXTS_FILE, contextFilePath, parseContexts } from './contexts.ts';
import type { Problem } from './problems.ts';
import { configNamesNewestFirst, parseConfigHeaders, podiumHome, resolveHome, type ConfigHeaders } from './reporterConfig.ts';

/** What choosing a config file reads: environment variables and files. A missing variable is `undefined`; a lookup that throws reads as unset. */
export interface ConfigSource {
  env: { get: (name: string) => Promise<string | undefined> };
  fs: {
    /** The text of a file; a file that cannot be read rejects, and anything that is not text reads as absent. */
    read: (path: string) => Promise<unknown>;
    list: (path?: string) => Promise<Array<{ name: string; kind: string }>>;
    exists: (path: string) => Promise<boolean>;
  };
}

export interface EnvValues {
  config: string | undefined;
  /** `PODIUM_REPORTER_CONTEXT` (#606). */
  context?: string | undefined;
  home: string | undefined;
  /** The variable `home` came from (`HOME`, `USERPROFILE` or `HOMEDRIVE+HOMEPATH`), for `/podium` (#834). */
  homeFrom?: string | undefined;
}

/** An environment lookup takes a name written out in the source, so each one is spelled by the caller; a lookup that throws, in its call or its promise, reads as unset. */
export async function envValue(get: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await get();
  } catch {
    return undefined;
  }
}

/** The home folder and the variable it came from (#834): `HOME`, else `USERPROFILE`, else `HOMEDRIVE` plus `HOMEPATH`. */
export async function readHome($: Pick<ConfigSource, 'env'>): Promise<{ home: string | undefined; from: string | undefined }> {
  return resolveHome({
    HOME: await envValue(() => $.env.get('HOME')),
    USERPROFILE: await envValue(() => $.env.get('USERPROFILE')),
    HOMEDRIVE: await envValue(() => $.env.get('HOMEDRIVE')),
    HOMEPATH: await envValue(() => $.env.get('HOMEPATH')),
  });
}

/** The variables that choose a config file. */
export async function readEnv($: Pick<ConfigSource, 'env'>): Promise<EnvValues> {
  const { home, from } = await readHome($);
  return {
    config: await envValue(() => $.env.get('PODIUM_REPORTER_CONFIG')),
    context: await envValue(() => $.env.get('PODIUM_REPORTER_CONTEXT')),
    home,
    homeFrom: from,
  };
}

/** A file's text, or null when it is absent, cannot be read or is not text. */
async function readText($: Pick<ConfigSource, 'fs'>, path: string): Promise<string | null> {
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
async function contextFile($: ConfigSource, home: string, name: string | null, fromEnv: boolean, held?: { path: string; context: string } | null): Promise<{ found: FoundConfig | null; problem: Problem | null }> {
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
export async function findConfig($: ConfigSource, env?: EnvValues, held?: { path: string; context: string } | null): Promise<{ found: FoundConfig | null; problem: Problem | null; contextProblem: Problem | null; homeNote: string | null; env: EnvValues }> {
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
