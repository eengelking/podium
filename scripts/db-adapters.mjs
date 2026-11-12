#!/usr/bin/env node
// The databases the repo's tooling starts in a container, one entry per storage kind (#823): scripts/test-db.sh starts each kind's
// test server for the server suite, and scripts/e2e-up.sh starts one beside the server for E2E_DB=<kind>. The kinds themselves are
// registered in server/src/storage/index.ts; scripts/db-adapters.test.ts fails when this table and the registry disagree (a kind or a
// test server variable missing here, a kind missing from the e2e.yml database list, or a CI job missing for the version named here).
//
// Adding a database is one entry below: its test server variable, its test and e2e images, its container port, what makes it ready, and the URLs.
// In a template, {host}, {port}, {user}, {password} and {db} are filled in by the caller; nothing else is.
import { fileURLToPath } from "node:url";

export const DB_ADAPTERS = [
  // The default: a file in the server's data folder. No container and no test server variable.
  { kind: "sqlite", label: "SQLite" },
  {
    kind: "postgres",
    label: "PostgreSQL",
    schemes: ["postgres", "postgresql"],
    testVar: "PODIUM_TEST_PG",
    port: 5432,
    // The image first runs a temporary server on its socket only, then restarts: -h 127.0.0.1 answers from the final one alone.
    ready: ["pg_isready", "-h", "127.0.0.1", "-U", "{user}"],
    // PostgreSQL 17 is the one version tested (ci.yml's "Test with PostgreSQL", sonar.yml, and the e2e image below); others are untested.
    test: { image: "docker.io/library/postgres:17", user: "postgres", env: { POSTGRES_PASSWORD: "{password}" }, url: "postgres://{user}:{password}@{host}:{port}/postgres" },
    e2e: {
      image: "docker.io/library/postgres:17-alpine", // the tested version; an untested override needs 13 or newer, for DROP DATABASE ... WITH (FORCE)
      imageVar: "E2E_PG_IMAGE",
      env: { POSTGRES_USER: "{user}", POSTGRES_PASSWORD: "{password}", POSTGRES_DB: "{db}" },
      args: ["-c", "fsync=off", "-c", "synchronous_commit=off"], // the database is thrown away
      url: "postgres://{user}:{password}@{host}:{port}/{db}",
      // On the container's own socket, which the image trusts; the server is held down while this runs.
      reset: ["psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", "{user}", "-d", "postgres", "-c", "DROP DATABASE IF EXISTS {db} WITH (FORCE)", "-c", "CREATE DATABASE {db}"],
    },
  },
  {
    kind: "mariadb",
    label: "MariaDB",
    schemes: ["mariadb"],
    testVar: "PODIUM_TEST_MARIADB",
    port: 3306,
    // The image's own check: --connect refuses the temporary socket-only server the image runs its init on.
    ready: ["healthcheck.sh", "--connect", "--innodb_initialized"],
    // MariaDB 11.x is supported and 11.4, the long-term release, is the one version tested (ci.yml's "Test with MariaDB 11.4",
    // sonar.yml, and the e2e image below); other versions are untested.
    test: { image: "docker.io/library/mariadb:11.4", user: "root", env: { MARIADB_ROOT_PASSWORD: "{password}", MARIADB_DATABASE: "podium_test" }, url: "mariadb://{user}:{password}@{host}:{port}/podium_test" },
    e2e: {
      image: "docker.io/library/mariadb:11.4.13", // 11.4, pinned to a patch release so a run does not change under the suite
      imageVar: "E2E_MARIADB_IMAGE",
      env: { MARIADB_USER: "{user}", MARIADB_PASSWORD: "{password}", MARIADB_DATABASE: "{db}", MARIADB_ROOT_PASSWORD: "{password}" },
      args: ["--innodb-flush-log-at-trx-commit=0"], // the database is thrown away
      url: "mariadb://{user}:{password}@{host}:{port}/{db}",
      // As root, with the password the container already holds in its environment, so it is never on a command line. The user's grant
      // is on the database name and outlives the drop. utf8mb4 on the database, as SERVER.md tells an operator to make it.
      reset: ["sh", "-c", 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot -e "DROP DATABASE IF EXISTS {db}; CREATE DATABASE {db} CHARACTER SET utf8mb4"'],
    },
  },
];

const HELP = `Usage: node scripts/db-adapters.mjs kinds [--server | --e2e]
       node scripts/db-adapters.mjs kind-of <url>
       node scripts/db-adapters.mjs shell <kind> test|e2e [--image REF] [--set name=value ...]

The databases the tooling starts in a container, one entry per storage kind (the table is at the top of this file).
kinds     prints the kinds, space separated: every kind, those with a test server (--server), or those E2E_DB accepts (--e2e).
kind-of   prints the kind a PODIUM_DB value names (sqlite for a path), exit 1 for a URL of no known kind.
shell     prints bash assignments for one kind, for scripts/test-db.sh and scripts/e2e-up.sh to eval: DB_LABEL, DB_IMAGE, DB_PORT,
          DB_TEST_VAR, DB_URL, and the arrays DB_ENV (NAME=value lines for an env file), DB_ARGS, DB_READY and DB_RESET. --set fills a
          template's {name}; {password} comes from the DB_PASSWORD environment variable, so it is never on a command line. test picks
          the kind's test image; e2e picks its e2e image, or the one its image variable names (E2E_PG_IMAGE, E2E_MARIADB_IMAGE).
          --image overrides both.`;

/** The entry for a kind, or throws naming the kinds there are. */
export function adapter(kind) {
  const a = DB_ADAPTERS.find((x) => x.kind === kind);
  if (!a) throw new Error(`unknown database kind "${kind}" (known: ${DB_ADAPTERS.map((x) => x.kind).join(", ")})`);
  return a;
}

/** The kinds: every one, those with a test server, or those the end-to-end runner can start. */
export function kinds(which = "all") {
  const keep = { all: () => true, server: (a) => !!a.testVar, e2e: (a) => !a.port || !!a.e2e }[which];
  if (!keep) throw new Error(`kinds takes all, server or e2e, not "${which}"`);
  return DB_ADAPTERS.filter(keep).map((a) => a.kind);
}

/** The kind a PODIUM_DB value names: a URL's scheme, or sqlite for a path, a sqlite:// URL or nothing; null for an unknown scheme. */
export function kindOf(value) {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(String(value ?? ""))?.[1]?.toLowerCase();
  if (!scheme || scheme === "sqlite") return "sqlite";
  return DB_ADAPTERS.find((a) => a.schemes?.includes(scheme))?.kind ?? null;
}

/** A template with each {name} replaced from `values`; a name with no value is left as it is. */
export function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (m, k) => (values[k] === undefined ? m : String(values[k])));
}

