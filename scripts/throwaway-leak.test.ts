import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The scripts that start their own server make a throwaway PostgreSQL database and must drop it on every way out, a failed start
// included (#822). Each runs here from a copy in a fake checkout whose server cannot start, against the test server.
const { PODIUM_TEST_PG: TEST_PG } = process.env;
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
  fs.symlinkSync(path.join(REAL, "node_modules", "pg"), path.join(root, "node_modules", "pg"));
  // Copied, not linked: the script runs its CLI only when it is started by its own path.
  fs.copyFileSync(path.join(REAL, "scripts", "throwaway-db.mjs"), path.join(root, "scripts", "throwaway-db.mjs"));
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

describe("throwaway database scripts (#822)", () => {
  for (const s of SCRIPTS) {
    it.concurrent(`${s.file} exits non-zero and leaves no database when the server cannot start`, async () => {
      if (!TEST_PG) return;
      const r = await run(s.file, s.args, TEST_PG);
      const out = r.stdout + r.stderr;
      const name = new RegExp(`/(podium_${s.part}_[0-9a-f]{10})`).exec(out)?.[1];
      expect(name, out).toBeTruthy();
      expect(r.status).not.toBe(0);
      expect(out).not.toMatch(/postgres:\/\/[^\s/]*:[^\s/]*@/);
      const admin = new pg.Client({ connectionString: TEST_PG });
      await admin.connect();
      try {
        expect((await admin.query("select 1 from pg_database where datname = $1", [name])).rowCount).toBe(0);
      } finally {
        await admin.end();
      }
    }, 100_000);

    it.concurrent(`${s.file} exits non-zero, with no leftover, when the database cannot be made`, async () => {
      const r = await run(s.file, s.args, "postgres://nobody@127.0.0.1:1/postgres");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/could not make a database/);
    }, 30_000);
  }
});
