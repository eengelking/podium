import { describe, expect, it } from 'vitest';
import type { Runner } from '../core/git.ts';
import { buildOf, packageRoot } from './build.ts';

const noGit: Runner = async () => ({ exitCode: 1, stdout: '' });

describe('the dev-build stamp (#987)', () => {
  it('finds the package folder two levels above the entry file, as the built tree lays it out', () => {
    expect(packageRoot('file:///home/me/podium/dist-dev/opencode/plugin/opencode/index.ts')).toBe('/home/me/podium/dist-dev/opencode');
  });
  it('is the commit a dev build step stamped, with -dirty for local edits', async () => {
    const read = async (path: string) => (path === '/b/.claude-plugin/dev-build.json' ? JSON.stringify({ commit: 'a1b2c3d4', tag: '', dirty: true }) : null);
    expect(await buildOf('/b', noGit, read)).toBe('a1b2c3d4-dirty');
  });
  it('is nothing for a release (no stamp), for a stamp at a clean release tag, and when the file cannot be read', async () => {
    expect(await buildOf('/b', noGit, async () => null)).toBeNull();
    expect(await buildOf('/b', noGit, async () => JSON.stringify({ commit: 'a1b2c3d4', tag: 'v1.5.0', dirty: false }))).toBeNull();
    expect(await buildOf('/b', noGit, async () => { throw new Error('denied'); })).toBeNull();
  });
});
