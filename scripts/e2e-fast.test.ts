// scripts/e2e-fast.mjs (#1249): how the shard count is chosen (the cap, the CPUs, the memory, the one-shard fallback, the override),
// how the arguments are read, and that main hands e2e-all.sh the database and the count. No container starts.
import { describe, expect, it } from "vitest";
import { chooseShards, GB_PER_RUN, main, MAX_SHARDS, parseArgs, readMachine } from "./e2e-fast.mjs";

describe("chooseShards", () => {
  it("never goes above the cap, however large the machine", () => {
    expect(chooseShards({ cpus: 24, memGb: 128 }).shards).toBe(MAX_SHARDS);
    expect(MAX_SHARDS).toBe(3);
  });
  it("is limited by the CPUs", () => {
    const r = chooseShards({ cpus: 2, memGb: 64 });
    expect(r.shards).toBe(2);
    expect(r.reason).toContain("CPUs");
  });
  it("is limited by memory in GB divided by 2", () => {
    const r = chooseShards({ cpus: 16, memGb: 5 });
    expect(r.shards).toBe(Math.floor(5 / GB_PER_RUN));
    expect(r.reason).toContain("memory");
  });
  it("chooses 3 on a 6-CPU, 16 GB machine and names the cap", () => {
    const r = chooseShards({ cpus: 6, memGb: 15.6 });
    expect(r.shards).toBe(3);
    expect(r.reason).toContain("cap of 3");
  });
  it("falls back to one shard and says why when the machine only supports one", () => {
    for (const m of [{ cpus: 1, memGb: 16 }, { cpus: 8, memGb: 3 }, { cpus: 8, memGb: 0.5 }]) {
      const r = chooseShards(m);
      expect(r.shards).toBe(1);
      expect(r.reason).toContain("one shard");
    }
  });
  it("falls back to one shard when the machine could not be read", () => {
    expect(chooseShards({}).shards).toBe(1);
    expect(chooseShards({ cpus: 6 }).reason).toContain("could not be read");
  });
  it("uses the override over the machine, even above the cap", () => {
    expect(chooseShards({ cpus: 1, memGb: 1, override: 5 })).toEqual({ shards: 5, reason: "--shards 5 was given" });
    expect(chooseShards({ cpus: 24, memGb: 128, override: 1 }).shards).toBe(1);
  });
});

describe("parseArgs", () => {
  it("defaults to sqlite, then $E2E_DB, then --db", () => {
    expect(parseArgs([], {})).toMatchObject({ db: "sqlite", override: undefined, pass: [] });
    expect(parseArgs([], { E2E_DB: "postgres" }).db).toBe("postgres");
    expect(parseArgs(["--db", "mariadb"], { E2E_DB: "postgres" }).db).toBe("mariadb");
  });
  it("reads --shards, --out, --no-build and keeps what follows -- for Cypress", () => {
    expect(parseArgs(["--shards", "2", "--out", "/o", "--no-build", "--", "--headed"], {})).toEqual({
      db: "sqlite", override: 2, pass: ["--out", "/o", "--no-build", "--", "--headed"],
    });
  });
  it("refuses a bad count, a missing value, an unknown option and a bad database", () => {
    expect(parseArgs(["--shards", "0"], {}).error).toContain("whole number");
    expect(parseArgs(["--shards", "x"], {}).error).toContain("whole number");
    expect(parseArgs(["--shards"], {}).error).toContain("needs a value");
    expect(parseArgs(["--nope"], {}).error).toContain("unknown option");
    expect(parseArgs(["--db", "a b"], {}).error).toContain("not a database");
  });
  it("answers --help", () => {
    expect(parseArgs(["-h"], {})).toEqual({ help: true });
  });
});

describe("readMachine", () => {
  const fake = (out: string, status = 0) => ((_c: string, a: string[]) => ({ status, stdout: a[0] === "--version" ? "" : out })) as never;
  it("reads podman's CPUs and memory", () => {
    const m = readMachine({ E2E_ENGINE: "podman" }, fake("6 17179869184"));
    expect(m).toEqual({ cpus: 6, memGb: 16 });
  });
  it("reads docker's", () => {
    expect(readMachine({ E2E_ENGINE: "docker" }, fake("2 7516192768"))).toEqual({ cpus: 2, memGb: 7 });
  });
  it("returns nothing when the engine fails or none is found", () => {
    expect(readMachine({ E2E_ENGINE: "podman" }, fake("", 1))).toEqual({ cpus: undefined, memGb: undefined });
    expect(readMachine({}, (() => ({ status: 1, stdout: "" })) as never)).toEqual({});
  });
});

describe("main", () => {
  it("prints help and exits 0, and exits 2 on a bad argument", () => {
    expect(main(["--help"], {})).toBe(0);
    expect(main(["--shards", "zero"], {})).toBe(2);
  });
  it("hands e2e-all.sh the one database and the chosen count, and returns its exit code", () => {
    const calls: string[][] = [];
    const run = ((c: string, a: string[]) => {
      if (c === "bash") { calls.push(a); return { status: 1 }; }
      return { status: 0, stdout: a[0] === "--version" ? "" : "8 34359738368" };
    }) as never;
    expect(main(["--out", "/o"], { E2E_ENGINE: "podman" }, run)).toBe(1);
    expect(calls[0].slice(1)).toEqual(["--databases", "sqlite", "--shards", "3", "--out", "/o"]);
    expect(main(["--shards", "1", "--db", "postgres"], {}, run)).toBe(1);
    expect(calls[1].slice(1)).toEqual(["--databases", "postgres", "--shards", "1"]);
  });
  it("returns 2 when the script gives no status", () => {
    expect(main(["--shards", "2"], {}, (() => ({ status: null })) as never)).toBe(2);
  });
});
