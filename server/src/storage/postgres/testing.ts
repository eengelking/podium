// Test support for the PostgreSQL adapter (#822): a throwaway database on the server `PODIUM_TEST_PG` names, made for one test file and
// dropped after it. Without that variable the PostgreSQL tests are skipped, so `npm test` needs no server; CI sets it from a service
// container, and locally it is a Podman container (see development-commands). Never point it at a database you care about.
import pg from 'pg';
import { randomBytes } from 'node:crypto';

/** The admin URL of the test server, or undefined when PostgreSQL tests are not wanted. */
// Destructured, not `process.env.X`: podiumctl's settings test lists the variables the server reads, and this one is for tests only.
export const { PODIUM_TEST_PG: TEST_PG } = process.env;

export interface TestDatabase { url: string; drop(): Promise<void> }

/** Creates `podium_test_<random>` on the test server and returns its URL. */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (!TEST_PG) throw new Error('PODIUM_TEST_PG is not set');
  const name = `podium_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_PG });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(TEST_PG);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const a = new pg.Client({ connectionString: TEST_PG });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
