import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { check, nullableColumns, orderOf, run, subOrderOf } from "./storage-order-parity.mjs";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A repository whose adapters hold the given files: { sqlite: { "notes.ts": source }, postgres: { ... } }. */
function repo(adapters: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "orderparity-"));
  made.push(root);
  for (const [adapter, files] of Object.entries(adapters)) {
    const dir = join(root, "server", "src", "storage", adapter);
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  }
  return root;
}

const sqlite = (body: string) => `export class Notes {\n  list() {\n    ${body}\n  }\n}\n`;
const pg = (body: string) => `export class PgNotes {\n  async list() {\n    ${body}\n  }\n}\n`;
const lite = (sql: string, mark = "") => sqlite(`${mark}return this.stmt('${sql}').all() as Row[];`);
const pgq = (sql: string, mark = "") => pg(`${mark}return this.db.all<Row>('${sql}');`);

describe("orderOf", () => {
  it("removes what the dialects do differently", () => {
    expect(orderOf("SELECT * FROM t ORDER BY podium_lower(n) ASC NULLS FIRST, t.id LIMIT 5")).toBe("lower(n), id");
    expect(orderOf("SELECT * FROM t ORDER BY lower(n) NULLS LAST, id")).toBe("lower(n), id");
    expect(orderOf("SELECT * FROM t WHERE a = :a ORDER BY b COLLATE NOCASE DESC")).toBe("b desc");
    expect(orderOf("SELECT * FROM t WHERE a = ?")).toBe("");
    expect(orderOf("SELECT row_number() OVER (ORDER BY ts) AS n FROM t")).toBe("");
    expect(orderOf("SELECT row_number() OVER (ORDER BY ts) AS n FROM t ORDER BY id")).toBe("id");
  });
});

describe("orderOf and the placement of NULLs", () => {
  const schema = new Map([["notes", new Set(["rank"])]]);
  const sql = (order: string) => `SELECT * FROM notes WHERE a = ? ORDER BY ${order}`;

  it("keeps where NULLs sort for a column that can be NULL, by the dialect's default when the query does not say", () => {
    expect(orderOf(sql("rank, id"), "sqlite", schema)).toBe("rank nulls first, id");
    expect(orderOf(sql("rank, id"), "postgres", schema)).toBe("rank nulls last, id");
    expect(orderOf(sql("rank DESC, id"), "sqlite", schema)).toBe("rank desc nulls last, id");
    expect(orderOf(sql("rank DESC, id"), "postgres", schema)).toBe("rank desc nulls first, id");
  });

  it("reads a stated placement as the same order as the default that gives it", () => {
    expect(orderOf(sql("rank NULLS FIRST, id"), "postgres", schema)).toBe(orderOf(sql("rank, id"), "sqlite", schema));
    expect(orderOf(sql("rank DESC NULLS LAST, id"), "postgres", schema)).toBe(orderOf(sql("rank DESC, id"), "sqlite", schema));
    expect(orderOf(sql("rank NULLS LAST"), "sqlite", schema)).not.toBe(orderOf(sql("rank"), "sqlite", schema));
  });

  it("has nothing to place for a column that cannot be NULL, one in COALESCE, or a table the schema does not know", () => {
    expect(orderOf(sql("id DESC"), "postgres", schema)).toBe("id desc");
    expect(orderOf(sql("COALESCE(rank, 0), id"), "postgres", schema)).toBe("coalesce(rank, 0), id");
    expect(orderOf("SELECT * FROM other ORDER BY rank", "postgres", schema)).toBe("rank");
  });

  it("separates the ORDER BY of a subquery that takes the first rows from the query's own", () => {
    const q = "SELECT (SELECT at FROM e WHERE e.s = n.id ORDER BY seq DESC LIMIT 1) AS a, row_number() OVER (ORDER BY ts) FROM notes n ORDER BY id";
    expect(orderOf(q)).toBe("id");
    expect(subOrderOf(q)).toBe("seq desc");
  });

  it("reads the nullable columns out of CREATE TABLE and ADD COLUMN in the adapter files", () => {
    const ddl = "const DDL = 'CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, rank INTEGER, name TEXT NOT NULL, n INT GENERATED ALWAYS AS IDENTITY, UNIQUE (name, rank))'; const ALTER = 'ALTER TABLE notes ADD COLUMN extra TEXT; ALTER TABLE notes ADD COLUMN kept TEXT NOT NULL DEFAULT 1';";
    const found = nullableColumns(repo({ sqlite: { "schema.ts": ddl } }));
    expect([...(found.get("notes") ?? [])].sort()).toEqual(["extra", "rank"]);
  });
});

