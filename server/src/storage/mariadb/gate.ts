// The MariaDB tests run only against a server `PODIUM_TEST_MARIADB` names (#823). With the variable set and no server behind it, this gate
// fails the run instead of letting every MariaDB test fail one by one, or be taken for a pass (#891). A variable that is not set is
// `../serverGate.ts`'s business (#1008). Used by globalSetup.ts (vitest.config.ts).
import { TEST_MARIADB, withConnection } from './testing.js';
import { mariaLabel } from './conn.js';

/** host:port/dbname of a connection string: what may be printed. Never the user or the password. */
function label(value: string): string {
  return URL.canParse(value) ? mariaLabel(value) : '(not a valid URL)';
}

async function connectOnce(url: string): Promise<void> {
  await withConnection(url, async (c) => {
    await c.query('SELECT 1');
  });
}

/** Does nothing when `PODIUM_TEST_MARIADB` is not set (the server gate has judged that); throws when it is set and the server does not answer. */
export async function mariaGate(
  env?: Record<string, string | undefined>,
  connect: (url: string) => Promise<void> = connectOnce,
): Promise<void> {
  const { PODIUM_TEST_MARIADB: url } = env ?? { PODIUM_TEST_MARIADB: TEST_MARIADB }; // destructured: podiumctl's settings test lists what the server reads, and this is for tests only
  if (!url) return;
  try {
    await connect(url);
  } catch (e) {
    const why = e instanceof Error ? e.message.split(url).join(label(url)).split(passwordOf(url) || '\u0000').join('***') : 'unknown error';
    throw new Error(`PODIUM_TEST_MARIADB is set but the MariaDB server at ${label(url)} is unreachable (${why}). Start it (scripts/test-db.sh does) or unset the variable.`);
  }
}

/** The password a URL carries, decoded, so an error that repeats it can have it taken out. */
function passwordOf(url: string): string {
  return URL.canParse(url) ? decodeURIComponent(new URL(url).password) : '';
}
