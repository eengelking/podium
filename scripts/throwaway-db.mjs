#!/usr/bin/env node
// Makes and drops a throwaway database on a database server for the scripts that start their own Podium server (smoke, soak, perf,
// the peers e2e, the live recording check). Those scripts normally give the server a SQLite file in a temp folder; when PODIUM_DB names
// a PostgreSQL or MariaDB server they call this to get a database of their own on it instead, so a run never reads or writes a database
// that is already there, and drop it at the end. (#822, #823)
//
//   node scripts/throwaway-db.mjs create <server-url> [name-part]   print the URL of a new, empty database on that server
//   node scripts/throwaway-db.mjs drop <database-url>               drop that database (the one `create` printed)
//   node scripts/throwaway-db.mjs label <url>                       print host:port/dbname, never the user or the password
//   node scripts/throwaway-db.mjs is-server <value>                 exit 0 when the value is the URL of a database server
//
// The URL `create` prints holds the password: capture it in a variable and give it to the server as PODIUM_DB; print `label`.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { kindOf } from './db-adapters.mjs';

const HELP = `Usage: node scripts/throwaway-db.mjs create <server-url> [name-part]
       node scripts/throwaway-db.mjs drop <database-url>
       node scripts/throwaway-db.mjs label <url>
       node scripts/throwaway-db.mjs is-server <value>

create     makes podium_<name-part>_<random> on the server <server-url> names (postgres://, postgresql:// or mariadb://) and prints
           its URL.
drop       drops the database <database-url> names, closing any connection to it first. It accepts only a name of the shape create
           makes, podium_<part>_<10 hex digits> (part: 1 to 20 lower-case letters or digits), and refuses every other name, podium_prod included.
label      prints host:port/dbname for a URL, leaving out the user and the password.
is-server  exits 0 for the URL of a PostgreSQL or MariaDB server, 1 for anything else (a SQLite path, empty).`;

/**
 * What each database server needs, by kind (scripts/db-adapters.mjs names the kinds). `admin` opens a connection with no database of
 * the run's (an administrator's) and hands `q(sql, args)`, which returns the rows, to the step. The driver is loaded only when it is used.
 */
const SERVERS = {
  postgres: {
    async admin(url, step) {
      const { default: pg } = await import('pg');
      const u = new URL(url);
      u.pathname = '/postgres';
      const c = new pg.Client({ connectionString: u.toString() });
      await c.connect();
      try { return await step((sql, args) => c.query(sql, args).then((r) => r.rows)); } finally { await c.end(); }
    },
    create: (q, name) => q(`CREATE DATABASE ${name}`),
    drop: (q, name) => q(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  },
  mariadb: {
    async admin(url, step) {
      const { default: mariadb } = await import('mariadb');
      const c = await mariadb.createConnection(mariadbAdminOptions(url));
      try { return await step((sql, args) => c.query(sql, args)); } finally { await c.end(); }
    },
    // utf8mb4, as SERVER.md tells an operator to make the database.
    create: (q, name) => q(`CREATE DATABASE ${name} CHARACTER SET utf8mb4`),
    // MariaDB has no DROP DATABASE ... WITH (FORCE): end each connection to the database first.
    async drop(q, name) {
      for (const row of await q('SELECT id FROM information_schema.processlist WHERE db = ? AND id <> CONNECTION_ID()', [name])) await q(`KILL ${Number(row.id)}`).catch(() => undefined);
      await q(`DROP DATABASE IF EXISTS ${name}`);
    },
  },
};

/**
 * What the MariaDB driver is given for an administrator's connection to the server a URL names, with no database of the run's. The URL
 * takes the one parameter the adapter takes (server/src/storage/mariadb/conn.ts, `parseTarget`): `ssl=true` connects over TLS, as the
 * server will; any other parameter is refused here, as the server would refuse it.
 */
export function mariadbAdminOptions(url) {
  const u = new URL(url);
  let ssl = false;
  for (const [k, v] of u.searchParams) {
    if (k === 'ssl' && (v === 'true' || v === 'false')) ssl = v === 'true';
    else throw new Error(`the MariaDB URL parameter "${k}" is not supported (only ssl=true or ssl=false)`);
  }
  return { host: u.hostname.replace(/^\[(.*)\]$/, '$1'), port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) || undefined, ssl };
}

/** The kinds this script can make a database on; scripts/throwaway-db.test.ts holds it to the kinds with a test server in db-adapters.mjs. */
export const SERVER_KINDS = Object.keys(SERVERS);

/** The server entry for a URL, or null for a SQLite path, an empty value or a URL of a kind with no server. */
const serverOf = (value) => SERVERS[kindOf(value)] ?? null;

export const isServerUrl = (value) => serverOf(value) !== null;

/** host:port/dbname of a database URL: what may be printed. */
export function labelOf(value) {
  const u = new URL(value);
  return `${u.host}${u.pathname}`;
}

const safeName = (part) => `podium_${String(part || 'tmp').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20) || 'tmp'}_${randomBytes(5).toString('hex')}`;

/** The only names `drop` accepts: exactly the shape `safeName` makes (a part of 1 to 20 letters or digits, then 10 hex digits). A real database such as podium_prod never matches. */
export const DROPPABLE = /^podium_[a-z0-9]{1,20}_[0-9a-f]{10}$/;

/** Creates an empty database on the server `serverUrl` names and returns its URL: the server's URL with the new name as its path, its parameters kept. */
export async function createDatabase(serverUrl, part) {
  const server = serverOf(serverUrl);
  if (!server) throw new Error('not the URL of a database server (postgres://, postgresql:// or mariadb://)');
  const name = safeName(part);
  await server.admin(serverUrl, (q) => server.create(q, name));
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Drops a database `createDatabase` made. */
export async function dropDatabase(databaseUrl) {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!DROPPABLE.test(name)) throw new Error(`refusing to drop "${name}": not a database this script made`);
  const server = serverOf(databaseUrl);
  if (!server) throw new Error('not the URL of a database server (postgres://, postgresql:// or mariadb://)');
  await server.admin(databaseUrl, (q) => server.drop(q, name));
}

async function main(argv) {
  const [cmd, a, b] = argv;
  switch (cmd) {
    case 'create': if (!a) throw new Error('create needs a server URL'); process.stdout.write(`${await createDatabase(a, b)}\n`); return 0;
    case 'drop': if (!a) throw new Error('drop needs a database URL'); await dropDatabase(a); return 0;
    case 'label': if (!a) throw new Error('label needs a URL'); process.stdout.write(`${labelOf(a)}\n`); return 0;
    case 'is-server': return isServerUrl(a) ? 0 : 1;
    case '-h': case '--help': case undefined: process.stdout.write(`${HELP}\n`); return 0;
    default: throw new Error(`unknown command "${cmd}" (see --help)`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    // The message of a failed connection can name the host but never carries the password; print only that.
    process.stderr.write(`throwaway-db: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  });
}