describe("check", () => {
  /** A fixture file that declares its table, so the placement of NULLs is compared for `rank`. */
  const DDL = "const DDL = 'CREATE TABLE notes (id TEXT PRIMARY KEY, rank INTEGER, name TEXT NOT NULL)';\n";

  it("fails when one adapter leaves NULLs where its dialect puts them and the other's dialect puts them elsewhere", () => {
    const root = repo({
      sqlite: { "notes.ts": DDL + lite("SELECT * FROM notes ORDER BY rank, id") },
      postgres: { "notes.ts": DDL + pgq("SELECT * FROM notes ORDER BY rank, id") },
    });
    const [p, ...rest] = check(root).problems;
    expect(rest).toEqual([]);
    expect(p.message).toContain("rank nulls last, id");
    expect(p.message).toContain("rank nulls first, id");
  });

  it("accepts a PostgreSQL query that states the placement SQLite's default gives, and ignores it for a column that cannot be NULL", () => {
    const root = repo({
      sqlite: { "notes.ts": DDL + lite("SELECT * FROM notes ORDER BY rank DESC, name, id") },
      postgres: { "notes.ts": DDL + pgq("SELECT * FROM notes ORDER BY rank DESC NULLS LAST, name NULLS FIRST, id") },
    });
    expect(check(root).problems).toEqual([]);
  });

  it("compares a single-row read that orders and takes the first row", () => {
    const one = (sql: string) => sqlite(`return this.stmt('${sql}').get(1);`);
    const onePg = (sql: string) => pg(`return this.db.get('${sql}', [1]);`);
    const same = repo({ sqlite: { "notes.ts": one("SELECT * FROM notes WHERE a = ? ORDER BY t DESC LIMIT 1") }, postgres: { "notes.ts": onePg("SELECT * FROM notes WHERE a = ? ORDER BY t DESC LIMIT 1") } });
    const r = check(same);
    expect(r.queries.map((q) => q.kind)).toEqual(["get", "get"]);
    expect(r.problems).toEqual([]);
    const other = repo({ sqlite: { "notes.ts": one("SELECT * FROM notes WHERE a = ? ORDER BY t DESC LIMIT 1") }, postgres: { "notes.ts": onePg("SELECT * FROM notes WHERE a = ? ORDER BY t LIMIT 1") } });
    expect(check(other).problems.map((p) => p.message)).toEqual([expect.stringContaining("orders by t desc")]);
  });

  it("fails a single-row read that takes the first row of an unordered set, and passes an existence probe and a lookup by key", () => {
    const get = (sql: string) => pg(`return this.db.get('${sql}', [1]);`);
    const bad = repo({ sqlite: { "notes.ts": sqlite("return this.stmt('SELECT * FROM notes WHERE a = ? ORDER BY t LIMIT 1').get(1);") }, postgres: { "notes.ts": get("SELECT * FROM notes WHERE a = ? LIMIT 1") } });
    expect(check(bad).problems.map((p) => `${p.adapter}: ${p.message}`)).toEqual([expect.stringContaining("postgres: reads one row out of several with no ORDER BY")]);
    const fine = repo({ sqlite: { "notes.ts": sqlite("return this.stmt('SELECT 1 AS x FROM notes WHERE a = ? LIMIT 1').get(1);") }, postgres: { "notes.ts": get("SELECT 1 AS x FROM notes WHERE a = ? LIMIT 1") } });
    expect(check(fine)).toMatchObject({ queries: [], problems: [] });
  });

  it("compares the order a subquery takes its first row in, in a read or a write", () => {
    const write = (order: string) => `return this.stmt('UPDATE loops SET first_at = (SELECT at FROM entries WHERE s = ? ${order} LIMIT 1)').run(1);`;
    const writePg = (order: string) => `await this.db.run('UPDATE loops SET first_at = (SELECT at FROM entries WHERE s = ? ${order} LIMIT 1)', [1]);`;
    const ok = repo({ sqlite: { "notes.ts": sqlite(write("ORDER BY seq")) }, postgres: { "notes.ts": pg(writePg("ORDER BY seq")) } });
    expect(check(ok)).toMatchObject({ problems: [], queries: [{ kind: "run" }, { kind: "run" }] });
    const drift = repo({ sqlite: { "notes.ts": sqlite(write("ORDER BY seq")) }, postgres: { "notes.ts": pg(writePg("ORDER BY seq DESC")) } });
    expect(check(drift).problems.map((p) => p.message)).toEqual([expect.stringContaining("first rows: seq desc")]);
  });

  it("accepts adapters that order a list the same way in their own dialects", () => {
    const root = repo({
      sqlite: { "notes.ts": lite("SELECT * FROM notes WHERE a = ? ORDER BY podium_lower(name), id") },
      postgres: { "notes.ts": pgq("SELECT * FROM notes WHERE a = ? ORDER BY lower(name) NULLS FIRST, id") },
    });
    const r = check(root);
    expect(r.queries).toHaveLength(2);
    expect(r.problems).toEqual([]);
  });

  it("names the adapter, file, line and method when one adapter has no ORDER BY", () => {
    const root = repo({
      sqlite: { "notes.ts": lite("SELECT * FROM notes ORDER BY id") },
      postgres: { "notes.ts": pgq("SELECT * FROM notes") },
    });
    const [p, ...rest] = check(root).problems;
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ adapter: "postgres", file: "server/src/storage/postgres/notes.ts", line: 3, method: "list" });
    expect(p.message).toContain("no ORDER BY");
  });

  it("fails when the adapters order by different columns", () => {
    const root = repo({
      sqlite: { "notes.ts": lite("SELECT * FROM notes ORDER BY created_at, id") },
      postgres: { "notes.ts": pgq("SELECT * FROM notes ORDER BY created_at") },
    });
    const [p, ...rest] = check(root).problems;
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ adapter: "sqlite", method: "list" });
    expect(p.message).toContain("created_at, id");
  });

  it("accepts an unordered list marked order-insensitive with a reason, and rejects a mark with none", () => {
    const mark = "// order-insensitive: summed into a total\n    ";
    const marked = repo({ sqlite: { "notes.ts": lite("SELECT n FROM notes", mark) }, postgres: { "notes.ts": pgq("SELECT n FROM notes", mark) } });
    expect(check(marked).problems).toEqual([]);
    const bare = repo({ sqlite: { "notes.ts": lite("SELECT n FROM notes", "// order-insensitive:\n    ") }, postgres: { "notes.ts": pgq("SELECT n FROM notes", mark) } });
    expect(check(bare).problems.map((p) => p.adapter)).toEqual(["sqlite"]);
  });

  it("reads a mark on the statement that holds the query, and one on the same line", () => {
    const root = repo({
      sqlite: { "notes.ts": sqlite("// order-insensitive: a set\n    const rows = await this.step(() => this.stmt('SELECT n FROM notes').all());\n    return rows;") },
      postgres: { "notes.ts": pg("return this.db.all<Row>('SELECT n FROM notes'); // order-insensitive: a set") },
    });
    expect(check(root).problems).toEqual([]);
  });

  it("fails when a method that lists has no counterpart in the other adapter", () => {
    const root = repo({
      sqlite: { "notes.ts": lite("SELECT * FROM notes ORDER BY id") },
      postgres: { "notes.ts": pg("return this.db.all<Row>('SELECT * FROM notes ORDER BY id');").replace("async list", "async listAll") },
    });
    const messages = check(root).problems.map((p) => `${p.adapter}: ${p.message}`).sort().reverse();
    expect(messages).toEqual([expect.stringContaining("sqlite: no counterpart for notes#list in postgres"), expect.stringContaining("postgres: no counterpart for notes#listAll in sqlite")]);
  });

  it("finds the counterpart of a method that is in another file by its name", () => {
    const root = repo({
      sqlite: { "notes.ts": lite("SELECT * FROM notes ORDER BY id") },
      postgres: { "elsewhere.ts": pgq("SELECT * FROM notes ORDER BY id") },
    });
    expect(check(root).problems).toEqual([]);
  });

  it("follows a constant in the ORDER BY, a statement kept in a variable and a helper that runs the SQL it is given", () => {
    const root = repo({
      sqlite: {
        "notes.ts": [
          "const ORDER = 'ORDER BY id';",
          "export class Notes {",
          "  private rows(sql: string) { return this.stmt(sql).all(); }",
          "  a() { const sql = `SELECT * FROM a ${ORDER}`; return this.stmt(sql).all(); }",
          "  b() { const st = this.stmt('SELECT * FROM b ORDER BY id'); return st.all(); }",
          "  c() { return this.rows('SELECT * FROM c'); }",
          "}",
        ].join("\n"),
      },
      postgres: {
        "notes.ts": [
          "export class PgNotes {",
          "  a() { return this.db.all('SELECT * FROM a ORDER BY id'); }",
          "  b() { return this.db.all('SELECT * FROM b ORDER BY id'); }",
          "  c() { return this.db.all('SELECT * FROM c ORDER BY id'); }",
          "}",
        ].join("\n"),
      },
    });
    const r = check(root);
    expect(r.queries.map((q) => q.key).sort()).toEqual(["notes#a", "notes#a", "notes#b", "notes#b", "notes#c", "notes#c"]);
    expect(r.problems.map((p) => `${p.adapter} ${p.method}`)).toEqual(["sqlite c"]);
  });

  it("does not take a single-row read or a write for a list", () => {
    const root = repo({
      sqlite: { "notes.ts": sqlite("this.stmt('SELECT * FROM notes').get(); this.stmt('DELETE FROM notes RETURNING id').all();") },
      postgres: { "notes.ts": pg("this.db.get('SELECT * FROM notes'); this.db.all('DELETE FROM notes RETURNING id');") },
    });
    expect(check(root).queries).toEqual([]);
  });
});

