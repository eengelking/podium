// The PostgreSQL tests run only against a server `PODIUM_TEST_PG` names (#822). This gate makes that impossible to miss (#891):
// without the variable it prints that the suite is skipped and how to run it; with the variable and no server behind it, it fails
// the run instead of letting every PostgreSQL test fail one by one, or be taken for a pass. Used by globalSetup.ts (vitest.config.ts).
import pg from 'pg';
import { TEST_PG } from './testing.js';

export const PG_SKIP_NOTICE = [
  '',
  '  ! PostgreSQL tests SKIPPED: PODIUM_TEST_PG is not set, so server/src/storage/postgres/ and the PostgreSQL storage contract did not run.',
  '    A green run here says nothing about PostgreSQL. Run them with a throwaway container:  scripts/test-pg.sh',
  '    (CI runs them in the "Test with PostgreSQL" job.)',
  '',
].join('\n');

/** host:port/dbname of a connection string: what may be printed. Never the user or the password. */
function label(value: string): string {
  try {
    const u = new URL(value);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(not a valid URL)';
  }
}

async function connectOnce(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  c.on('error', () => undefined);
  await c.connect();
  try { await c.query('SELECT 1'); } finally { await c.end(); }
}

/** Prints the skip notice when `PODIUM_TEST_PG` is not set; throws when it is set and the server does not answer. */
export async function pgGate(
  env?: Record<string, string | undefined>,
  connect: (url: string) => Promise<void> = connectOnce,
  print: (line: string) => void = (l) => console.warn(l),
): Promise<void> {
  const { PODIUM_TEST_PG: url } = env ?? { PODIUM_TEST_PG: TEST_PG }; // destructured: podiumctl's settings test lists what the server reads, and this is for tests only
  if (!url) { print(PG_SKIP_NOTICE); return; }
  try {
    await connect(url);
  } catch (e) {
    const why = e instanceof Error ? e.message.split(url).join(label(url)) : 'unknown error';
    throw new Error(`PODIUM_TEST_PG is set but the PostgreSQL server at ${label(url)} is unreachable (${why}). Start it (scripts/test-pg.sh does) or unset the variable.`);
  }
}
