import { spawnSync } from "node:child_process";
import path from "node:path";
import mariadb, { type Connection } from "mariadb";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { kinds } from "./db-adapters.mjs";
import { createDatabase, DROPPABLE, dropDatabase, isPostgresUrl, isServerUrl, labelOf, SERVER_KINDS } from "./throwaway-db.mjs";

// Read like testing.ts does: podiumctl's settings test greps the server's source, not this folder, but the same habit keeps one spelling.
const { PODIUM_TEST_PG: TEST_PG, PODIUM_TEST_MARIADB: TEST_MARIADB } = process.env;
const script = path.join(__dirname, "throwaway-db.mjs");
const cli = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

describe("throwaway-db (#822, #823)", () => {
  it("tells the URL of a database server from a SQLite path", () => {
    for (const url of ["postgres://u:p@h/d", "postgresql://h/d", "mariadb://u:p@h:3306/d"]) expect(isServerUrl(url), url).toBe(true);
    for (const v of ["/tmp/x.sqlite", "sqlite:///x.db", "", undefined, "mysql://h/d"]) expect(isServerUrl(v), String(v)).toBe(false);
    expect(isPostgresUrl("postgresql://h/d")).toBe(true);
    expect(isPostgresUrl("mariadb://h/d")).toBe(false);
    expect(cli("is-server", "postgres://h/d").status).toBe(0);
    expect(cli("is-server", "mariadb://h/d").status).toBe(0);
    expect(cli("is-server", "/x.sqlite").status).toBe(1);
  });

  it("can make a database on every kind of server the tooling starts (scripts/db-adapters.mjs)", () => {
    expect([...SERVER_KINDS].sort()).toEqual(kinds("server").sort());
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
    await expect(createDatabase("/tmp/x.sqlite")).rejects.toThrow(/not the URL of a database server/);
    await expect(dropDatabase("postgres://u:p@h/production")).rejects.toThrow(/refusing to drop/);
    await expect(dropDatabase("mariadb://u:p@h/production")).rejects.toThrow(/refusing to drop/);
    await expect(dropDatabase("/tmp/podium_x_0123456789")).rejects.toThrow();
  });

  it("drops only the name shape create makes: podium_<part>_<10 hex>", async () => {
    for (const name of ["podium_prod", "podium_perfstorage", "podium_x_ZZZ", "podium_x_abcdef012", "podium_x_abcdef01234", "podium__abcdef0123", "podium_x_ABCDEF0123", "postgres"]) {
      await expect(dropDatabase(`postgres://u:p@h/${name}`), name).rejects.toThrow(/refusing to drop/);
    }
    expect(cli("drop", "postgres://u:p@h/podium_prod").stderr).toMatch(/refusing to drop/);
    expect(cli("--help").stdout).toMatch(/podium_<part>_<10 hex digits>/);
    expect(DROPPABLE.test("podium_perfstorage_0123456789")).toBe(true);
    expect(DROPPABLE.test("podium_podiumperfbrowser_abcdef0123")).toBe(true);
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

  describe.skipIf(!TEST_MARIADB)("against a MariaDB server", () => {
    const names = async (c: Connection, name: string) => (await c.query("SELECT schema_name AS n, default_character_set_name AS cs FROM information_schema.schemata WHERE schema_name = ?", [name])) as { n: string; cs: string }[];

    it("creates an empty utf8mb4 database named podium_<part>_<random>, and drops it with a connection still open to it", async () => {
      const url = await createDatabase(TEST_MARIADB!, "Smoke Test!");
      const name = new URL(url).pathname.slice(1);
      expect(name).toMatch(/^podium_smoketest_[0-9a-f]{10}$/);
      const u = new URL(url);
      const open = await mariadb.createConnection({ host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: name });
      // The drop ends this connection on the server's side, which the driver reports as an error event.
      const closed = new Promise<unknown>((resolve) => open.on("error", resolve));
      try {
        expect(await open.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?", [name])).toEqual([{ n: 0n }]);
        await dropDatabase(url);
        expect(await closed).toMatchObject({ fatal: true });
      } finally {
        await open.end().catch(() => undefined);
      }
      const admin = await mariadb.createConnection({ host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
      try {
        expect(await names(admin, name)).toEqual([]);
      } finally {
        await admin.end();
      }
    });

    it("makes the database utf8mb4", async () => {
      const url = await createDatabase(TEST_MARIADB!, "charset");
      const u = new URL(url);
      const admin = await mariadb.createConnection({ host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
      try {
        expect((await names(admin, u.pathname.slice(1)))[0]?.cs).toBe("utf8mb4");
      } finally {
        await admin.end();
        await dropDatabase(url);
      }
    });
  });
});
