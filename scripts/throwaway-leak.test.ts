import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mariadb from "mariadb";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The scripts that start their own server make a throwaway database on a PostgreSQL or MariaDB server and must drop it on every way
// out, a failed start included (#822, #823). Each runs here from a copy in a fake checkout whose server cannot start, against each test server.
const { PODIUM_TEST_PG: TEST_PG, PODIUM_TEST_MARIADB: TEST_MARIADB } = process.env;

/** Each database server with its test URL, and whether a database of a name is still on it. */
const SERVERS = [
  {
    kind: "postgres",
    url: TEST_PG,
    async exists(url: string, name: string) {
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      try {
        return (await admin.query("select 1 from pg_database where datname = $1", [name])).rowCount !== 0;
      } finally {
        await admin.end();
      }
    },
  },
  {
    kind: "mariadb",
    url: TEST_MARIADB,
    async exists(url: string, name: string) {
      const u = new URL(url);
      const admin = await mariadb.createConnection({ host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
      try {
        return ((await admin.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = ?", [name])) as unknown[]).length !== 0;
      } finally {
        await admin.end();
      }
    },
  },
];
const REAL = path.join(__dirname, "..");
let root = "";

const SCRIPTS = [
  { file: "podium-smoke.sh", args: ["--no-vite"], part: "podiumsmoke" },
  { file: "podium-soak.sh", args: [], part: "podiumsoak" },
  { file: "podium-perf-browser.sh", args: [], part: "podiumperfbrowser" },
];

beforeAll(() => {
  // The real path: on macOS the temp folder is behind a link, and the CLI guard compares paths as written.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "podium-leak-")));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "server", "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "frontend", "dist"), { recursive: true });
  for (const driver of ["pg", "mariadb"]) fs.symlinkSync(path.join(REAL, "node_modules", driver), path.join(root, "node_modules", driver));
  // Copied, not linked: the script runs its CLI only when it is started by its own path.
  for (const f of ["throwaway-db.mjs", "db-adapters.mjs"]) fs.copyFileSync(path.join(REAL, "scripts", f), path.join(root, "scripts", f));
  // A server that dies at once: the script reaches "server did not start" after it made its database.
  fs.writeFileSync(path.join(root, "node_modules", ".bin", "tsx"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "server", "dist", "index.js"), "process.exit(1);\n");
  for (const s of SCRIPTS) fs.copyFileSync(path.join(REAL, "scripts", s.file), path.join(root, "scripts", s.file));
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const run = (file: string, args: string[], db: string) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile("bash", [path.join(root, "scripts", file), ...args], { env: { ...process.env, PODIUM_DB: db }, timeout: 90_000 }, (err, stdout, stderr) => {
      resolve({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });

describe("throwaway database scripts (#822, #823)", () => {
  for (const s of SCRIPTS) {
    for (const server of SERVERS) {
      it.concurrent(`${s.file} exits non-zero and leaves no database on ${server.kind} when the server cannot start`, async () => {
        if (!server.url) return;
        const r = await run(s.file, s.args, server.url);
        const out = r.stdout + r.stderr;
        const name = new RegExp(`/(podium_${s.part}_[0-9a-f]{10})`).exec(out)?.[1];
        expect(name, out).toBeTruthy();
        expect(r.status).not.toBe(0);
        expect(out).not.toMatch(/(postgres|mariadb):\/\/[^\s/]*:[^\s/]*@/);
        expect(await server.exists(server.url, name!)).toBe(false);
      }, 100_000);
    }

    it.concurrent(`${s.file} exits non-zero, with no leftover, when the database cannot be made`, async () => {
      for (const url of ["postgres://nobody@127.0.0.1:1/postgres", "mariadb://nobody@127.0.0.1:1/podium"]) {
        const r = await run(s.file, s.args, url);
        expect(r.status, url).not.toBe(0);
        expect(r.stderr).toMatch(/could not make a database/);
      }
    }, 60_000);
  }
});
