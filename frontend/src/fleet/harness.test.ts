import { describe, expect, it } from "vitest";
import { harnessOf, isShellTool, mixedHarnesses, recommendedMark, shellToolOf } from "./harness";

describe("harness (#853)", () => {
  it("names the harnesses Podium knows, with a shape for the badge", () => {
    expect(harnessOf("claude-code")).toMatchObject({ id: "claude-code", name: "Claude Code", shape: "square" });
    expect(harnessOf("opencode")).toMatchObject({ id: "opencode", name: "OpenCode", shape: "diamond" });
  });

  it("falls back to the id and the plain square for a harness it has no entry for, and reports every field it cannot rule out", () => {
    expect(harnessOf("acme-runner")).toMatchObject({ id: "acme-runner", name: "acme-runner", shape: "square", context: true, effort: true });
    expect(harnessOf(undefined).id).toBe("claude-code");
    expect(harnessOf("").id).toBe("claude-code");
    // An id that is an Object.prototype key is not an entry.
    expect(harnessOf("constructor").name).toBe("constructor");
  });

  it("shows the fields OpenCode reports (#985)", () => {
    expect(harnessOf("opencode")).toMatchObject({ context: true, effort: true });
    expect(harnessOf("claude-code")).toMatchObject({ context: true, effort: true });
  });

  it("knows each harness's shell tool", () => {
    expect(shellToolOf("claude-code")).toBe("Bash");
    expect(shellToolOf("opencode")).toBe("shell");
    expect(shellToolOf("acme-runner")).toBeNull();
    expect(isShellTool("claude-code", "Bash")).toBe(true);
    expect(isShellTool("claude-code", "shell")).toBe(false);
    expect(isShellTool("opencode", "shell")).toBe(true);
    expect(isShellTool("opencode", "Bash")).toBe(false);
    expect(isShellTool(undefined, "Bash")).toBe(true);
    expect(isShellTool("acme-runner", "Bash")).toBe(false);
  });

  it("strips the (Recommended) mark only for Claude Code", () => {
    expect(recommendedMark("claude-code")).toBe(true);
    expect(recommendedMark(undefined)).toBe(true);
    expect(recommendedMark("opencode")).toBe(false);
  });

  it("shows the badge only when the wall holds more than one harness", () => {
    expect(mixedHarnesses([])).toBe(false);
    expect(mixedHarnesses([{ harness: "claude-code" }, { harness: "claude-code" }])).toBe(false);
    expect(mixedHarnesses([{ harness: "claude-code" }, { harness: "opencode" }])).toBe(true);
    expect(mixedHarnesses([{ harness: undefined }, { harness: "claude-code" }])).toBe(false);
  });
});
