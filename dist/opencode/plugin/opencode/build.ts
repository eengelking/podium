// Which build of the reporter is running (#987): a release has none, a dev build is the commit `npm run plugin:build` stamped into the
// built folder. The same rule as the Claude Code mod's (`core/build.ts`), so a report says "dev: a1b2c3d4" for either.
import { fileURLToPath } from 'node:url';
import { modBuild } from '../core/build.ts';
import type { Runner } from '../core/git.ts';

/** The built tree's root, from the URL of the entry file (`<root>/plugin/opencode/index.ts`). */
export function packageRoot(entryUrl: string): string {
  return fileURLToPath(new URL('../..', entryUrl)).replace(/\/$/, '');
}

/** The dev build of the tree at `root`, or null for a release or when nothing can be read. */
export async function buildOf(root: string, run: Runner, read: (path: string) => Promise<string | null>): Promise<string | null> {
  try {
    return await modBuild(run, root, read);
  } catch {
    return null;
  }
}
