// Redaction for a file's diff (SPEC 6.4, "File diff"). Pure: no `$` here.
//
// A diff can show any file, so this goes further than the activity feed's rule in failures.ts: it knows many token
// shapes, private key blocks, credentials in URLs, auth headers, keys named like a secret, and long random-looking
// values. It runs on the machine before the text is sent, on removed and context lines as well as added ones. A
// value becomes `[redacted]` and the rest of the line stays. It is best effort: a secret can take any shape.

const MARK = '[redacted]'

/** A file whose diff is never read: it usually holds secrets. Matched on the last path segment. */
export function withheldPath(path: string): boolean {
  const base = (path.split('/').pop() ?? '').toLowerCase()
  return /^\.env($|\.)/.test(base) || /\.(pem|key|p12|pfx)$/.test(base) || /^id_(rsa|ed25519|ecdsa|dsa)/.test(base) || base === '.npmrc' || base === '.netrc' || base.startsWith('credentials')
}

interface Count {
  n: number
}
const mark = (c: Count): string => {
  c.n++
  return MARK
}

// Token shapes. Each match is replaced whole.
const SHAPES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /(?<![A-Za-z0-9])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}/g,
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bSK[0-9a-f]{32}\b/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{3,}/g,
]
// A shape that keeps its label: `Bearer abc...`, `Basic dXNl...`, `AccountKey=...`.
const LABELLED: RegExp[] = [
  /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g,
  /(\bBasic\s+)(?=[A-Za-z+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/g,
  /(AccountKey=)[A-Za-z0-9+/=]{20,}/g,
  /(SharedAccessKey=)[^;\s"']+/g,
]

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`]+:)([^\s/@"'`]+)(@)/gi
const HEADER = /\b((?:proxy-)?authorization|set-cookie|cookie|x-api-key|x-auth-token|x-access-token)(["']?\s*[:=]\s*["']?)([^"'\n]+)/gi
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/
const PEM_INLINE = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g
const PEM_INLINE_ONCE = new RegExp(PEM_INLINE.source)
const PEM_END = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/

const KEYWORD = 'password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|salt|auth(?:[_-]?token)?'
// prefix, keyword, suffix, then an optional `?`/`!`, an optional quote, the operator, and the value (quoted or bare).
const KEYED = new RegExp(`([A-Za-z0-9_.-]*?)(${KEYWORD})([A-Za-z0-9_.-]*)([?!]?["'\\]]?\\s*(?::=|=|:)\\s*)("[^"]*"|'[^']*'|\`[^\`]*\`|[^\\s"'\`,;&)}\\]]+)`, 'gi')
const FLAG = /(--(?:password|passwd|pass|token|secret|api-?key|auth(?:-token)?|access-key|client-secret)(?:=|\s+))([^\s$<-]\S*)/gi
const MYSQL = /\b(mysql|mysqldump|mariadb)\b([^\n]*?\s-p)([^\s]+)/g
const SSHPASS = /(\bsshpass\b[^\n]*?\s-p\s*)(\S+)/g

const TYPE_WORDS = /^(?:true|false|null|undefined|nil|none|string|number|boolean|any|unknown|void|object|never|bigint|symbol)$/i
const PLACEHOLDER = /^(?:<.*>|\{.*\}|\$.*|%.*%|x{3,}|\*+|\.{3}|your[-_ ].*|process\.env.*|env\..*)$/i

/** A value that stands for a secret rather than being one: a reference, a type, a placeholder. */
function looksLikeReference(value: string, quoted: boolean): boolean {
  if (value.includes(MARK) || value.includes('${') || value.includes('{{')) return true
  if (PLACEHOLDER.test(value) || TYPE_WORDS.test(value)) return true
  if (quoted) return false
  if (/[().<[{]/.test(value)) return true
  if (/^[a-z]+[A-Z][A-Za-z]*$/.test(value)) return true // camelCase: a variable
  if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(value)) return true // CONSTANT_NAME
  if (/^[A-Z][a-z]+(?:[A-Z][a-z]+)*$/.test(value)) return true // PascalCase: a type
  return false
}

function keyed(text: string, c: Count): string {
  return text.replaceAll(KEYED, (whole, _prefix: string, _kw: string, suffix: string, op: string, value: string) => {
    // `author`, `authority`, `tokens`, `passwords`: the keyword is only the start of a longer, ordinary word.
    if (suffix && /^[a-z0-9]/.test(suffix)) return whole
    const quoted = /^["'`]/.test(value)
    const inner = quoted ? value.slice(1, -1) : value
    if (inner.length < 4 || looksLikeReference(inner, quoted)) return whole
    const q = quoted ? value[0]! : ''
    return `${whole.slice(0, whole.length - value.length)}${q}${mark(c)}${q}`
  })
}

function entropy(s: string): number {
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

const LONG_VALUE = /[A-Za-z0-9+/_=~-]{24,}/g
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function randomLooking(t: string): boolean {
  if (/^sha\d+-/.test(t) || UUID.test(t)) return false
  if (/^[./~]/.test(t)) return false
  if (/^[0-9a-f]+$/i.test(t)) return t.length >= 32 && t.length !== 40 && t.length !== 64 && entropy(t) >= 3
  const classes = (/[a-z]/.test(t) ? 1 : 0) + (/[A-Z]/.test(t) ? 1 : 0) + (/[0-9]/.test(t) ? 1 : 0)
  if (classes < 2) return false
  const h = entropy(t)
  if (/[0-9]/.test(t)) return h >= 4
  return t.length >= 40 && h >= 4.3
}

function longValues(text: string, c: Count): string {
  if (/integrity/i.test(text)) return text
  return text.replaceAll(LONG_VALUE, (t) => (randomLooking(t) ? mark(c) : t))
}

/** One line's content, without the diff prefix. */
function redactContent(content: string, c: Count): string {
  let s = content
  s = s.replaceAll(PEM_INLINE, () => mark(c))
  s = s.replaceAll(URL_CREDENTIALS, (_m, head: string, pass: string, at: string) => (pass === MARK ? _m : `${head}${mark(c)}${at}`))
  s = s.replaceAll(HEADER, (whole, name: string, sep: string, value: string) => (/\$|\{\{|\[redacted\]/.test(value) ? whole : `${name}${sep}${mark(c)}`))
  for (const re of SHAPES) s = s.replaceAll(re, () => mark(c))
  for (const re of LABELLED) s = s.replaceAll(re, (_m, label: string) => `${label}${mark(c)}`)
  s = s.replaceAll(FLAG, (_m, head: string) => `${head}${mark(c)}`)
  s = s.replaceAll(MYSQL, (_m, cmd: string, mid: string) => `${cmd}${mid}${mark(c)}`)
  s = s.replaceAll(SSHPASS, (_m, head: string) => `${head}${mark(c)}`)
  s = keyed(s, c)
  return longValues(s, c)
}

export interface Redacted {
  text: string
  /** How many values were replaced. A private key block counts once. */
  redactions: number
}

/** Redacts a unified diff: hunk header context, and every context, added and removed line. Line breaks are kept. */
export function redactDiff(diff: string): Redacted {
  const c: Count = { n: 0 }
  let inKey = false
  const out = diff.split('\n').map((line) => {
    if (line.startsWith('@@')) {
      inKey = false; // a hunk ends any key block that was cut off in it
      const end = line.indexOf('@@', 2)
      return end < 0 ? line : line.slice(0, end + 2) + redactContent(line.slice(end + 2), c)
    }
    const p = line[0]
    if (p !== ' ' && p !== '+' && p !== '-') return line
    const content = line.slice(1)
    if (inKey) {
      if (PEM_END.test(content)) inKey = false
      return p + MARK
    }
    if (PEM_BEGIN.test(content) && !PEM_INLINE_ONCE.test(content)) {
      inKey = true
      return p + content.slice(0, content.search(PEM_BEGIN)) + mark(c)
    }
    return p + redactContent(content, c)
  })
  return { text: out.join('\n'), redactions: c.n }
}
