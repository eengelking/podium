// The reporter's place logic (#382) is pure, so it is tested here: the mod's own tests run only inside Claude Code,
// where neither the server's coverage run nor SonarCloud can see them.
import { describe, it, expect } from 'vitest';
import { follow, holds, nextCwd, placeOf, type PlaceEngine, type SessionPlace } from '../mod/podium-reporter/hooks/place.ts';
import type { Runner } from '../mod/podium-reporter/hooks/git.ts';

const SPARE = '/Users/dev/.claude/spares/spare-eB3Cs1';
const PROJECT = '/Users/dev/web/podium';

/** A runner that answers by the git arguments, and fails for any it was not given. */
const git =
  (answers: Record<string, string>): Runner =>
  async (argv) => {
    const out = answers[argv.slice(1).join(' ')];
    return { exitCode: out === undefined ? 128 : 0, stdout: out ?? '' };
  };

const COMMON = 'rev-parse --path-format=absolute --git-common-dir';
const REMOTE = 'config --get remote.origin.url';

describe('holds', () => {
  it('is true for the folder and anything inside it, never a sibling that shares a prefix', () => {
    expect(holds('/a/b', '/a/b')).toBe(true);
    expect(holds('/a/b', '/a/b/c')).toBe(true);
    expect(holds('/a/b/', '/a/b/c')).toBe(true);
    expect(holds('/a/b', '/a/bc')).toBe(false);
    expect(holds('/a/b', '/a')).toBe(false);
  });

  it('is false without a folder', () => {
    expect(holds(null, '/a')).toBe(false);
    expect(holds(undefined, '/a')).toBe(false);
    expect(holds('', '/a')).toBe(false);
  });
});

describe('nextCwd', () => {
  const base = { seen: SPARE, lastSeen: SPARE, current: SPARE, projectRoot: SPARE };

  it('stays put with no hook and a $.session answer that has not changed', () => {
    expect(nextCwd(base)).toBe(SPARE);
    expect(nextCwd({ ...base, seen: null, lastSeen: null })).toBe(SPARE);
  });

  it('takes a $.session answer once it changes', () => {
    expect(nextCwd({ ...base, seen: PROJECT })).toBe(PROJECT);
  });

  it("takes a hook's cwd while $.session still answers the old folder, and keeps it on the polls after", () => {
    expect(nextCwd({ ...base, hookCwd: PROJECT })).toBe(PROJECT);
    expect(nextCwd({ ...base, current: PROJECT, projectRoot: PROJECT })).toBe(PROJECT);
  });

  it('prefers the hook when both moved', () => {
    expect(nextCwd({ ...base, seen: '/x', hookCwd: PROJECT })).toBe(PROJECT);
  });

  it('does not count a cd into a subfolder of the reported place as a move', () => {
    const at = { seen: PROJECT, lastSeen: PROJECT, current: `${PROJECT}/src`, projectRoot: PROJECT };
    expect(nextCwd({ ...at, hookCwd: `${PROJECT}/src/deep` })).toBe(`${PROJECT}/src`);
    expect(nextCwd({ ...at, current: PROJECT, hookCwd: `${PROJECT}/src` })).toBe(PROJECT);
  });
});

