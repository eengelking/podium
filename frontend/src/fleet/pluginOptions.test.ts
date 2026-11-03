import { describe, expect, it } from "vitest";
import { DESKTOP_OPTIONS, harnessesOnMachine, harnessesToShow, OPTION_CMD, optionVariable, turnOnText, turnOnTexts } from "./pluginOptions";

describe("pluginOptions (#857)", () => {
  it("names the variable that turns each consent option on, the way the reporters read it", () => {
    // The same table as CONSENT_VARS in plugin/core/settings.ts, which the frontend cannot import (its own build refuses the .ts extensions there).
    const consentVars = { respond: "PODIUM_RESPOND", peers: "PODIUM_PEERS", sessionRecording: "PODIUM_SESSION_RECORDING", fullPrompts: "PODIUM_FULL_PROMPTS", activityFeed: "PODIUM_ACTIVITY_FEED", activityOutput: "PODIUM_ACTIVITY_OUTPUT", fileDiff: "PODIUM_FILE_DIFF" };
    for (const [option, variable] of Object.entries(consentVars)) expect(optionVariable(option), option).toBe(variable);
  });

  it("keeps Claude Code's words and adds OpenCode's", () => {
    expect(turnOnText("claude-code", "peers")).toBe(`In Claude Code there, run ${OPTION_CMD} and set peers to on. In the Claude desktop app there, open ${DESKTOP_OPTIONS} and turn on peers.`);
    expect(turnOnText("opencode", "sessionRecording")).toBe("In OpenCode there, add PODIUM_SESSION_RECORDING=true to ~/.podium/config.env, then run opencode service restart.");
    expect(turnOnTexts(["claude-code", "opencode"], "peers")).toBe(`${turnOnText("claude-code", "peers")} ${turnOnText("opencode", "peers")}`);
  });

  it("finds the harnesses on a machine from its sessions, by the row's key, and reads a missing harness as Claude Code", () => {
    const sessions = [
      { harness: "opencode", machine: { id: "m1" } },
      { harness: null, machine: { id: "m1" } },
      { harness: "opencode", machine: { id: "m2" } },
      { harness: "opencode", machine: null },
      { harness: "other-harness", machine: { id: "m3" } },
    ];
    expect(harnessesOnMachine(sessions, "m1")).toEqual(["claude-code", "opencode"]);
    expect(harnessesOnMachine(sessions, "m2@opencode")).toEqual(["opencode"]);
    expect(harnessesOnMachine(sessions, "m3")).toEqual([]);
    expect(harnessesOnMachine(sessions, "none")).toEqual([]);
  });

  it("explains every harness when none is known, and only the known ones otherwise", () => {
    expect(harnessesToShow([])).toEqual(["claude-code", "opencode"]);
    expect(harnessesToShow(["opencode"])).toEqual(["opencode"]);
  });
});
