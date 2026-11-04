// Where a session works, from git alone (#987): the project root and `owner/name`. Shared by the reporters; Claude Code's mod
// asks its engine first (`hooks/place.ts`) and falls back to this, and the OpenCode reporter, whose API holds neither, uses it as it is.
import { lastSegment, type Runner } from './git.ts';

export interface Place {
  projectRoot: string;
  repoName: string;
}

/** `owner/name` from an origin URL (`git@github.com:o/n.git`, `https://host/o/n`). */
export function repoFromRemote(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The project root and repository name for `cwd`, with git run in `cwd`: the parent of the common git dir (so a worktree reports its main
 * checkout) and the origin remote, else the folder itself.
 */
export async function gitPlace(run: Runner, cwd: string): Promise<Place> {
  const git = async (argv: string[]) => {
    const res = await run(argv);
    return res.exitCode === 0 ? res.stdout.trim() : '';
  };
  const common = await git(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const dir = common.endsWith('/') ? common.slice(0, -1) : common;
  // A submodule's git dir is under the superproject's (`<super>/.git/modules/<name>`): its own top level is the root, not the superproject.
  const projectRoot = dir.includes('/.git/modules/') ? (await git(['git', 'rev-parse', '--show-toplevel'])) || cwd : dir.endsWith('/.git') ? dir.slice(0, -'/.git'.length) : dir || cwd;
  return { projectRoot, repoName: repoFromRemote(await git(['git', 'config', '--get', 'remote.origin.url'])) ?? lastSegment(projectRoot) };
}