describe('placeOf', () => {
  const none = git({});

  it('uses $.session while the repository root holds the folder', async () => {
    const session: SessionPlace = { root: PROJECT, repo: { root: PROJECT, remote: 'git@github.com:acme/podium.git', name: null } };
    expect(await placeOf(session, PROJECT, none)).toEqual({ projectRoot: PROJECT, repoName: 'acme/podium' });
  });

  it("prefers the repository's own name, then its folder", async () => {
    const named: SessionPlace = { root: PROJECT, repo: { root: PROJECT, remote: null, name: 'Podium' } };
    expect(await placeOf(named, PROJECT, none)).toEqual({ projectRoot: PROJECT, repoName: 'Podium' });
    const bare: SessionPlace = { root: PROJECT, repo: null };
    expect(await placeOf(bare, `${PROJECT}/src`, none)).toEqual({ projectRoot: PROJECT, repoName: 'podium' });
  });

  it("asks git when $.session's place does not hold the folder", async () => {
    const stale: SessionPlace = { root: SPARE, repo: null };
    const run = git({ [COMMON]: `${PROJECT}/.git\n`, [REMOTE]: 'git@github.com:acme/podium.git\n' });
    expect(await placeOf(stale, PROJECT, run)).toEqual({ projectRoot: PROJECT, repoName: 'acme/podium' });
  });

  it('names the project folder when the repository has no origin remote', async () => {
    const stale: SessionPlace = { root: null, repo: null };
    expect(await placeOf(stale, PROJECT, git({ [COMMON]: `${PROJECT}/.git/` }))).toEqual({ projectRoot: PROJECT, repoName: 'podium' });
  });

  it("takes a worktree's main repository, because the common dir is the shared one", async () => {
    const stale: SessionPlace = { root: SPARE, repo: null };
    const run = git({ [COMMON]: '/Users/dev/web/podium/.git', [REMOTE]: 'https://github.com/acme/podium' });
    expect(await placeOf(stale, '/Users/dev/web/podium/.claude/worktrees/x', run)).toEqual({ projectRoot: PROJECT, repoName: 'acme/podium' });
  });

  it('falls back to the folder when it is not a repository', async () => {
    const stale: SessionPlace = { root: SPARE, repo: null };
    expect(await placeOf(stale, '/Users/dev/notes', none)).toEqual({ projectRoot: '/Users/dev/notes', repoName: 'notes' });
  });

  it('keeps a common dir that is not named .git as the root', async () => {
    const stale: SessionPlace = { root: SPARE, repo: null };
    expect(await placeOf(stale, '/srv/repo.git', git({ [COMMON]: '/srv/repo.git' }))).toEqual({ projectRoot: '/srv/repo.git', repoName: 'repo.git' });
  });
});

describe('follow', () => {
  /** A `$` whose session answers `at`, and whose git answers `answers`; a field set to an Error throws it. */
  const engine = (at: { cwd: string | Error; root: string | Error; repo: SessionPlace['repo'] | Error }, answers: Record<string, string> | Error = {}): PlaceEngine => {
    const answer = <T>(v: T | Error) => async () => {
      if (v instanceof Error) throw v;
      return v;
    };
    return {
      session: { cwd: answer(at.cwd), root: answer(at.root), repo: answer(at.repo) },
      process: {
        run: async (argv) => {
          if (answers instanceof Error) throw answers;
          return git(answers)(argv);
        },
      },
    };
  };
  const spare = { sessionCwd: SPARE, cwd: SPARE, projectRoot: SPARE };
  const boom = new Error('no answer');

  it('reports no move while the folder is the one held', async () => {
    expect(await follow(engine({ cwd: SPARE, root: SPARE, repo: null }), spare)).toEqual({ sessionCwd: SPARE, place: null });
  });

  it('follows $.session once it answers a new folder', async () => {
    const repo = { root: PROJECT, remote: 'git@github.com:acme/podium.git', name: null };
    const got = await follow(engine({ cwd: PROJECT, root: PROJECT, repo }), spare);
    expect(got).toEqual({ sessionCwd: PROJECT, place: { cwd: PROJECT, projectRoot: PROJECT, repoName: 'acme/podium' } });
  });

  it("follows a hook's cwd while $.session still answers the spare folder, asking git", async () => {
    const $ = engine({ cwd: SPARE, root: SPARE, repo: null }, { [COMMON]: `${PROJECT}/.git`, [REMOTE]: 'git@github.com:acme/podium.git' });
    expect(await follow($, spare, PROJECT)).toEqual({ sessionCwd: SPARE, place: { cwd: PROJECT, projectRoot: PROJECT, repoName: 'acme/podium' } });
  });

  it('keeps the last $.session answer when it fails, and falls back to the folder when nothing answers', async () => {
    const $ = engine({ cwd: boom, root: boom, repo: boom }, boom);
    expect(await follow($, spare, '/Users/dev/notes')).toEqual({ sessionCwd: SPARE, place: { cwd: '/Users/dev/notes', projectRoot: '/Users/dev/notes', repoName: 'notes' } });
  });
});