describe("run", () => {
  const logs = () => {
    const out: string[] = [];
    return { out, log: (s: string) => out.push(s) };
  };

  it("prints its usage", () => {
    const { out, log } = logs();
    expect(run(["--help"], log)).toBe(0);
    expect(out.join("\n")).toContain("order-insensitive");
  });

  it("exits 0 on a matching pair and 1, naming the query, on a drifting one", () => {
    const good = repo({ sqlite: { "notes.ts": lite("SELECT * FROM notes ORDER BY id") }, postgres: { "notes.ts": pgq("SELECT * FROM notes ORDER BY id") } });
    const bad = repo({ sqlite: { "notes.ts": lite("SELECT * FROM notes ORDER BY id") }, postgres: { "notes.ts": pgq("SELECT * FROM notes") } });
    const a = logs();
    expect(run(["--root", good, "--list"], a.log)).toBe(0);
    expect(a.out.join("\n")).toContain("notes#list  id");
    const b = logs();
    expect(run(["--root", bad], b.log)).toBe(1);
    expect(b.out.join("\n")).toContain("server/src/storage/postgres/notes.ts:3: postgres list: returns a list with no ORDER BY");
  });

  it("fails when it finds no query at all, so a broken reader cannot pass", () => {
    const { out, log } = logs();
    expect(run(["--root", repo({})], log)).toBe(1);
    expect(out.join("\n")).toContain("no list queries found");
  });
});

