// What a log line may carry (#140). The logger takes flat, named fields and never a request or report body, and
// this module is the backstop: a field whose name says it holds a credential or text a person typed is dropped,
// and every string has person tokens and the admin secret replaced, control characters removed and a length cap.
export type FieldValue = string | number | boolean | null | undefined;
export type Fields = Record<string, FieldValue>;

/**
 * Words that make a field name refused: credentials, and prompt, answer, activity and other free text from a
 * session. A name is split into words at `_`, `.`, `-` and camelCase, so `x_podium_token` and `promptText` are
 * refused and `context_pct` is not.
 */
const DENIED = new Set([
  'token', 'secret', 'password', 'passwd', 'authorization', 'authorisation', 'cookie', 'credential', 'credentials', 'apikey', 'key',
  'prompt', 'answer', 'activity', 'excerpt', 'body', 'text', 'header', 'headers',
]);

/** A person token anywhere in a string (tokens.ts checks the exact form; this also catches one inside other text). */
const PERSON_TOKEN = /pdm_[0-9a-f]{12}_[0-9a-f]{16,}/gi;

/** Longest string value kept, in characters. */
export const MAX_VALUE = 500;

/** A secret shorter than this is not scrubbed: it would match ordinary text, and an empty one means auth is off. */
const MIN_SECRET = 8;

export const REDACTED = '[redacted]';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** A `Bearer` or `Basic` credential, only after an Authorization-style header or when it looks like a credential. */
const AUTH_SCHEME = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/g;

/**
 * A secret-named key and its value: `password=x`, `x-api-key=x`, `"token": "x"`. A bare `key: value` in prose is
 * left alone (a colon counts only when the key is quoted, as in JSON), and so is a name that merely contains one
 * of these words (`token_count`, `tokens`). The part of the key before the word is bounded (40 characters), so a long run of
 * word characters, dots and dashes is read in linear time: with an open-ended prefix a text of `a.a.a.…` backtracked from every
 * start and 60,000 characters took seconds (#1051).
 */
const SECRET_HEAD = String.raw`((?:["']?)[\w.-]{0,40}(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(?:["']?)\s*)(=\s*|(?<=["'])\s*:\s*)`;
const SECRET_ASSIGNMENT = new RegExp(`${SECRET_HEAD}("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s&,;"'}\\])]+)`, 'gi');

/** The head of a quoted secret value, up to and including its opening quote, and the whole quoted value from that quote (#1064). */
const SECRET_QUOTE_OPEN = new RegExp(`${SECRET_HEAD}(?=["'])`, 'gi');
const QUOTED_VALUE = /"(?:[^"\\]|\\.)*"|'[^']*'/y;

/** URL userinfo: the `user:pass@` in `https://user:pass@host/`. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

/** Well-known key formats: Anthropic/OpenAI `sk-`, GitHub, AWS access key id, Slack, and JWTs. */
const KEY_FORMATS = new RegExp(
  [
    String.raw`\bsk-[A-Za-z0-9_-]{16,}`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
    String.raw`\bAKIA[0-9A-Z]{16}\b`,
    String.raw`\bxox[bap]-[A-Za-z0-9-]{10,}`,
    String.raw`\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+`,
  ].join('|'),
  'g',
);

/** How much of a string the pattern pass reads: well past MAX_VALUE, so redactions still leave a full-length line. */
const PATTERN_WINDOW = 4000;

/** A value that is plainly not a secret: a number, a boolean, null, or an earlier redaction. */
const HARMLESS_VALUE = /^(?:\d+|true|false|null|undefined|\[redacted\])$/i;

/** True when a token after `Bearer` or `Basic` is credential-shaped rather than an English word. */
function credentialShaped(tok: string): boolean {
  return /\d/.test(tok) || /[._~+/=-]/.test(tok) || /[A-Z]/.test(tok.slice(1));
}

/** One pattern pass: the regex and what a match becomes. A match is the exec result (`m[0]` whole, `m[1]`… groups). */
type Pass = readonly [RegExp, (m: readonly string[]) => string, ((slice: string, limit: number) => boolean)?];

/**
 * True when a quoted secret value starts before `limit` in `slice` and its closing quote is not in `slice`. The assignment pattern does not
 * match such a value at all, so nothing reaches the end of the slice to widen it, and a long value would go unredacted (#1064).
 */
function quoteUnclosed(slice: string, limit: number): boolean {
  SECRET_QUOTE_OPEN.lastIndex = 0;
  for (let h = SECRET_QUOTE_OPEN.exec(slice); h && h.index < limit; h = SECRET_QUOTE_OPEN.exec(slice)) {
    QUOTED_VALUE.lastIndex = h.index + h[0].length;
    if (!QUOTED_VALUE.test(slice)) return true;
    SECRET_QUOTE_OPEN.lastIndex = Math.max(SECRET_QUOTE_OPEN.lastIndex, QUOTED_VALUE.lastIndex);
  }
  return false;
}

