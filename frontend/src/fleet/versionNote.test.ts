import { describe, expect, it } from "vitest";
import { versionNote } from "./components/SessionCard";
import { compatText } from "./admin/ReportersTab";
import { reporterKind, updateSentence } from "./reporterUpdate";

describe("the version warning names the reporter (#852)", () => {
  it("says which reporter is out of its range on a session", () => {
    const claude = versionNote({ compat: "outdated", reporterVersion: "0.1.0", reporterName: "podium-reporter-claudecode" })!;
    expect(claude.text).toContain("podium-reporter-claudecode 0.1.0");
    expect(claude.text).toContain("Update the Claude Code reporter: run claude plugin update podium-reporter@eengelking-marketplace");
    expect(versionNote({ compat: "outdated", reporterVersion: "0.1.0", reporterName: "podium-reporter" })!.text).toContain("claude plugin update");
    const other = versionNote({ compat: "outdated", reporterVersion: "0.1.0", reporterName: "podium-reporter-opencode" })!;
    expect(other.text).toContain("podium-reporter-opencode 0.1.0");
    expect(other.text).toContain("Update the OpenCode reporter: run opencode plugin update, then opencode service restart.");
    expect(other.text).not.toContain("claude plugin update");
    expect(versionNote({ compat: "newer", reporterVersion: "9.0.0", reporterName: "podium-reporter-opencode" })!.text).toContain("podium-reporter-opencode 9.0.0");
  });

  it("falls back to naming the reporter for a name it does not know", () => {
    expect(updateSentence("nobody-reporter")).toBe("Update nobody-reporter.");
    expect(reporterKind("podium-reporter")).toBe("claudecode");
  });

  it("shows nothing for a reporter inside its range or with none", () => {
    expect(versionNote({ compat: "ok", reporterVersion: "1.0.0", reporterName: "podium-reporter-opencode" })).toBeNull();
    expect(versionNote({ compat: "unknown", reporterVersion: "1.0.0", reporterName: "podium-reporter-opencode" })).toBeNull();
  });

  it("names the reporter in the Admin compatibility text", () => {
    expect(compatText("outdated", "podium-reporter-opencode")).toContain("for podium-reporter-opencode");
    expect(compatText("newer", "podium-reporter-opencode")).toContain("for podium-reporter-opencode");
    expect(compatText("outdated", "podium-reporter-opencode")).toContain("Update the OpenCode reporter.");
    expect(compatText("outdated", "podium-reporter-claudecode")).toContain("Update the Claude Code reporter.");
    expect(compatText("outdated", "nobody-reporter")).toContain("Update nobody-reporter.");
    expect(compatText("ok", "podium-reporter-opencode")).toBe("Supported");
    expect(compatText("unknown", "podium-reporter-opencode")).toBe("There is no version to check.");
  });
});
