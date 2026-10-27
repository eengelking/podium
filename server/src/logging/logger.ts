// The server's logger (#140). Each call is an event: a stable dotted name (`report.rejected`), a message for
// people, and flat fields. Locally it prints either the message alone (`text`, what the server always printed)
// or one JSON object per line (`json`); the JSON line is also what the shipper sends. In text, most of the events
// added with this logger print only at debug (`quietInText`), so the default output is what it always was; a refused
// credential (`auth.failed`) and the `tls.*` events print at their own level, folded when they repeat (#602). Debug and info go to
// stdout, warn and error to stderr, as before. See docs/architecture/ "Logging".
import os from 'node:os';
import { cleanFields, scrub, type FieldValue, type Fields } from './redact.js';

export type { FieldValue, Fields };

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];
export type LogFormat = 'text' | 'json';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
/** The two tls.* lines an operator needs without debug: where reporters connect, and that the CA folder needs a backup (#672). */
const PRINTED_TLS = new Set(['tls.listening', 'tls.ca_created']);

/**
 * Events added with the logger (#140) that the server did not print before. In the text format they are printed
 * only at debug, so the default output stays what it was; the JSON format and the shipper carry them at their own
 * level. The lines the server always printed (startup, shutdown, rejections, failures) are not listed. A refused
 * credential (`auth.failed`) is not listed either: an Admin looking at a plain log to learn why a reporter is
 * offline needs the reason, so it prints at warn (#602), folded by `foldedInText`.
 */
export function quietInText(event: string): boolean {
  return (
    event.startsWith('session.') ||
    event.startsWith('reporter.') ||
    event.startsWith('admin.') ||
    (event.startsWith('tls.') && !PRINTED_TLS.has(event)) || // below warn; a refusal at warn or error is folded instead
    event === 'sweep.removed' ||
    event === 'report.conflict' ||
    event === 'report.accepted' ||
    event === 'http.request' ||
    event === 'http.aborted'
  );
}

/** Events whose repeats are folded in the text output: a reporter retrying a refused credential every few seconds. */
export function foldedInText(event: string, level: Level): boolean {
  return event === 'auth.failed' || (event.startsWith('tls.') && RANK[level] >= RANK.warn);
}

/** How long a printed refusal holds back its repeats, and how many distinct refusals are remembered. */
const FOLD_WINDOW_MS = 60_000;
const FOLD_MAX_KEYS = 1000;

/**
 * Decides whether a folded event prints in text. The first of a kind prints; repeats inside the window do not; the
 * first one after the window prints with the count held back. A kind is the event and its message (which names the route,
 * source and reason), so a different refusal always prints.
 */
function createFolder() {
  const seen = new Map<string, { at: number; held: number }>();
  return (key: string, at: number): { print: boolean; held: number } => {
    const prev = seen.get(key);
    if (prev && at - prev.at < FOLD_WINDOW_MS) {
      prev.held += 1;
      return { print: false, held: 0 };
    }
    seen.delete(key);
    seen.set(key, { at, held: 0 });
    if (seen.size > FOLD_MAX_KEYS) seen.delete(seen.keys().next().value as string);
    return { print: true, held: prev?.held ?? 0 };
  };
}

/** The contract fields; an event's own fields cannot overwrite them. */
const RESERVED = new Set(['timestamp', 'level', 'message', 'event', 'service', 'host', 'version']);

export interface EmitOptions {
  /** false keeps the line local: the shipper uses it to talk about itself without feeding its own buffer. */
  ship?: boolean;
}

export interface Logger {
  debug(event: string, message: string, fields?: Fields): void;
  info(event: string, message: string, fields?: Fields): void;
  warn(event: string, message: string, fields?: Fields): void;
  error(event: string, message: string, fields?: Fields): void;
  log(level: Level, event: string, message: string, fields?: Fields, opts?: EmitOptions): void;
  isEnabled(level: Level): boolean;
}

export interface LoggerOptions {
  /** Lowest level written and shipped. Default `info`. */
  level?: Level;
  /** Local output. Default `text`. */
  format?: LogFormat;
  service?: string;
  host?: string;
  version?: string;
  now?: () => number;
  /** Where a local line goes. Default: stdout for debug and info, stderr for warn and error. */
  write?: (line: string, level: Level) => void;
  /** Receives every line at or above the level as a JSON string. Absent: nothing is shipped. */
  ship?: (json: string) => void;
  /** Exact strings never written or shipped (the admin secret). Person tokens are always scrubbed. */
  secrets?: readonly string[];
}

export function parseLevel(v: string | undefined | null): Level | null {
  const s = (v ?? '').trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(s) ? (s as Level) : null;
}

export function parseFormat(v: string | undefined | null): LogFormat | null {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'text' || s === 'json' ? s : null;
}

const defaultWrite = (line: string, level: Level) => {
  if (RANK[level] >= RANK.warn) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = RANK[opts.level ?? 'info'];
  const format = opts.format ?? 'text';
  const service = opts.service ?? 'podium';
  const host = opts.host ?? os.hostname();
  const version = opts.version ?? '';
  const now = opts.now ?? Date.now;
  const write = opts.write ?? defaultWrite;
  const secrets = (opts.secrets ?? []).filter((s) => typeof s === 'string' && s.length > 0);

  const isEnabled = (level: Level) => RANK[level] >= min;
  const fold = createFolder();

  const log = (level: Level, event: string, message: string, fields?: Fields, emit: EmitOptions = {}) => {
    if (!isEnabled(level)) return;
    try {
      const msg = scrub(message, secrets);
      const record: Record<string, FieldValue> = {
        timestamp: new Date(now()).toISOString(),
        level,
        message: msg,
        event: scrub(event, secrets),
        service,
        host,
        version,
      };
      for (const [k, v] of Object.entries(cleanFields(fields, secrets))) {
        if (!RESERVED.has(k)) record[k] = v;
      }
      const json = JSON.stringify(record);
      if (format === 'json') write(json, level);
      else if (foldedInText(event, level)) {
        const key = `${event}|${msg}`; // the message names the route, source and reason, and tells apart tls.* events that carry no such fields
        const { print, held } = fold(key, now());
        if (print) write(held > 0 ? `${msg} (${held} more in the last minute not printed)` : msg, level);
      } else if (!quietInText(event) || isEnabled('debug')) write(msg, level);
      if (opts.ship && emit.ship !== false) opts.ship(json);
    } catch {
      // A log line must never take a request or a timer down with it.
    }
  };

  return {
    log,
    isEnabled,
    debug: (e, m, f) => log('debug', e, m, f),
    info: (e, m, f) => log('info', e, m, f),
    warn: (e, m, f) => log('warn', e, m, f),
    error: (e, m, f) => log('error', e, m, f),
  };
}

/** Text lines to a plain `log(line)` function: the routers' and the sweeper's original option. */
export function loggerFromLine(line: (l: string) => void): Logger {
  return createLogger({ format: 'text', write: (l) => line(l) });
}

/** Writes nothing. The fleet's default, so tests and tools that build a Fleet stay quiet. */
export const silentLogger: Logger = createLogger({ level: 'error', write: () => {} });
