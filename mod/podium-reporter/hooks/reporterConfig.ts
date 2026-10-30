// Finding and reading the header of the reporter config file (SPEC 5.9, #577). Only the header lines are read here: the
// helper (helper.mjs) parses the PEM blocks by role and checks the file's mode, because only Node can tell a CA certificate
// from a person's and stat a mode.
import { trimTrailingSlashes } from './machine.ts';

export const CONFIG_HEADER = '# podium-reporter-config v1';
/** macOS holds a Unix socket path to 104 bytes including the terminator, Linux to 108. */
export const SOCKET_PATH_MAX = 104;

export interface ConfigHeaders {
  user: string;
  /** Always `https:`; a credential never goes over http. */
  server: string;
  /** Seconds since the epoch. */
  issuedAt: number;
  expires: string | null;
  fingerprint: string | null;
}

/** The headers of a config file, or null when it is not a v1 file, lacks a name, an https address or an issued-at time. */
export function parseConfigHeaders(text: string): ConfigHeaders | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== CONFIG_HEADER) return null;
  const h = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (!line.startsWith('#')) break;
    // `# key: value`: the name is lowercase letters and dashes up to the first colon. String methods, not one regex, so a long run of spaces cannot backtrack.
    const body = line.slice(1).trimStart();
    const colon = body.indexOf(':');
    const key = colon > 0 ? body.slice(0, colon) : '';
    if (/^[a-z-]+$/.test(key) && !h.has(key)) h.set(key, body.slice(colon + 1).trim());
  }
  const user = h.get('user');
  const server = h.get('server');
  const issuedAt = Number((h.get('issued-at') ?? '').split(/\s+/).pop());
  if (!user || !server || !Number.isFinite(issuedAt) || issuedAt <= 0) return null;
  try {
    if (new URL(server).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { user, server, issuedAt, expires: h.get('expires') || null, fingerprint: h.get('fingerprint') || null };
}

/** The epoch (seconds) a config file's name carries, `reporter-config-<name>-<epoch>.pem`; null for a name that has none. */
export function nameEpoch(base: string): number | null {
  if (!/^reporter-config-.+\.pem$/.test(base)) return null;
  const stem = base.slice(0, -'.pem'.length);
  const digits = stem.slice(stem.lastIndexOf('-') + 1);
  return /^\d+$/.test(digits) && Number.isSafeInteger(Number(digits)) ? Number(digits) : null;
}

/**
 * The config file names in the order to try them (#607): newest epoch in the name first, then names with no epoch in
 * name order. The mod reads the text of one file at a time in this order, so a private key it does not choose is never read.
 */
export function configNamesNewestFirst(names: string[]): string[] {
  const rows = names.filter((n) => /^reporter-config-.+\.pem$/.test(n)).map((name) => ({ name, epoch: nameEpoch(name) }));
  rows.sort((a, b) => (a.epoch === null ? (b.epoch === null ? 0 : 1) : b.epoch === null ? -1 : b.epoch - a.epoch) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows.map((r) => r.name);
}

/** `home` without the `/` or `\` characters at its end (a Windows home can end in a backslash). A loop, like `trimTrailingSlashes`. */
export function trimTrailingSeparators(home: string): string {
  let end = home.length;
  while (end > 0 && (home.charCodeAt(end - 1) === 47 || home.charCodeAt(end - 1) === 92)) end--;
  return home.slice(0, end);
}

/** `~/.podium/` (`%USERPROFILE%\.podium` on Windows), also podiumctl's home. */
export function podiumHome(home: string): string {
  return `${trimTrailingSeparators(home)}/.podium`;
}

/**
 * The home folder from the environment (#834): `HOME`, else `USERPROFILE`, else `HOMEDRIVE` plus `HOMEPATH`. Windows sets
 * `USERPROFILE` and normally not `HOME`. An empty value counts as unset. `from` names the variable that gave it.
 */
export function resolveHome(env: Record<string, string | undefined>): { home: string | undefined; from: string | undefined } {
  if (env.HOME) return { home: env.HOME, from: 'HOME' };
  if (env.USERPROFILE) return { home: env.USERPROFILE, from: 'USERPROFILE' };
  if (env.HOMEDRIVE && env.HOMEPATH) return { home: `${env.HOMEDRIVE}${env.HOMEPATH}`, from: 'HOMEDRIVE+HOMEPATH' };
  return { home: undefined, from: undefined };
}

/** A short, stable name for a session id: the id can be long and a socket path cannot. */
function shortId(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** A Windows path: a drive (`C:\`, `C:/`) or a UNC share (`\\server\...`). */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/**
 * The folder a Windows session's requests go through (#834): one per session inside the helper's run folder. Windows has no socket the
 * mod can reach (Node has no Unix sockets there, and the engine refuses a named-pipe address), so the mod writes each request into this
 * folder and the helper answers on its stdout.
 */
export function mailboxDirFor(runDir: string, sessionId: string): string {
  return `${trimTrailingSeparators(runDir)}/${shortId(sessionId)}`;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64 text decoded as UTF-8 (#834), written out because the sandbox a mod runs in is not promised `Buffer`, `atob` or `TextDecoder`.
 * Throws on a character outside the alphabet, a bad length, or bytes that are not UTF-8.
 */
export function decodeBase64Utf8(b64: string): string {
  const clean = b64.replace(/=+$/, '');
  if (clean.length % 4 === 1) throw new Error('bad base64 length');
  let bits = 0;
  let acc = 0;
  let escaped = '';
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('bad base64 character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      escaped += `%${((acc >> bits) & 0xff).toString(16).padStart(2, '0')}`;
      acc &= (1 << bits) - 1;
    }
  }
  return decodeURIComponent(escaped);
}

/** One socket per session inside the helper's private directory. */
export function socketPathFor(dir: string, sessionId: string): string {
  return `${trimTrailingSlashes(dir)}/${shortId(sessionId)}.sock`;
}

/** The length of a string in UTF-8 bytes: a socket path is limited in bytes, and a home folder can hold any character. */
export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}
