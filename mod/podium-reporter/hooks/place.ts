// Where a session works, and how the reporter notices it moved (#382, SPEC 6.7). Pure: the mod passes what
// `$.session` answered and a runner for git, so the server's test run can measure it (the mod's own tests cannot be).
import { lastSegment, type Runner } from './git.ts';
import { repoFromRemote } from './report.ts';

export interface Place {
  projectRoot: string;
  repoName: string;
}

/** What `$.session.root()` and `$.session.repo()` answered. */
export interface SessionPlace {
  root: string | null;
  repo: { root: string; remote: string | null; name: string | null } | null;
}

/** Whether `dir` is `folder` or inside it. */
export function holds(folder: string | null | undefined, dir: string): boolean {
  return !!folder && (dir === folder || dir.startsWith(folder.endsWith('/') ? folder : `${folder}/`));
}

/**
 * The folder the session is in now. A hook's `cwd` wins, except when it is inside the place already reported: it follows
 * the shell, so a `cd` into a subfolder is not a move. Without a hook, `$.session.cwd()` counts once its answer differs
 * from the last one (`lastSeen`); an answer that stayed put does not undo a move a hook reported.
 */
export function nextCwd(i: { hookCwd?: string; seen: string | null; lastSeen: string | null; current: string; projectRoot: string | null }): string {
  const inside = !!i.hookCwd && (holds(i.current, i.hookCwd) || holds(i.projectRoot, i.hookCwd));
  const sessionMoved = !!i.seen && i.seen !== i.lastSeen;
  return (inside ? null : i.hookCwd) || (sessionMoved ? i.seen : null) || i.current;
}

/**
 * The project root and repository name for `cwd`: from `$.session` while its answer holds `cwd`, else from git run in
 * `cwd` (the common dir's parent and the origin remote), else the folder itself.
 */
export async function placeOf(session: SessionPlace, cwd: string, run: Runner): Promise<Place> {
  const base = session.repo?.root ?? session.root;
  if (base && holds(base, cwd)) {
    const { repo } = session;
    return { projectRoot: base, repoName: repo?.name ?? repoFromRemote(repo?.remote) ?? lastSegment(base) };
  }
  const git = async (argv: string[]) => {
    const res = await run(argv);
    return res.exitCode === 0 ? res.stdout.trim() : '';
  };
  const common = await git(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const dir = common.endsWith('/') ? common.slice(0, -1) : common;
  const projectRoot = dir.endsWith('/.git') ? dir.slice(0, -'/.git'.length) : dir || cwd;
  return { projectRoot, repoName: repoFromRemote(await git(['git', 'config', '--get', 'remote.origin.url'])) ?? lastSegment(projectRoot) };
}

/** The parts of `$` that the place logic reads, so a test can stand in for them. */
export interface PlaceEngine {
  session: {
    cwd(): Promise<string>;
    root(): Promise<string>;
    repo(): Promise<{ root: string; remote: string | null; name: string | null } | null>;
  };
  process: { run(argv: string[], init: { cwd: string; timeoutMs: number }): Promise<{ exitCode: number; stdout: string }> };
}

/** What the reporter holds about the place. */
export interface PlaceMemory {
  sessionCwd: string | null;
  cwd: string;
  projectRoot: string | null;
}

async function orElse<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * Follow a session that moved (#382): the desktop app moves a pre-warmed spare to the project the person picked without
 * restarting it. `place` is null when the folder is the one already held. `sessionCwd` is what `$.session.cwd()` answered, to
 * hold for the next call.
 */
export async function follow($: PlaceEngine, mem: PlaceMemory, hookCwd?: string): Promise<{ sessionCwd: string | null; place: (Place & { cwd: string }) | null }> {
  const seen = await orElse<string | null>(() => $.session.cwd(), null);
  const cwd = nextCwd({ hookCwd, seen, lastSeen: mem.sessionCwd, current: mem.cwd, projectRoot: mem.projectRoot });
  const sessionCwd = seen || mem.sessionCwd;
  if (cwd === mem.cwd) return { sessionCwd, place: null };
  const session = { root: await orElse<string | null>(() => $.session.root(), null), repo: await orElse(() => $.session.repo(), null) };
  const run: Runner = async (argv) => {
    const res = await orElse(() => $.process.run(argv, { cwd, timeoutMs: 5000 }), null);
    return { exitCode: res?.exitCode ?? 1, stdout: res?.stdout ?? '' };
  };
  return { sessionCwd, place: { cwd, ...(await placeOf(session, cwd, run)) } };
}
