import { describe, expect, it } from "vitest";
import { versionNote } from "./components/SessionCard";
import { compatText } from "./admin/ReportersTab";

describe("the version warning names the reporter (#852)", () => {
  it("says which reporter is out of its range on a session", () => {
    const claude = versionNote({ compat: "outdated", reporterVersion: "0.1.0", reporterName: "podium-reporter" })!;
    expect(claude.text).toContain("podium-reporter 0.1.0");
    expect(claude.text).toContain("claude plugin update podium-reporter@eengelking-marketplace");
    const other = versionNote({ compat: "outdated", reporterVersion: "0.1.0", reporterName: "opencode-reporter" })!;
    expect(other.text).toContain("opencode-reporter 0.1.0");
    expect(other.text).toContain("Update opencode-reporter.");
    expect(other.text).not.toContain("claude plugin update");
    expect(versionNote({ compat: "newer", reporterVersion: "9.0.0", reporterName: "opencode-reporter" })!.text).toContain("opencode-reporter 9.0.0");
  });

  it("shows nothing for a reporter inside its range or with none", () => {
    expect(versionNote({ compat: "ok", reporterVersion: "1.0.0", reporterName: "opencode-reporter" })).toBeNull();
    expect(versionNote({ compat: "unknown", reporterVersion: "1.0.0", reporterName: "opencode-reporter" })).toBeNull();
  });

  it("names the reporter in the Admin compatibility text", () => {
    expect(compatText("outdated", "opencode-reporter")).toContain("for opencode-reporter");
    expect(compatText("newer", "opencode-reporter")).toContain("for opencode-reporter");
    expect(compatText("ok", "opencode-reporter")).toBe("Supported");
    expect(compatText("unknown", "opencode-reporter")).toBe("There is no version to check.");
  });
});