/** The passes of `scrubPatterns`, in order. */
const PASSES: readonly Pass[] = [
  [URL_USERINFO, (m) => `${m[1]}${REDACTED}@`],
  [KEY_FORMATS, () => REDACTED],
  [AUTH_SCHEME, (m) => (credentialShaped(m[3]) ? `${m[1]}${m[2]}${REDACTED}` : m[0])],
  [
    SECRET_ASSIGNMENT,
    (m) => {
      const bare = m[3].replace(/^["']|["']$/g, '');
      return HARMLESS_VALUE.test(bare) ? m[0] : `${m[1]}${m[2]}${REDACTED}`;
    },
    quoteUnclosed,
  ],
];

/** Replace common secret shapes with `[redacted]`. Conservative: ordinary text, ids, paths and numbers pass. */
function scrubPatterns(value: string): string {
  let out = value;
  for (const [re, fn] of PASSES) out = out.replace(re, (...a) => fn(a as string[]));
  return out;
}

export function scrub(value: string, secrets: readonly string[]): string {
  let out = value.replace(PERSON_TOKEN, REDACTED);
  for (const s of secrets) {
    if (s && s.length >= MIN_SECRET) out = out.split(s).join(REDACTED);
  }
  // The result is cut to MAX_VALUE below and redaction only shortens a string, so look at a bounded window: the
  // assignment pattern backtracks, and an error body of 100k characters would otherwise stall the event loop.
  if (out.length > PATTERN_WINDOW) out = out.slice(0, PATTERN_WINDOW);
  out = scrubPatterns(out);
  out = out.replace(CONTROL, ' ');
  return out.length > MAX_VALUE ? `${out.slice(0, MAX_VALUE - 1)}…` : out;
}

/**
 * Text the server stores whole (a session recording, #353): Podium's own credentials are replaced, with line breaks and length
 * kept. `patterns` also replaces the common secret shapes; it is for text the server wrote itself, which the mod never saw to
 * redact. The patterns backtrack, so the caller bounds the text it passes with `patterns` on.
 */
export function scrubStored(value: string, secrets: readonly string[], patterns: boolean): string {
  let out = value.replace(PERSON_TOKEN, REDACTED);
  for (const s of secrets) {
    if (s && s.length >= MIN_SECRET) out = out.split(s).join(REDACTED);
  }
  return patterns ? scrubPatternsWindowed(out) : out;
}

/** How much of a stored text the patterns read at once. */
const STORED_WINDOW = 8000;

/** How far past a window a match may reach before the window is widened (doubling), see `replaceWindowed`. */
const STORED_LOOKAHEAD = 500;

/**
 * One pass over a long text, a window at a time, so no regex run reads more than about STORED_WINDOW + the lookahead characters. A window
 * accepts only matches that START in its first STORED_WINDOW characters, and the next window starts where the last accepted match ended
 * (or at STORED_WINDOW), so a match is never split between two windows. A match that reaches the end of the slice may be cut short, so the
 * slice is widened (the lookahead doubles, which keeps the total linear) until the match ends inside it; so is a slice with a quoted value
 * that opens in the window and is not closed in the slice, which the pattern does not match at all (#1064). Same result as one pass over the whole text.
 */
function replaceWindowed(value: string, [re, fn, unclosed]: Pass): string {
  if (value.length <= STORED_WINDOW) return value.replace(re, (...a) => fn(a as string[]));
  let out = '';
  for (let at = 0; at < value.length; ) {
    let look = STORED_LOOKAHEAD;
    for (;;) {
      const end = Math.min(at + STORED_WINDOW + look, value.length);
      const final = end === value.length;
      const s = value.slice(at, end);
      let acc = '';
      let used = 0;
      let widen = false;
      re.lastIndex = 0;
      for (let m = re.exec(s); m; m = re.exec(s)) {
        if (!final && m.index >= STORED_WINDOW) break;
        if (!final && m.index + m[0].length >= s.length) {
          widen = true;
          break;
        }
        acc += s.slice(used, m.index) + fn(m);
        used = m.index + m[0].length;
      }
      if (!final && !widen && unclosed?.(s, STORED_WINDOW)) widen = true;
      if (widen) {
        look *= 2;
        continue;
      }
      const next = final ? s.length : Math.max(STORED_WINDOW, used);
      out += acc + s.slice(used, next);
      at += next;
      break;
    }
  }
  return out;
}

/** `scrubPatterns` over a long text, pass by pass in windows that never split a match (#1051). */
function scrubPatternsWindowed(value: string): string {
  let out = value;
  for (const pass of PASSES) out = replaceWindowed(out, pass);
  return out;
}

/** True for a field name the logger refuses whatever its value. */
export function deniedField(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_.-]+/);
  return words.some((w) => DENIED.has(w));
}

/** Flat, safe fields: denied names, nested values and non-finite numbers dropped; strings scrubbed. */
export function cleanFields(fields: Fields | undefined, secrets: readonly string[]): Fields {
  const out: Fields = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/.test(k) || deniedField(k)) continue;
    if (typeof v === 'string') out[k] = scrub(v, secrets);
    else if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}
