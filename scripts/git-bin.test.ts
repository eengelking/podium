import { describe, expect, test } from "vitest";
import { gitBin, GIT_DIRS } from "./git-bin.mjs";

describe("gitBin", () => {
  test("returns the first fixed folder that holds git", () => {
    expect(gitBin(["/a", "/b"], ((p: unknown) => p === "/b/git") as never)).toBe("/b/git");
  });
  test("throws naming the folders when none holds git", () => {
    expect(() => gitBin(["/a", "/b"], () => false)).toThrow("git was not found in /a, /b");
  });
  test("finds the real git on this machine", () => {
    expect(GIT_DIRS.some((d: string) => gitBin().startsWith(d))).toBe(true);
  });
});
