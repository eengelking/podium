import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createDatabase, dropDatabase, isPostgresUrl, labelOf } from "./throwaway-db.mjs";

// Read like testing.ts does: podiumctl's settings test greps the server's source, not this folder, but the same habit keeps one spelling.
const { PODIUM_TEST_PG: TEST_PG } = process.env;
const script = path.join(__dirname, "throwaway-db.mjs");
const cli = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

describe("throwaway-db (#822)", () => {
  it("tells a PostgreSQL URL from a SQLite path", () => {
    expect(isPostgresUrl("postgres://u:p@h/d")).toBe(true);
    expect(isPostgresUrl("postgresql://h/d")).toBe(true);
    expect(isPostgresUrl("/tmp/x.sqlite")).toBe(false);
    expect(isPostgresUrl("")).toBe(false);
    expect(isPostgresUrl(undefined)).toBe(false);
    expect(cli("is-postgres", "postgres://h/d").status).toBe(0);
    expect(cli("is-postgres", "/x.sqlite").status).toBe(1);
  });

  it("labels a URL without its user or password", () => {
    expect(labelOf("postgres://podium:hunter2@db.lan:5432/podium")).toBe("db.lan:5432/podium");
    const r = cli("label", "postgres://podium:hunter2@db.lan:5432/podium");
    expect(r.stdout.trim()).toBe("db.lan:5432/podium");
    expect(r.stdout + r.stderr).not.toContain("hunter2");
  });

  it("prints help, and an error with exit code 2 for a bad command", () => {
    expect(cli("--help").stdout).toMatch(/Usage: node scripts\/throwaway-db\.mjs create/);
    const bad = cli("nope");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/unknown command/);
    expect(cli("create").status).toBe(2);
    expect(cli("drop").status).toBe(2);
    expect(cli("label").status).toBe(2);
  });

  it("refuses to create on a SQLite path and to drop a database it did not make", async () => {
    await expect(createDatabase("/tmp/x.sqlite")).rejects.toThrow(/not a postgres/);
    await expect(dropDatabase("postgres://u:p@h/production")).rejects.toThrow(/refusing to drop/);
  });

  describe.skipIf(!TEST_PG)("against a PostgreSQL server", () => {
    it("creates an empty database named podium_<part>_<random>, and drops it", async () => {
      const url = await createDatabase(TEST_PG!, "Smoke Test!");
      try {
        expect(new URL(url).pathname).toMatch(/^\/podium_smoketest_[0-9a-f]{10}$/);
        const c = new pg.Client({ connectionString: url });
        await c.connect();
        expect((await c.query("select count(*)::int as n from pg_tables where schemaname = 'public'")).rows[0].n).toBe(0);
        await c.end();
      } finally {
        await dropDatabase(url);
      }
      const admin = new pg.Client({ connectionString: TEST_PG });
      await admin.connect();
      const left = await admin.query("select 1 from pg_database where datname = $1", [new URL(url).pathname.slice(1)]);
      await admin.end();
      expect(left.rowCount).toBe(0);
    });
  });
});
