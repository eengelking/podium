// Finding and reading the header of the reporter config file (SPEC 5.9, #577). Only the header lines are read here: the
// helper (helper.mjs) parses the PEM blocks by role and checks the file's mode, because only Node can tell a CA certificate
// from a person's and stat a mode.
// What stays here is the Claude reporter's own: the socket and mailbox workaround for the helper process. The config file's headers, names and
// home folder are shared by every reporter and live in plugin/core/tls/reporterConfig.ts.
import { trimTrailingSlashes } from '../../core/machine.ts';
import { trimTrailingSeparators } from '../../core/tls/reporterConfig.ts';

/** macOS holds a Unix socket path to 104 bytes including the terminator, Linux to 108. */
export const SOCKET_PATH_MAX = 104;

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
  // A loop, not `/=+$/`, which backtracks super-linearly on a long run of `=`.
  let end = b64.length;
  while (end > 0 && b64.charCodeAt(end - 1) === 61) end--;
  const clean = b64.slice(0, end);
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
