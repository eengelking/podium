// Podium contexts (#606): a name for one reporter config file, kept in `~/.podium/contexts.json` the way a kubeconfig keeps
// `contexts` and `current-context`. This file holds the format, the changes to it and the `/podium context` command.
// tlsLink.ts reads the file to choose a config; podiumctl keeps a copy of the format (scripts/podiumctl.test.ts compares them).
import { parseConfigHeaders, podiumHome } from './reporterConfig.ts';

export const CONTEXTS_FILE = 'contexts.json';

export interface Contexts {
  /** The context the reporter uses when `PODIUM_REPORTER_CONTEXT` is not set; null for none. */
  current: string | null;
  /** Name to config file: a bare file name in `~/.podium/`, or an absolute path. */
  contexts: Record<string, string>;
}

export type Change = { ok: true; contexts: Contexts; note: string } | { ok: false; error: string };

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validContextName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/** A bare file name (no folder) or an absolute path; never a relative path, so nothing climbs out of `~/.podium/`. */
function validFile(file: unknown): file is string {
  if (typeof file !== 'string' || !file) return false;
  if (file.startsWith('/')) return !file.includes('\0') && !file.endsWith('/');
  return !file.includes('/') && !file.includes('\0') && file !== '.' && file !== '..';
}

/** The contexts in a file's text, or null when it is not a contexts file. A `current` that names no context is dropped. */
export function parseContexts(text: string): Contexts | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { current, contexts } = raw as { current?: unknown; contexts?: unknown };
  if (typeof contexts !== 'object' || contexts === null || Array.isArray(contexts)) return null;
  if (current !== undefined && current !== null && typeof current !== 'string') return null;
  const out: Record<string, string> = {};
  for (const [name, file] of Object.entries(contexts)) {
    if (!validContextName(name) || !validFile(file)) return null;
    out[name] = file;
  }
  return { current: typeof current === 'string' && Object.hasOwn(out, current) ? current : null, contexts: out };
}

export function serializeContexts(c: Contexts): string {
  return `${JSON.stringify({ current: c.current, contexts: c.contexts }, null, 2)}\n`;
}

/** The path a context's file value stands for. */
export function contextFilePath(home: string, file: string): string {
  return file.startsWith('/') ? file : `${podiumHome(home)}/${file}`;
}

const NEXT_SESSION = 'It applies from the next session; sessions already running keep the context they started with.';

const fail = (error: string): Change => ({ ok: false, error });

export function addContext(c: Contexts, name: string, file: string): Change {
  if (!validContextName(name)) return fail(`"${name}" is not a usable context name. Use letters, digits, dots, dashes and underscores, starting with a letter or digit, up to 64 characters.`);
  if (!validFile(file)) return fail(`"${file}" is not a config file name in ~/.podium or an absolute path.`);
  if (Object.hasOwn(c.contexts, name)) return fail(`There is already a context named "${name}". Remove it first, or choose another name.`);
  return { ok: true, contexts: { current: c.current ?? name, contexts: { ...c.contexts, [name]: file } }, note: c.current ? '' : `"${name}" is now the current context. ${NEXT_SESSION}` };
}

export function renameContext(c: Contexts, from: string, to: string): Change {
  if (!Object.hasOwn(c.contexts, from)) return fail(`There is no context named "${from}".`);
  if (!validContextName(to)) return fail(`"${to}" is not a usable context name.`);
  if (Object.hasOwn(c.contexts, to)) return fail(`There is already a context named "${to}".`);
  const contexts: Record<string, string> = {};
  for (const [name, file] of Object.entries(c.contexts)) contexts[name === from ? to : name] = file;
  return { ok: true, contexts: { current: c.current === from ? to : c.current, contexts }, note: '' };
}

export function removeContext(c: Contexts, name: string): Change {
  if (!Object.hasOwn(c.contexts, name)) return fail(`There is no context named "${name}".`);
  const contexts = { ...c.contexts };
  delete contexts[name];
  return { ok: true, contexts: { current: c.current === name ? null : c.current, contexts }, note: c.current === name ? 'It was the current context, so there is none now: the newest reporter config file is used.' : '' };
}

export function useContext(c: Contexts, name: string): Change {
  if (!Object.hasOwn(c.contexts, name)) return fail(`There is no context named "${name}".`);
  return { ok: true, contexts: { ...c, current: name }, note: NEXT_SESSION };
}

/** The slice of `$.fs` the command needs: a missing file reads as null, and a file that is there but cannot be read throws. */
export interface ContextIO {
  read: (path: string) => Promise<string | null>;
  write: (path: string, text: string) => Promise<void>;
}

const VERBS = 'list, show, add, rename, remove, use';

interface Loaded {
  path: string;
  contexts: Contexts;
}

