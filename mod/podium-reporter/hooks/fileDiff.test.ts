import { describe, test, expect } from 'claude-code/testing'
import { EMPTY_TREE, type Runner } from './git.ts'
import { readFileDiff, DIFF_LIMITS } from './fileDiff.ts'
import type { ChangedFile, FilesReport } from './protocol.ts'

const file = (path: string, status: ChangedFile['status'] = 'modified', over: Partial<ChangedFile> = {}): ChangedFile => ({ path, status, from: null, added: 1, removed: 1, ...over })
const list = (files: ChangedFile[], since: FilesReport['since'] = 'start'): FilesReport => ({ files, total: files.length, added: 1, removed: 1, since })

const HEADER = 'diff --git a/src/a.ts b/src/a.ts\nindex 111..222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n'
const BODY = '@@ -1,2 +1,2 @@\n const x = 1\n-const a = 1\n+const a = 2\n'

/** A scripted git: rev-parse, ancestor check and the diffs, recording every argv. */
function git(over: { diff?: string; exit?: number; untracked?: string; ancestor?: number; mergeBase?: string } = {}) {
  const calls: string[][] = []
  const run: Runner = async (argv) => {
    calls.push(argv)
    const a = argv.join(' ')
    if (a.endsWith('rev-parse --show-toplevel')) return { exitCode: 0, stdout: '/repo\n' }
    if (a.endsWith('rev-parse HEAD')) return { exitCode: 0, stdout: 'headheadhead\n' }
    if (a.includes('merge-base --is-ancestor')) return { exitCode: over.ancestor ?? 0, stdout: '' }
    if (a.includes('merge-base HEAD @{upstream}')) return over.mergeBase ? { exitCode: 0, stdout: over.mergeBase + '\n' } : { exitCode: 128, stdout: '' }
    if (a.includes('--no-index')) return { exitCode: 1, stdout: over.untracked ?? '' }
    if (a.includes(' diff ')) return { exitCode: over.exit ?? 0, stdout: over.diff ?? '' }
    return { exitCode: 128, stdout: '' }
  }
  return { run, calls }
}
const diffCalls = (calls: string[][]) => calls.filter((c) => c.includes('diff'))

