import { describe, expect, it } from "vitest";
import { parseBuild } from "./parseBuild.js";

describe("parseBuild", () => {
  it("accepts a short commit hash", () => {
    expect(parseBuild("a1b2c3d4")).toBe("a1b2c3d4");
  });

  it("keeps the -dirty mark and trims whitespace", () => {
    expect(parseBuild(" a1b2c3d4-dirty\n")).toBe("a1b2c3d4-dirty");
  });

  it("is null for a release, which has no build, and for anything that is not a hash", () => {
    expect(parseBuild("")).toBeNull();
    expect(parseBuild(undefined)).toBeNull();
    expect(parseBuild(null)).toBeNull();
    expect(parseBuild("v1.1.0")).toBeNull();
    expect(parseBuild("a1b2c3d4; rm -rf /")).toBeNull();
    expect(parseBuild("zzzzzzzz")).toBeNull();
    expect(parseBuild(42)).toBeNull();
  });

  it("rejects a hash that is too short to name a commit", () => {
    expect(parseBuild("a1b2c3")).toBeNull();
  });
});
