// Reading one file's diff on request (SPEC 6.4, "File diff", #319). `readFileDiff` runs git through the injected runner
// and returns what the mod sends back: redacted, cut to the limits, against the same base the Files list counts from.
// Nothing is read for a path the list does not name, and nothing for a path that usually holds secrets.
import { EMPTY_TREE, resolveRef, type Runner } from './git.ts'
import { redactDiff, withheldPath } from './diffRedact.ts'
import type { FileDiffReply, FilesReport } from './protocol.ts'

export const DIFF_LIMITS = {
  /** Lines and bytes sent; more is cut at a line boundary. Bytes of `git diff` read before it answers `too-large`. The server holds the same numbers (FILE_DIFF_LIMITS). */
  lines: 2000,
  bytes: 200_000,
  readBytes: 5_000_000,
  /** A single line is cut to this many characters, so one minified file cannot fill the diff. */
  lineChars: 4000,
  /** A file the list counts at more changed lines than this is not read at all. */
  countedLines: 200_000,
} as const

const LINE_CUT = ' … [line cut]'

const reply = (path: string, status: FileDiffReply['status'], over: Partial<FileDiffReply> = {}): FileDiffReply => ({
  path,
  status,
  text: null,
  truncated: false,
  shownLines: 0,
  totalLines: 0,
  redactions: 0,
  base: null,
  ...over,
})

/** The UTF-8 length of a string (no Buffer in the hooks sandbox). */
function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** The hunks of a `git diff`: everything from the first `@@`. The file headers say nothing the console shows. */
function hunksOf(out: string): string {
  const at = out.startsWith('@@') ? 0 : out.indexOf('\n@@')
  if (at < 0) return ''
  let end = out.length
  while (end > 0 && out[end - 1] === '\n') end--
  return out.slice(at === 0 ? 0 : at + 1, end)
}

const TOKEN_CHAR = /[A-Za-z0-9+/_=~.-]/

/** `s` without the run of token characters at its end: a token a cut may have split is dropped whole. */
function dropTrailingToken(s: string): string {
  let end = s.length
  while (end > 0 && TOKEN_CHAR.test(s[end - 1]!)) end--
  return s.slice(0, end)
}

const isBinary = (out: string): boolean => out.split('\n').some((l) => l.startsWith('Binary files ') && l.endsWith(' differ')) || out.includes('\nGIT binary patch')

/**
 * The diff of `path`, which must be one the Files list names. `base` is the starting commit the mod keeps for the
 * session. Never throws: a failing git answers `unavailable`.
 */
export async function readFileDiff(run: Runner, cwd: string, base: string | null, path: string, files: FilesReport | null): Promise<FileDiffReply> {
  const entry = files?.files.find((f) => f.path === path)
  if (!entry) return reply(path, 'unavailable')
  if (withheldPath(path)) return reply(path, 'withheld')
  if ((entry.added ?? 0) + (entry.removed ?? 0) > DIFF_LIMITS.countedLines) return reply(path, 'too-large')
  try {
    const top = (await run(['git', 'rev-parse', '--show-toplevel'])).stdout.trim() || cwd
    const headRes = await run(['git', '-C', top, 'rev-parse', 'HEAD'])
    const head = headRes.exitCode === 0 ? headRes.stdout.trim() : null
    const start = base ?? head ?? EMPTY_TREE
    const { ref, since } = await resolveRef(run, top, start, head)
    const label = since === 'worktree' ? 'worktree' : ref === EMPTY_TREE ? null : ref.slice(0, 7)
    const paths = entry.status === 'renamed' && entry.from ? [entry.from, path] : [path]
    const git = (...args: string[]) => ['git', '-C', top, ...args]
    let res = await run(git('diff', '--no-color', '--no-ext-diff', '-M', ref, '--', ...paths))
    if (res.exitCode !== 0) return reply(path, 'unavailable')
    // A file git does not track yet has no diff against the base: read it against nothing.
    if (!res.stdout.trim() && entry.status === 'added') {
      res = await run(git('diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', path))
      if (res.exitCode !== 0 && res.exitCode !== 1) return reply(path, 'unavailable')
    }
    if (res.stdout.length > DIFF_LIMITS.readBytes) return reply(path, 'too-large')
    if (isBinary(res.stdout)) return reply(path, 'binary')
    const all = hunksOf(res.stdout)
    const lines = all === '' ? [] : all.split('\n')
    const kept: string[] = []
    let bytes = 0
    for (const line of lines) {
      const cost = Math.min(utf8Length(line), DIFF_LIMITS.lineChars) + 1
      if (kept.length >= DIFF_LIMITS.lines || bytes + cost > DIFF_LIMITS.bytes) break
      kept.push(line)
      bytes += cost
    }
    // Cut long lines before redacting: the keyed-value pattern is quadratic on a long unbroken run (a minified file).
    // A token the cut may have split is dropped back to its start, so half a secret is never left for the rules to miss.
    const cutAt = new Set<number>()
    const shortened = kept.map((l, i) => {
      if (l.length <= DIFF_LIMITS.lineChars) return l
      cutAt.add(i)
      return dropTrailingToken(l.slice(0, DIFF_LIMITS.lineChars))
    })
    const red = redactDiff(shortened.join('\n'))
    const text = red.text
      .split('\n')
      .map((l, i) => (cutAt.has(i) ? l + LINE_CUT : l.length > DIFF_LIMITS.lineChars ? l.slice(0, DIFF_LIMITS.lineChars) + LINE_CUT : l))
      .join('\n')
    return reply(path, 'ok', { text, truncated: kept.length < lines.length, shownLines: kept.length, totalLines: lines.length, redactions: red.redactions, base: label })
  } catch {
    return reply(path, 'unavailable')
  }
}
