#!/usr/bin/env node
// Makes and drops a throwaway PostgreSQL database for the scripts that start their own Podium server (smoke, soak, perf, the peers
// e2e, the live recording check). Those scripts normally give the server a SQLite file in a temp folder; when PODIUM_DB names a
// PostgreSQL server they call this to get a database of their own on it instead, so a run never reads or writes a database that is
// already there, and drop it at the end. (#822)
//
//   node scripts/throwaway-db.mjs create <server-url> [name-part]   print the URL of a new, empty database on that server
//   node scripts/throwaway-db.mjs drop <database-url>               drop that database (the one `create` printed)
//   node scripts/throwaway-db.mjs label <url>                       print host:port/dbname, never the user or the password
//   node scripts/throwaway-db.mjs is-postgres <value>               exit 0 when the value is a postgres:// or postgresql:// URL
//
// The URL `create` prints holds the password: capture it in a variable and give it to the server as PODIUM_DB; print `label`.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HELP = `Usage: node scripts/throwaway-db.mjs create <server-url> [name-part]
       node scripts/throwaway-db.mjs drop <database-url>
       node scripts/throwaway-db.mjs label <url>
       node scripts/throwaway-db.mjs is-postgres <value>

create  makes podium_<name-part>_<random> on the PostgreSQL server <server-url> names and prints its URL.
drop    drops the database <database-url> names, closing any connection to it first. It accepts only a name of the shape create
        makes, podium_<part>_<10 hex digits> (part: 1 to 20 lower-case letters or digits), and refuses every other name, podium_prod included.
label   prints host:port/dbname for a URL, leaving out the user and the password.
is-postgres  exits 0 for a postgres:// or postgresql:// URL, 1 for anything else (a SQLite path, empty).`;

export const isPostgresUrl = (value) => /^postgres(ql)?:\/\//.test(value ?? '');

/** host:port/dbname of a PostgreSQL URL: what may be printed. */
export function labelOf(value) {
  const u = new URL(value);
  return `${u.host}${u.pathname}`;
}

const safeName = (part) => `podium_${String(part || 'tmp').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20) || 'tmp'}_${randomBytes(5).toString('hex')}`;

/** The only names `drop` accepts: exactly the shape `safeName` makes (a part of 1 to 20 letters or digits, then 10 hex digits). A real database such as podium_prod never matches. */
export const DROPPABLE = /^podium_[a-z0-9]{1,20}_[0-9a-f]{10}$/;

/** Creates an empty database on the server `serverUrl` names and returns its URL. */
export async function createDatabase(serverUrl, part) {
  if (!isPostgresUrl(serverUrl)) throw new Error('not a postgres:// URL');
  const name = safeName(part);
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Drops a database `createDatabase` made. */
export async function dropDatabase(databaseUrl) {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!DROPPABLE.test(name)) throw new Error(`refusing to drop "${name}": not a database this script made`);
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); }
}

async function main(argv) {
  const [cmd, a, b] = argv;
  switch (cmd) {
    case 'create': if (!a) throw new Error('create needs a server URL'); process.stdout.write(`${await createDatabase(a, b)}\n`); return 0;
    case 'drop': if (!a) throw new Error('drop needs a database URL'); await dropDatabase(a); return 0;
    case 'label': if (!a) throw new Error('label needs a URL'); process.stdout.write(`${labelOf(a)}\n`); return 0;
    case 'is-postgres': return isPostgresUrl(a) ? 0 : 1;
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
