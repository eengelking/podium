// scripts/db-adapters.mjs (#823): the one table of the databases the tooling starts in a container. This holds it to the storage registry,
// the workflows and the end-to-end runner, so an adapter added in one place and not the others fails here, and checks the bash it prints.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { contractAdapterFor, testedStorageKinds } from "../server/src/storage/index.js";
import type { ContractAdapter } from "../server/src/storage/contractAdapter.js";
import { DB_ADAPTERS, fill, kindOf, kinds, plan, run, shellOf } from "./db-adapters.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = (f: string) => readFileSync(join(REPO, ".github", "workflows", f), "utf8");
const servers = DB_ADAPTERS.filter((a) => a.testVar);
/** The tag of an image reference: docker.io/library/mariadb:11.4 -> 11.4. */
const tag = (ref: string) => ref.slice(ref.lastIndexOf(":") + 1);

/** The jobs of a workflow, by name, each with its text (the same split as server/src/storage/adapters.test.ts). */
const jobs = (text: string): Record<string, string> => {
  const parts = text.slice(text.indexOf("\njobs:")).split(/\n {2}([a-z0-9-]+):\n/).slice(1);
  return Object.fromEntries(parts.reduce<[string, string][]>((acc, v, i) => (i % 2 ? acc : [...acc, [v, parts[i + 1] ?? ""]]), []));
};

describe("the database table", () => {
  const registered: ContractAdapter[] = [];
  afterAll(async () => {
    for (const a of registered) await a.dispose();
  });

  it("names each kind once, and gives each one with a test server everything a container needs", () => {
    expect(new Set(DB_ADAPTERS.map((a) => a.kind)).size).toBe(DB_ADAPTERS.length);
    for (const a of servers) {
      expect(a, a.kind).toMatchObject({ port: expect.any(Number), schemes: expect.arrayContaining([a.kind]), test: { image: expect.stringMatching(/:/) } });
      expect(a.ready!.length, a.kind).toBeGreaterThan(0);
      expect(a.test!.url, a.kind).toMatch(new RegExp(`^${a.kind}://\\{user\\}:\\{password\\}@\\{host\\}:\\{port\\}/`));
      expect(a.e2e, a.kind).toMatchObject({ image: expect.stringMatching(/:/), imageVar: expect.stringMatching(/^E2E_\w+_IMAGE$/), url: expect.stringContaining("{password}") });
      expect(a.e2e!.reset.join(" "), a.kind).toMatch(/DROP DATABASE.*\{db\}.*CREATE DATABASE \{db\}/);
      // One tested version per kind: the e2e image is the test image's version, pinned further or in another variant.
      expect(tag(a.e2e!.image), `${a.kind}'s e2e image must be the tested version, ${tag(a.test!.image)}`).toMatch(new RegExp(`^${tag(a.test!.image).replace(/\./g, "\\.")}[.-]`));
    }
  });

  it("has the kinds the storage registry has, with the same test server variables", async () => {
    for (const k of testedStorageKinds()) registered.push(await contractAdapterFor(k));
    const reg = registered.map((a) => ({ kind: a.name, testVar: a.serverVar ?? undefined })).sort((x, y) => x.kind.localeCompare(y.kind));
    const table = DB_ADAPTERS.map((a) => ({ kind: a.kind, testVar: a.testVar })).sort((x, y) => x.kind.localeCompare(y.kind));
    expect(table, "scripts/db-adapters.mjs and server/src/storage/index.ts must list the same kinds and variables").toEqual(reg);
  });

  it("is what the end-to-end workflow runs: every database in its default list, and the list holds every kind", () => {
    const list = /DATABASES: \$\{\{ inputs\.databases \|\| '([^']*)' \}\}/.exec(workflow("e2e.yml"))?.[1]?.split(" ") ?? [];
    expect([...list].sort()).toEqual(kinds("e2e").sort());
  });

  it("has a CI job for each test server that runs the version the table names, and sets no condition on it", () => {
    const all = jobs(workflow("ci.yml"));
    for (const a of servers) {
      const job = Object.entries(all).find(([, text]) => text.includes(`${a.testVar}:`));
      expect(job, `no job in ci.yml sets ${a.testVar}`).toBeTruthy();
      expect(job![1], `${job![0]} must run ${a.kind} ${tag(a.test!.image)}`).toContain(`image: ${a.kind}:${tag(a.test!.image)}\n`);
      expect(job![1], `${job![0]} must run one version, not a matrix`).not.toMatch(/matrix/);
      expect(job![1], `${job![0]} must leave out only the kinds that have their own job`).toMatch(new RegExp(`PODIUM_TEST_ONLY: sqlite,${a.kind}\\n`));
    }
  });

  it("gives Sonar's coverage run every test server, so a line no adapter's test reaches is not counted as covered", () => {
    const coverage = jobs(workflow("sonar.yml")).coverage ?? "";
    for (const a of servers) {
      expect(coverage, `sonar.yml's coverage job must set ${a.testVar}`).toContain(`${a.testVar}:`);
      expect(coverage, `sonar.yml's coverage job must run ${a.kind} ${tag(a.test!.image)}`).toContain(`image: ${a.kind}:${tag(a.test!.image)}\n`);
    }
    expect(coverage).not.toMatch(/PODIUM_TEST_ONLY/);
  });

  it("is the list scripts/e2e-up.sh accepts and names in its help", () => {
    const help = spawnSync("bash", [join(REPO, "scripts", "e2e-up.sh"), "--help"], { encoding: "utf8" });
    expect(help.stdout).toContain(`One of: ${kinds("e2e").join(", ")} (default sqlite`);
    for (const a of servers) expect(help.stdout).toContain(a.e2e!.imageVar);
    const bad = spawnSync("bash", [join(REPO, "scripts", "e2e-up.sh"), "--not-an-option"], { encoding: "utf8", env: { ...process.env, E2E_DB: "mysql" } });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain(`E2E_DB must be one of ${kinds("e2e").join(" ")}, not "mysql"`);
  });
});

