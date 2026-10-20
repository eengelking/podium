import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, FleetDb } from "./db.js";
import { DEFAULT_CONFIG, Fleet } from "./fleet.js";
import { readBuild, serverBuild } from "./build.js";

describe("readBuild", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dir = () => {
    const d = mkdtempSync(path.join(tmpdir(), "podium-build-"));
    dirs.push(d);
    return d;
  };

  it("reads PODIUM_BUILD first", () => {
    const d = dir();
    writeFileSync(path.join(d, "build.json"), JSON.stringify({ build: "11111111" }));
    expect(readBuild({ PODIUM_BUILD: "a1b2c3d4" }, d)).toBe("a1b2c3d4");
  });

  it("falls back to build.json, which a standalone build writes", () => {
    const d = dir();
    writeFileSync(path.join(d, "build.json"), JSON.stringify({ build: "a1b2c3d4-dirty" }));
    expect(readBuild({}, d)).toBe("a1b2c3d4-dirty");
  });

  it("is null with neither, with an empty value (a release), and with an unreadable file", () => {
    const d = dir();
    expect(readBuild({}, d)).toBeNull();
    expect(readBuild({ PODIUM_BUILD: "" }, d)).toBeNull();
    writeFileSync(path.join(d, "build.json"), "not json");
    expect(readBuild({}, d)).toBeNull();
    writeFileSync(path.join(d, "build.json"), JSON.stringify({ build: null }));
    expect(readBuild({}, d)).toBeNull();
  });
});

describe("serverBuild", () => {
  it("is in the state body next to the version, null when this server was not built from a dev commit", () => {
    const fleet = new Fleet(new FleetDb(openDb(":memory:")), { ...DEFAULT_CONFIG, home: "/Users/dev", dbPath: ":memory:" }, () => 1_791_648_000_000);
    expect(fleet.state().server).toMatchObject({ version: expect.any(String), build: serverBuild() });
    expect(fleet.health().serverBuild).toBe(serverBuild());
  });
});