describe("this repository", () => {
  it("has no list query that is unordered, unmarked or ordered differently in an adapter", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const r = check(root);
    expect(r.queries.length).toBeGreaterThan(50);
    expect(r.problems.map((p) => `${p.file}:${p.line} ${p.message}`)).toEqual([]);
  });

  /** A copy of the real adapters' source with one edit to a PostgreSQL file, so the guard is shown to catch the drift it is for. */
  function seeded(file: string, from: string, to: string, adapters = ["postgres"]): string {
    const here = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "src", "storage");
    const root = mkdtempSync(join(tmpdir(), "orderparity-real-"));
    made.push(root);
    const dest = join(root, "server", "src", "storage");
    cpSync(here, dest, { recursive: true, filter: (src) => !/\.test\.ts$|contract|node_modules/.test(src) });
    for (const adapter of adapters) {
      const target = join(dest, adapter, file);
      const text = readFileSync(target, "utf8");
      expect(text).toContain(from);
      writeFileSync(target, text.replace(from, to));
    }
    return root;
  }

  it("catches a single-row read that PostgreSQL orders differently from SQLite", () => {
    const root = seeded("fleet.ts", "FROM samples WHERE session_id = ? ORDER BY t DESC LIMIT 1", "FROM samples WHERE session_id = ? ORDER BY t LIMIT 1");
    expect(check(root).problems.map((p) => `${p.adapter} ${p.method}`)).toEqual(["sqlite latestSample"]);
  });

  it("catches a single-row read that PostgreSQL leaves unordered", () => {
    const root = seeded("fleet.ts", "FROM samples WHERE session_id = ? ORDER BY t DESC LIMIT 1", "FROM samples WHERE session_id = ? LIMIT 1");
    expect(check(root).problems.map((p) => `${p.adapter} ${p.method}`).sort()).toEqual(["postgres latestSample"]);
  });

  it("catches a column that can be NULL given a different NULLS placement in PostgreSQL", () => {
    // Both adapters order by stored_sessions.oldest_t, a nullable column, and neither says where NULLs go: SQLite puts them last in a
    // descending order and PostgreSQL first, with the same text in both.
    const root = seeded("activityHistory.ts", "ORDER BY s.last_t DESC, s.session_id", "ORDER BY s.oldest_t DESC, s.session_id", ["sqlite", "postgres"]);
    const found = check(root).problems.map((p) => p.message);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("oldest_t desc nulls");
  });
});