describe("db-adapters.mjs", () => {
  it("lists the kinds, those with a test server and those the end-to-end runner takes", () => {
    expect(kinds()).toEqual(["sqlite", "postgres", "mariadb"]);
    expect(kinds("server")).toEqual(["postgres", "mariadb"]);
    expect(kinds("e2e")).toEqual(["sqlite", "postgres", "mariadb"]);
    expect(() => kinds("other")).toThrow(/all, server or e2e/);
  });

  it("tells the kind of a PODIUM_DB value", () => {
    expect(kindOf("/data/podium.sqlite")).toBe("sqlite");
    expect(kindOf("sqlite:///x.db")).toBe("sqlite");
    expect(kindOf(undefined)).toBe("sqlite");
    expect(kindOf("postgresql://h/d")).toBe("postgres");
    expect(kindOf("MariaDB://u:p@h:3306/d")).toBe("mariadb");
    expect(kindOf("mysql://h/d")).toBeNull();
  });

  it("fills a template's names and leaves an unknown one", () => {
    expect(fill("{user}@{host}:{port}/{other}", { user: "u", host: "h", port: 1 })).toBe("u@h:1/{other}");
  });

  it("plans a test container with its test image, and an e2e one with its image variable", () => {
    const t = plan("mariadb", "test", { password: "pw", host: "127.0.0.1", port: 4000 });
    expect(t).toMatchObject({ image: "docker.io/library/mariadb:11.4", url: "mariadb://root:pw@127.0.0.1:4000/podium_test", testVar: "PODIUM_TEST_MARIADB" });
    expect(t.env).toContain("MARIADB_ROOT_PASSWORD=pw");
    expect(plan("postgres", "test").image).toBe("docker.io/library/postgres:17");
    expect(plan("mariadb", "test", {}, { image: "x/y:1" }).image).toBe("x/y:1");
    const e = plan("mariadb", "e2e", { password: "pw", user: "podium", db: "podium_e2e", host: "db" }, { env: {} });
    expect(e).toMatchObject({ image: "docker.io/library/mariadb:11.4.13", url: "mariadb://podium:pw@db:3306/podium_e2e" });
    expect(e.reset.join(" ")).not.toContain("pw");
    expect(plan("postgres", "e2e", {}, { env: { E2E_PG_IMAGE: "x/pg:13" } }).image).toBe("x/pg:13");
    expect(() => plan("sqlite", "test")).toThrow(/sqlite has no test container/);
    expect(() => plan("oracle", "test")).toThrow(/unknown database kind "oracle"/);
  });

  it("prints bash that sets the plan, with the password taken from the environment and quoted safely", () => {
    const out: string[] = [];
    expect(run(["shell", "postgres", "e2e", "--set", "user=podium", "--set", "db=podium_e2e", "--set", "host=it's"], (s) => out.push(s), { DB_PASSWORD: "p'w" })).toBe(0);
    const script = `${out.join("\n")}\nprintf '%s\\n' "$DB_URL" "\${DB_ENV[1]}" "\${#DB_RESET[@]}" "$DB_IMAGE"`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(r.stdout.trim().split("\n")).toEqual(["postgres://podium:p'w@it's:5432/podium_e2e", "POSTGRES_PASSWORD=p'w", "12", "docker.io/library/postgres:17-alpine"]);
    expect(shellOf(plan("mariadb", "test"))).toMatch(/^DB_LABEL='MariaDB'$/m);
  });

  it("answers its commands, and refuses a bad one", () => {
    const out: string[] = [];
    const say = (s: string) => out.push(s);
    expect(run(["kinds", "--server"], say)).toBe(0);
    expect(run(["kind-of", "mariadb://h/d"], say)).toBe(0);
    expect(run(["kind-of", "mysql://h/d"], say)).toBe(1);
    expect(run(["--help"], say)).toBe(0);
    expect(out.slice(0, 2)).toEqual(["postgres mariadb", "mariadb"]);
    expect(out[2]).toContain("Usage: node scripts/db-adapters.mjs kinds");
    expect(() => run(["shell", "mariadb"], say)).toThrow(/test or e2e/);
    expect(() => run(["shell", "mariadb", "test", "--bad"], say)).toThrow(/unknown argument/);
    expect(() => run(["shell", "mariadb", "test", "--floor"], say)).toThrow(/unknown argument "--floor"/);
    expect(() => run(["nope"], say)).toThrow(/unknown command/);
    const cli = spawnSync(process.execPath, [join(REPO, "scripts", "db-adapters.mjs"), "shell", "oracle", "test"], { encoding: "utf8" });
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain('db-adapters: unknown database kind "oracle"');
  });
});
