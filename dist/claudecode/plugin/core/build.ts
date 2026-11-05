// Which build of the mod is running (#400): a release has none, a dev build is the commit it was run from. An installed copy has
// no .git, so only a mod run straight from a checkout of the repository can be a dev build.
import type { Runner } from './git.ts'

/** The hash of a dev build, with `-dirty` after it for local edits; null at a clean release tag (vMAJOR.MINOR.PATCH). */
export function buildId(hash: string, tag: string, dirty: boolean): string | null {
  if (!dirty && /^v\d+\.\d+\.\d+$/.test(tag)) return null
  return dirty ? `${hash}-dirty` : hash
}

/** The build of the mod in `root` (the plugin's folder, `$.plugin.root`); null for a release, an installed copy or when git cannot say. A built folder has no .git of its own, so `read` gives the stamp the build left in it. */
export async function modBuild(run: Runner, root: string, read?: (path: string) => Promise<string | null>): Promise<string | null> {
  const git = (...args: string[]) => run(['git', '-C', root, ...args])
  try {
    // The folder must be a tracked part of a repository: a mod copied under some other repo (a home directory kept in git) is no dev build.
    if ((await git('ls-files', '--error-unmatch', '.claude-plugin/plugin.json')).exitCode !== 0) return read ? await stampedBuild(read, root) : null
    const head = await git('rev-parse', '--short=8', 'HEAD')
    const hash = head.stdout.trim()
    if (head.exitCode !== 0 || !hash) return null
    const tag = await git('describe', '--exact-match', '--tags', 'HEAD')
    const status = await git('status', '--porcelain', '--', '.')
    return buildId(hash, tag.exitCode === 0 ? tag.stdout.trim() : '', status.exitCode === 0 && status.stdout.trim() !== '')
  } catch {
    return null
  }
}

/** The build a dev build step stamped into the folder (npm run plugin:build, #927): the folder is built and untracked, so git cannot say. Null when there is no readable stamp. */
async function stampedBuild(read: (path: string) => Promise<string | null>, root: string): Promise<string | null> {
  try {
    const text = await read(`${root}/.claude-plugin/dev-build.json`)
    if (!text) return null
    const s = JSON.parse(text) as { commit?: unknown; tag?: unknown; dirty?: unknown }
    if (typeof s.commit !== 'string' || !s.commit) return null
    return buildId(s.commit, typeof s.tag === 'string' ? s.tag : '', s.dirty === true)
  } catch {
    return null
  }
}

/** `podium v1.1.0` with `| dev: a1b2c3d4` after it for a dev build. */
export function withBuild(version: string, build: string | null | undefined): string {
  return build ? `${version} | dev: ${build}` : version
}