async function load(io: ContextIO, home: string): Promise<Loaded | string> {
  const path = `${podiumHome(home)}/${CONTEXTS_FILE}`;
  let text: string | null;
  try {
    text = await io.read(path);
  } catch {
    return `${path} exists but cannot be read, so nothing was changed.`;
  }
  if (text === null) return { path, contexts: { current: null, contexts: {} } };
  const contexts = parseContexts(text);
  return contexts ? { path, contexts } : `${path} is not a valid contexts file, so nothing was changed. Fix or delete it.`;
}

/** One line for a context: the server and person in its file, or why the file cannot be used. */
async function describeFile(io: ContextIO, home: string, file: string): Promise<string> {
  const text = await io.read(contextFilePath(home, file));
  if (text === null) return 'file missing';
  const h = parseConfigHeaders(text);
  if (!h) return 'not a Podium reporter config';
  return `${h.user} at ${h.server.replace(/^https:\/\//, '')}`;
}

async function list(io: ContextIO, home: string, c: Contexts, fromEnv: string | undefined): Promise<string> {
  const names = Object.keys(c.contexts);
  if (!names.length) return 'No contexts. The newest reporter config file in ~/.podium is used. Add one: /podium context add <name> <config file>';
  const rows = await Promise.all(names.map(async (n) => `${n === c.current ? '*' : ' '} ${n}  ${await describeFile(io, home, c.contexts[n] as string)}${n === fromEnv ? '  (this terminal: PODIUM_REPORTER_CONTEXT)' : ''}`));
  return [...rows, '', `* is the current context.${fromEnv ? ` PODIUM_REPORTER_CONTEXT in this terminal is "${fromEnv}" and wins over it.` : ''}`].join('\n');
}

async function show(io: ContextIO, home: string, c: Contexts, name: string | undefined, fromEnv: string | undefined): Promise<string> {
  const which = name ?? fromEnv ?? c.current;
  if (!which) return 'There is no current context. The newest reporter config file in ~/.podium is used.';
  const file = Object.hasOwn(c.contexts, which) ? c.contexts[which] : undefined;
  if (!file) return `There is no context named "${which}".`;
  return [`Context: ${which}${which === c.current ? ' (current)' : ''}${which === fromEnv ? ' (set by PODIUM_REPORTER_CONTEXT)' : ''}`, `File: ${contextFilePath(home, file)}`, `Reports as: ${await describeFile(io, home, file)}`].join('\n');
}

/**
 * `/podium context <verb>` (#606). `add` checks the file is there and is a reporter config before it writes, and nothing
 * here touches a config file itself. `fromEnv` is this terminal's `PODIUM_REPORTER_CONTEXT`, which wins over `current`.
 */
export async function contextCommand(io: ContextIO, home: string, args: string, fromEnv: string | undefined): Promise<string> {
  const [verb = 'list', a, b, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (!['list', 'show', 'add', 'rename', 'remove', 'use'].includes(verb)) return `Unknown context command "${verb}". Use one of: ${VERBS}.`;
  const loaded = await load(io, home);
  if (typeof loaded === 'string') return loaded;
  const { path, contexts } = loaded;
  if (verb === 'list') return list(io, home, contexts, fromEnv);
  if (verb === 'show') return show(io, home, contexts, a, fromEnv);
  let change: Change;
  if (verb === 'add') {
    if (!a || !b || rest.length) return 'usage: /podium context add <name> <config file>   (a file name in ~/.podium, or an absolute path)';
    const text = await io.read(contextFilePath(home, b));
    if (text === null) return `No such file: ${contextFilePath(home, b)}. Nothing was added.`;
    if (!parseConfigHeaders(text)) return `${contextFilePath(home, b)} is not a Podium reporter config file (version 1, with a name, an https server and an issued-at line). Nothing was added.`;
    change = addContext(contexts, a, b);
  } else if (verb === 'rename') {
    if (!a || !b || rest.length) return 'usage: /podium context rename <name> <new name>';
    change = renameContext(contexts, a, b);
  } else if (verb === 'remove') {
    if (!a || b) return 'usage: /podium context remove <name>';
    change = removeContext(contexts, a);
  } else {
    if (!a || b) return 'usage: /podium context use <name>';
    change = useContext(contexts, a);
  }
  if (!change.ok) return change.error;
  await io.write(path, serializeContexts(change.contexts));
  const done = { add: `Added context "${a}" for ${b}.`, rename: `Renamed context "${a}" to "${b}".`, remove: `Removed context "${a}" (its config file is untouched).`, use: `The current context is now "${a}".` }[verb] as string;
  const envNote = verb === 'use' && fromEnv && fromEnv !== a ? ` PODIUM_REPORTER_CONTEXT is "${fromEnv}" in this terminal and wins over it here.` : '';
  return [done, change.note, envNote.trim()].filter(Boolean).join(' ');
}
