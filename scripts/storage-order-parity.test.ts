import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { check, orderOf, run } from "./storage-order-parity.mjs";

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

describe("check", () => {
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
});