describe('readFileDiff', () => {
  test('a modified file: the hunks only, the headers dropped, and the base named', async () => {
    const g = git({ diff: HEADER + BODY })
    const r = await readFileDiff(g.run, '/repo', 'a1b2c3d4e5f6', 'src/a.ts', list([file('src/a.ts')]))
    expect(r).toEqual({ path: 'src/a.ts', status: 'ok', text: BODY.trimEnd(), truncated: false, shownLines: 4, totalLines: 4, redactions: 0, base: 'a1b2c3d' })
    const d = diffCalls(g.calls)[0]!
    expect(d.slice(0, 3)).toEqual(['git', '-C', '/repo'])
    expect(d).toContain('a1b2c3d4e5f6')
    expect(d.slice(-2)).toEqual(['--', 'src/a.ts'])
  })

  test('a path the list does not name is unavailable, and git is not asked', async () => {
    const g = git({ diff: BODY })
    const r = await readFileDiff(g.run, '/repo', 'abc', 'other.ts', list([file('src/a.ts')]))
    expect(r.status).toBe('unavailable')
    expect(r.text).toBeNull()
    expect(diffCalls(g.calls)).toEqual([])
    expect((await readFileDiff(g.run, '/repo', 'abc', 'x', null)).status).toBe('unavailable')
  })

  test('a path that holds secrets is withheld without reading it', async () => {
    const g = git({ diff: '@@ -1 +1 @@\n-KEY=1\n+KEY=2' })
    for (const p of ['.env', 'apps/web/.env.local', 'deploy/server.pem', 'id_rsa', 'aws/credentials']) {
      const r = await readFileDiff(g.run, '/repo', 'abc', p, list([file(p)]))
      expect(r).toMatchObject({ path: p, status: 'withheld', text: null })
    }
    expect(g.calls.length).toBe(0)
  })

  test('a binary file says so', async () => {
    const g = git({ diff: 'diff --git a/l.png b/l.png\nindex 1..2 100644\nBinary files a/l.png and b/l.png differ\n' })
    const r = await readFileDiff(g.run, '/repo', 'abc', 'l.png', list([file('l.png', 'modified', { added: null, removed: null })]))
    expect(r).toMatchObject({ status: 'binary', text: null })
  })

  test('an untracked file is read against /dev/null', async () => {
    const g = git({ diff: '', untracked: 'diff --git a/n.md b/n.md\nnew file mode 100644\n--- /dev/null\n+++ b/n.md\n@@ -0,0 +1,2 @@\n+# To do\n+- write tests\n' })
    const r = await readFileDiff(g.run, '/repo', 'abc', 'n.md', list([file('n.md', 'added', { added: 2, removed: 0 })]))
    expect(r).toMatchObject({ status: 'ok', text: '@@ -0,0 +1,2 @@\n+# To do\n+- write tests', shownLines: 3 })
    expect(g.calls.some((c) => c.includes('--no-index') && c.includes('/dev/null') && c.includes('n.md'))).toBe(true)
  })

  test('a renamed file is read with both names so git pairs them', async () => {
    const g = git({ diff: 'diff --git a/o.md b/n.md\nsimilarity index 80%\nrename from o.md\nrename to n.md\n--- a/o.md\n+++ b/n.md\n@@ -1 +1 @@\n-old\n+new\n' })
    const r = await readFileDiff(g.run, '/repo', 'abc', 'n.md', list([file('n.md', 'renamed', { from: 'o.md' })]))
    expect(r.status).toBe('ok')
    const d = diffCalls(g.calls)[0]!
    expect(d).toContain('-M')
    expect(d.slice(-3)).toEqual(['--', 'o.md', 'n.md'])
  })

  test('a deleted file is its removed lines', async () => {
    const g = git({ diff: 'diff --git a/o.md b/o.md\ndeleted file mode 100644\n--- a/o.md\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n' })
    const r = await readFileDiff(g.run, '/repo', 'abc', 'o.md', list([file('o.md', 'deleted')]))
    expect(r).toMatchObject({ status: 'ok', text: '@@ -1,2 +0,0 @@\n-one\n-two' })
  })

  test('a file with no hunks (a mode change) is ok with no lines', async () => {
    const g = git({ diff: 'diff --git a/s.sh b/s.sh\nold mode 100644\nnew mode 100755\n' })
    const r = await readFileDiff(g.run, '/repo', 'abc', 's.sh', list([file('s.sh', 'modified', { added: 0, removed: 0 })]))
    expect(r).toMatchObject({ status: 'ok', text: '', shownLines: 0, totalLines: 0 })
  })

  test('a diff over 2,000 lines is cut at a line, and says how many it had', async () => {
    const lines = ['@@ -1,3000 +1,3000 @@']
    for (let i = 0; i < 2499; i++) lines.push(`+line ${i}`)
    const g = git({ diff: HEADER + lines.join('\n') + '\n' })
    const r = await readFileDiff(g.run, '/repo', 'abc', 'src/a.ts', list([file('src/a.ts')]))
    expect(r).toMatchObject({ status: 'ok', truncated: true, shownLines: DIFF_LIMITS.lines, totalLines: 2500 })
    expect(r.text!.split('\n').length).toBe(DIFF_LIMITS.lines)
    expect(r.text!.endsWith('+line 1998')).toBe(true)
  })

  test('a diff over 200,000 bytes is cut at a line', async () => {
    const lines = ['@@ -1 +1 @@']
    for (let i = 0; i < 1500; i++) lines.push('+' + 'x'.repeat(199) + String(i % 10))
    const g = git({ diff: lines.join('\n') + '\n' })
    const r = await readFileDiff(g.run, '/repo', 'abc', 'src/a.ts', list([file('src/a.ts')]))
    expect(r.truncated).toBe(true)
    expect(r.totalLines).toBe(1501)
    expect(r.shownLines < 1501).toBe(true)
    expect(r.text!.length <= DIFF_LIMITS.bytes).toBe(true)
    expect(r.text!.split('\n').every((l) => l.startsWith('@@') || l.endsWith('x') || /x\d$/.test(l))).toBe(true)
  })

  test('one very long line is cut to a readable length', async () => {
    const g = git({ diff: '@@ -1 +1 @@\n+' + 'y'.repeat(50_000) + '\n' })
    const r = await readFileDiff(g.run, '/repo', 'abc', 'src/a.ts', list([file('src/a.ts')]))
    expect(r.status).toBe('ok')
    expect(Math.max(...r.text!.split('\n').map((l) => l.length)) <= DIFF_LIMITS.lineChars + 20).toBe(true)
    expect(r.text!.includes('[line cut]')).toBe(true)
  })

  test('a long line is cut before it is redacted, and a token the cut would split is dropped whole', async () => {
    const secret = 'sk-ant-api03-' + 'A'.repeat(60)
    const line = '+' + 'y '.repeat(1998) + secret // the secret starts just before the cut
    const g = git({ diff: '@@ -1 +1 @@\n' + line + '\n' })
    const r = await readFileDiff(g.run, '/repo', 'abc', 'src/a.ts', list([file('src/a.ts')]))
    expect(r.text!.includes('sk-ant')).toBe(false)
    expect(r.text!.includes('AAAA')).toBe(false)
    expect(r.text!.endsWith('[line cut]')).toBe(true)
  })

  test('a minified line of 300,000 characters is handled quickly', async () => {
    const g = git({ diff: '@@ -1 +1 @@\n+' + 'a1b2c3d4'.repeat(40_000) + '\n' })
    const t0 = Date.now()
    const r = await readFileDiff(g.run, '/repo', 'abc', 'src/a.ts', list([file('src/a.ts')]))
    expect(Date.now() - t0 < 2000).toBe(true)
    expect(r.status).toBe('ok')
  })

  test('a file the list counts as huge, or a diff over 5 MB, is too large and not read into the report', async () => {
    const g = git({ diff: BODY })
    const huge = list([file('data.json', 'modified', { added: 300_000, removed: 10 })])
    expect(await readFileDiff(g.run, '/repo', 'abc', 'data.json', huge)).toMatchObject({ status: 'too-large', text: null })
    expect(diffCalls(g.calls)).toEqual([])
    const big = git({ diff: '@@ -1 +1 @@\n+' + 'z'.repeat(DIFF_LIMITS.readBytes + 1) })
    expect(await readFileDiff(big.run, '/repo', 'abc', 'src/a.ts', list([file('src/a.ts')]))).toMatchObject({ status: 'too-large', text: null })
  })

  test('secrets are redacted and counted, in removed lines too', async () => {
    const g = git({ diff: '@@ -1,2 +1,2 @@\n-const apiKey = "abcd1234efgh5678"\n+const apiKey = process.env.KEY\n+DB_PASSWORD=hunter2\n' })
    const r = await readFileDiff(g.run, '/repo', 'abc', 'src/a.ts', list([file('src/a.ts')]))
    expect(r.text!.includes('abcd1234efgh5678')).toBe(false)
    expect(r.text!.includes('hunter2')).toBe(false)
    expect(r.redactions).toBe(2)
  })

  test('a failing git is unavailable', async () => {
    const g = git({ diff: '', exit: 128 })
    expect((await readFileDiff(g.run, '/repo', 'abc', 'src/a.ts', list([file('src/a.ts')]))).status).toBe('unavailable')
  })

  test('the base is named for the list: the commit, the upstream merge base, the work tree, or none', async () => {
    const f = list([file('src/a.ts')])
    expect((await readFileDiff(git({ diff: BODY }).run, '/repo', 'a1b2c3d4e5', 'src/a.ts', f)).base).toBe('a1b2c3d')
    expect((await readFileDiff(git({ diff: BODY, ancestor: 1, mergeBase: 'ffeeddccbb99' }).run, '/repo', 'a1b2c3d4e5', 'src/a.ts', list([file('src/a.ts')], 'upstream'))).base).toBe('ffeeddc')
    expect((await readFileDiff(git({ diff: BODY, ancestor: 1 }).run, '/repo', 'a1b2c3d4e5', 'src/a.ts', list([file('src/a.ts')], 'worktree'))).base).toBe('worktree')
    expect((await readFileDiff(git({ diff: BODY }).run, '/repo', EMPTY_TREE, 'src/a.ts', f)).base).toBeNull()
  })
})
