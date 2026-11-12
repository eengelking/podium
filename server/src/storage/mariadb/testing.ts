// Test support for the MariaDB adapter (#823): a throwaway database on the server `PODIUM_TEST_MARIADB` names, made for one test file
// and dropped after it. A run without that variable fails in the global setup unless PODIUM_TEST_ONLY leaves MariaDB out (#1008); CI sets
// it from a service container, and locally it is a Podman container (see development-commands). Never point it at a database you care about.
import * as mariadb from 'mariadb';
import { randomBytes } from 'node:crypto';
import { connectionConfig, parseTarget } from './conn.js';

/** The admin URL of the test server (a user that may create and drop databases), or undefined when MariaDB tests are not wanted. */
// Destructured, not `process.env.X`: podiumctl's settings test lists the variables the server reads, and this one is for tests only.
export const { PODIUM_TEST_MARIADB: TEST_MARIADB } = process.env;

export interface TestDatabase { url: string; name: string; drop(): Promise<void> }

/** Runs `fn` on a connection of its own to `url` (no pool), and ends it. */
export async function withConnection<T>(url: string, fn: (c: mariadb.Connection) => Promise<T>): Promise<T> {
  const c = await mariadb.createConnection(connectionConfig(parseTarget(url)));
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => c.destroy());
  }
}

/** The server URL with no database named: the admin connection opens none, so a database the test made can be dropped from it. */
const serverConfig = (): mariadb.ConnectionConfig => {
  const t = parseTarget(TEST_MARIADB!);
  const c = connectionConfig(t);
  delete c.database;
  return c;
};

/** Creates `podium_test_<random>` on the test server, made with the server's own default character set (the adapter must not rely on it), and returns its URL. */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (!TEST_MARIADB) throw new Error('PODIUM_TEST_MARIADB is not set');
  const name = `podium_test_${randomBytes(6).toString('hex')}`;
  const admin = await mariadb.createConnection(serverConfig());
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(TEST_MARIADB);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    name,
    drop: async () => {
      const a = await mariadb.createConnection(serverConfig());
      try {
        // MariaDB has no DROP ... FORCE: end what is still connected to it first, so the drop does not wait on a lock it holds.
        const ids = await a.query<{ id: bigint }[]>('SELECT id FROM information_schema.processlist WHERE db = ? AND id <> CONNECTION_ID()', [name]);
        for (const { id } of ids) await a.query(`KILL CONNECTION ${Number(id)}`).catch(() => undefined);
        await a.query(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await a.end();
      }
    },
  };
}

/**
 * Empties the tables and starts their ids again, for a test that reuses one database. MariaDB truncates one table at a time and refuses
 * one another table references while the check is on, so it is off for these statements, on the one connection the transaction holds.
 */
export async function truncate(db: { tx<T>(fn: () => Promise<T>): Promise<T>; exec(sql: string): Promise<void> }, ...tables: string[]): Promise<void> {
  await db.tx(async () => {
    await db.exec('SET FOREIGN_KEY_CHECKS = 0');
    try {
      for (const t of tables) await db.exec(`TRUNCATE TABLE ${t}`);
    } finally {
      await db.exec('SET FOREIGN_KEY_CHECKS = 1');
    }
  });
}