/** The image a run uses: the override, else for e2e the kind's image variable or its e2e image, else its test image. */
export function imageFor(a, use, { image, env = process.env } = {}) {
  if (image) return image;
  if (use === "e2e") return (a.e2e.imageVar && env[a.e2e.imageVar]) || a.e2e.image;
  return a.test.image;
}

/** Everything a script needs to start and use one kind's container, with the templates filled from `values`. */
export function plan(kind, use, values = {}, opts = {}) {
  const a = adapter(kind);
  const part = use === "e2e" ? a.e2e : a.test;
  if (!part || !a.port) throw new Error(`${kind} has no ${use === "e2e" ? "end-to-end" : "test"} container`);
  const v = { port: a.port, user: part.user, ...values };
  return {
    label: a.label,
    image: imageFor(a, use, opts),
    port: a.port,
    testVar: a.testVar,
    url: fill(part.url, v),
    env: Object.entries(part.env).map(([k, x]) => `${k}=${fill(x, v)}`),
    args: (part.args ?? []).map((x) => fill(x, v)),
    ready: a.ready.map((x) => fill(x, v)),
    reset: (part.reset ?? []).map((x) => fill(x, v)),
  };
}

/** A value as one bash word in single quotes. */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The plan as bash assignments (see HELP). */
export function shellOf(p) {
  const arr = (name, xs) => `${name}=(${xs.map(q).join(" ")})`;
  return [
    `DB_LABEL=${q(p.label)}`,
    `DB_IMAGE=${q(p.image)}`,
    `DB_PORT=${q(p.port)}`,
    `DB_TEST_VAR=${q(p.testVar ?? "")}`,
    `DB_URL=${q(p.url)}`,
    arr("DB_ENV", p.env),
    arr("DB_ARGS", p.args),
    arr("DB_READY", p.ready),
    arr("DB_RESET", p.reset),
  ].join("\n");
}

/**
 * The command line, with where it writes and the environment passed in so a test can run it in-process. Returns the exit code.
 * @param {string[]} argv
 * @param {(text: string) => void} [out]
 * @param {Record<string, string | undefined>} [env]
 */
export function run(argv, out = (s) => void process.stdout.write(`${s}\n`), env = process.env) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    out(HELP);
    return 0;
  }
  if (cmd === "kinds") {
    out(kinds(rest.includes("--server") ? "server" : rest.includes("--e2e") ? "e2e" : "all").join(" "));
    return 0;
  }
  if (cmd === "kind-of") {
    const k = kindOf(rest[0]);
    if (k) out(k);
    return k ? 0 : 1;
  }
  if (cmd === "shell") {
    const [kind, use, ...flags] = rest;
    if (use !== "test" && use !== "e2e") throw new Error("shell needs a kind and test or e2e (see --help)");
    const values = { password: env.DB_PASSWORD ?? "" };
    const opts = { env, image: undefined };
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--image") opts.image = flags[++i];
      else if (flags[i] === "--set" && /^\w+=/.test(flags[i + 1] ?? "")) {
        const [k, ...v] = flags[++i].split("=");
        values[k] = v.join("=");
      } else throw new Error(`unknown argument "${flags[i]}" (see --help)`);
    }
    out(shellOf(plan(kind, use, values, opts)));
    return 0;
  }
  throw new Error(`unknown command "${cmd}" (see --help)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`db-adapters: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}
