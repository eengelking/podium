// Finding and reading the header of the reporter config file (SPEC 5.9, #577). Only the header lines are read here: the
// helper (helper.mjs) parses the PEM blocks by role and checks the file's mode, because only Node can tell a CA certificate
// from a person's and stat a mode.

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
    const m = /^#\s*([a-z-]+):\s*(.*)$/.exec(line);
    if (m?.[1] && !h.has(m[1])) h.set(m[1], (m[2] ?? '').trim());
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

export interface ConfigCandidate {
  path: string;
  text: string;
}

/** The newest `reporter-config-*.pem` by its issued-at header, whatever its name says; anything else is ignored. */
export function newestConfig(files: ConfigCandidate[]): { path: string; headers: ConfigHeaders } | null {
  let best: { path: string; headers: ConfigHeaders } | null = null;
  for (const f of files) {
    const base = f.path.slice(f.path.lastIndexOf('/') + 1);
    if (!/^reporter-config-.+\.pem$/.test(base)) continue;
    const headers = parseConfigHeaders(f.text);
    if (headers && (!best || headers.issuedAt > best.headers.issuedAt)) best = { path: f.path, headers };
  }
  return best;
}

/** `~/.podium/`, also podiumctl's home. */
export function podiumHome(home: string): string {
  return `${home.replace(/\/+$/, '')}/.podium`;
}

/** A short, stable name for a session id: the id can be long and a socket path cannot. */
function shortId(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** One socket per session inside the helper's private directory. */
export function socketPathFor(dir: string, sessionId: string): string {
  return `${dir.replace(/\/+$/, '')}/${shortId(sessionId)}.sock`;
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
