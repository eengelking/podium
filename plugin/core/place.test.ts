import { describe, expect, it } from 'vitest';
import type { Runner } from './git.ts';
import { gitPlace, repoFromRemote } from './place.ts';

describe('repoFromRemote', () => {
  it('reads owner/name from ssh and https origins, with or without .git', () => {
    expect(repoFromRemote('git@github.com:acme/app.git')).toBe('acme/app');
    expect(repoFromRemote('https://github.com/acme/app')).toBe('acme/app');
    expect(repoFromRemote('https://github.com/acme/app.git/\n')).toBe('acme/app');
  });
  it('gives null for nothing or for text that is no remote', () => {
    expect(repoFromRemote(null)).toBeNull();
    expect(repoFromRemote(undefined)).toBeNull();
    expect(repoFromRemote('')).toBeNull();
    expect(repoFromRemote('app')).toBeNull();
  });
});

const runner = (answers: Record<string, string>): Runner => async (argv) => {
  const out = answers[argv.join(' ')];
  return out === undefined ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: out };
};

describe('gitPlace', () => {
  it('is the parent of the git common dir, so a worktree reports its main checkout, and owner/name from origin', async () => {
    const run = runner({
      'git rev-parse --path-format=absolute --git-common-dir': '/work/app/.git\n',
      'git config --get remote.origin.url': 'git@github.com:acme/app.git\n',
    });
    expect(await gitPlace(run, '/work/app/.claude/worktrees/x')).toEqual({ projectRoot: '/work/app', repoName: 'acme/app' });
  });
  it('uses the folder name when there is no origin', async () => {
    const run = runner({ 'git rev-parse --path-format=absolute --git-common-dir': '/work/app/.git' });
    expect(await gitPlace(run, '/work/app')).toEqual({ projectRoot: '/work/app', repoName: 'app' });
  });
  it('uses a bare repository folder as it is, without the trailing slash', async () => {
    const run = runner({ 'git rev-parse --path-format=absolute --git-common-dir': '/srv/app.git/' });
    expect(await gitPlace(run, '/srv/app.git')).toEqual({ projectRoot: '/srv/app.git', repoName: 'app.git' });
  });
  it('falls back to the directory itself outside a repository', async () => {
    expect(await gitPlace(runner({}), '/tmp/scratch')).toEqual({ projectRoot: '/tmp/scratch', repoName: 'scratch' });
  });
});
