import { describe, expect, it } from "vitest";
import { checkReporter as check, DEFAULT_REPORTER, REPORTER_SUPPORT, reporterOfHarness, serverVersion, supportFor } from "./compat.js";

const support = { min: "0.2.0", max: "0.3.0" };
const checkReporter = (version: string | null | undefined) => check(version, DEFAULT_REPORTER, support);

describe("checkReporter", () => {
  it("accepts a version inside the range", () => {
    expect(checkReporter("0.2.0")).toBe("ok");
    expect(checkReporter("0.3.0")).toBe("ok");
  });

  it("ignores the patch number, so a mod-only fix never warns", () => {
    expect(checkReporter("0.2.7")).toBe("ok");
    expect(checkReporter("0.3.9")).toBe("ok");
  });

  it("flags a reporter below the minimum as outdated", () => {
    expect(checkReporter("0.1.0")).toBe("outdated");
    expect(checkReporter("0.1.99")).toBe("outdated");
  });

  it("flags a reporter above the maximum as newer than the server", () => {
    expect(checkReporter("0.4.0")).toBe("newer");
    expect(checkReporter("1.0.0")).toBe("newer");
  });

  it("compares numerically, not as strings", () => {
    expect(checkReporter("0.10.0")).toBe("newer");
  });

  it("reports unknown for versions it cannot read", () => {
    expect(checkReporter("0.1.0-sim")).toBe("unknown");
    expect(checkReporter("hooks")).toBe("unknown");
    expect(checkReporter("")).toBe("unknown");
    expect(checkReporter(null)).toBe("unknown");
  });
});

describe("REPORTER_SUPPORT", () => {
  it("is a readable range with min at or below max", () => {
    const own = REPORTER_SUPPORT[DEFAULT_REPORTER];
    expect(check(own.min)).toBe("ok");
    expect(check(own.max)).toBe("ok");
  });
});

describe("a range per reporter (#852)", () => {
  const ranges = { "podium-reporter-claudecode": { min: "0.2.0", max: "1.4.0" }, "podium-reporter-opencode": { min: "1.5.0", max: "1.5.0" } };
  const of = (name: string) => ranges[name as keyof typeof ranges] ?? null;

  it("judges a reporter by its own range, so one outside it warns and the other does not", () => {
    expect(check("1.5.0", "podium-reporter-claudecode", of("podium-reporter-claudecode"))).toBe("newer");
    expect(check("1.5.0", "podium-reporter-opencode", of("podium-reporter-opencode"))).toBe("ok");
    expect(check("1.4.0", "podium-reporter-opencode", of("podium-reporter-opencode"))).toBe("outdated");
    expect(check("1.4.0", "podium-reporter-claudecode", of("podium-reporter-claudecode"))).toBe("ok");
  });

  it("does not check a reporter with no range of its own", () => {
    expect(supportFor("nobody-reporter")).toBeNull();
    expect(check("9.9.9", "nobody-reporter")).toBe("unknown");
    expect(supportFor("toString")).toBeNull();
  });

  it("reads an absent name as the default reporter", () => {
    expect(supportFor(null)).toBe(REPORTER_SUPPORT[DEFAULT_REPORTER]);
    expect(supportFor("")).toBe(REPORTER_SUPPORT[DEFAULT_REPORTER]);
    expect(check(REPORTER_SUPPORT[DEFAULT_REPORTER].min, undefined)).toBe("ok");
  });

  it("names the reporter that serves a harness, or the harness itself when none is known", () => {
    expect(reporterOfHarness("claude-code")).toBe("podium-reporter-claudecode");
    expect(reporterOfHarness("opencode")).toBe("podium-reporter-opencode");
    expect(reporterOfHarness(null)).toBe("podium-reporter-claudecode");
  });
});

describe("serverVersion", () => {
  it("reads the version from server/package.json", () => {
    expect(serverVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("the legacy and the per-harness names (#967)", () => {
  it("reads the legacy name as the Claude Code reporter, and gives the OpenCode reporter a range of its own", () => {
    expect(supportFor("podium-reporter")).toEqual(supportFor("podium-reporter-claudecode"));
    expect(supportFor("podium-reporter-opencode")).not.toBeNull();
    expect(reporterOfHarness("opencode")).toBe("podium-reporter-opencode");
    expect(check("99.0.0", "podium-reporter-opencode")).toBe("newer");
  });
});
