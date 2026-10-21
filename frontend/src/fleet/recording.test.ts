// What the console says about a session recording (#353): the words of the band, the layer, the cell and the replay header, and
// the rules for who may choose what to record.
import { afterEach, describe, expect, it } from "vitest";
import { makeAgent, makeRecording, makeSession } from "./fixtures";
import { bandWords, cellWords, fmtAt, fmtWhen, isLiveSession, joinWords, leaveReplay, loopNames, mayRecord, openReplay, pickerState, pickRows, replayLine, stoppedWords } from "./recording";
import type { RecordingGrant, RespondMe } from "./types";

const at = (h: number, m: number, day = 20) => new Date(2026, 9, day, h, m).getTime();
const NOW = at(12, 0);
const ME: RespondMe = { enabled: true, signedIn: true, name: "Ed", admin: false };
const ADMIN: RespondMe = { enabled: true, signedIn: true, name: "Priya", admin: true };
const OUT: RespondMe = { enabled: true, signedIn: false, name: null, admin: false };

const grant = (over: Partial<RecordingGrant> = {}): RecordingGrant => ({
  state: "recording",
  consent: { admin: true, chosen: true, owner: true },
  loops: ["@orchestrator"],
  limit: null,
  startedBy: "Maya Okafor",
  startedAt: at(11, 42),
  stoppedBy: null,
  stoppedAt: null,
  keptUntil: at(17, 42),
  bytes: 1024,
  ...over,
});

describe("times", () => {
  it("writes the time of day with two digits", () => {
    expect(fmtAt(at(9, 5))).toBe("09:05");
  });

  it("says today for the same day, and the whole date for another", () => {
    expect(fmtWhen(at(17, 42), NOW)).toBe("17:42 today");
    expect(fmtWhen(at(17, 42), NOW, false)).toBe("17:42");
    expect(fmtWhen(at(3, 10, 21), NOW)).toBe("2026-10-21 03:10");
    expect(fmtWhen(at(3, 10, 21), NOW, false)).toBe("2026-10-21 03:10");
  });
});

describe("who may record", () => {
  it("is the session's owner or an Admin, signed in", () => {
    expect(mayRecord({ owner: "Ed" }, ME)).toBe(true);
    expect(mayRecord({ owner: "Maya" }, ME)).toBe(false);
    expect(mayRecord({ owner: "Maya" }, ADMIN)).toBe(true);
    expect(mayRecord({ owner: "Ed" }, OUT)).toBe(false);
    expect(mayRecord({ owner: "Ed" }, null)).toBe(false);
  });

  it("is possible only while the session runs", () => {
    expect(isLiveSession({ status: "running" })).toBe(true);
    expect(isLiveSession({ status: "done" })).toBe(false);
  });
});

describe("the picker's rows", () => {
  it("lists the orchestrator, then each agent and fork, with what it is", () => {
    const rows = pickRows({
      name: "api-refactor",
      agents: [
        makeAgent({ id: "p", description: "Port the endpoints" }),
        makeAgent({ id: "f", parentId: "p", kind: "fork", description: "Try the second approach" }),
        makeAgent({ id: "g", parentId: "gone", description: "Orphan" }),
        makeAgent({ id: "h", parentId: "h", description: "Self" }),
      ],
    });
    expect(rows.map((r) => [r.loop, r.label, r.detail])).toEqual([
      ["@orchestrator", "api-refactor", "The orchestrator"],
      ["p", "Port the endpoints", "Agent, launched by the orchestrator"],
      ["f", "Try the second approach", "Fork of Port the endpoints"],
      ["g", "Orphan", "Agent, launched by the orchestrator"],
      ["h", "Self", "Agent, launched by the orchestrator"],
    ]);
  });
});

describe("words", () => {
  it("joins a list the way a sentence does", () => {
    expect(joinWords([])).toBe("");
    expect(joinWords(["a"])).toBe("a");
    expect(joinWords(["a", "b"])).toBe("a and b");
    expect(joinWords(["a", "b", "c"])).toBe("a, b and c");
  });

  it("names the recorded loops and the others", () => {
    expect(loopNames(makeRecording().loops)).toEqual({ recorded: ["api-refactor", "schema-writer"], not: ["docs-agent"] });
  });
});

describe("the card's band", () => {
  it("says what is recorded when some loops are not", () => {
    expect(bandWords(makeRecording(), NOW)).toEqual({ head: "Recording 2 of 3 loops", small: "api-refactor and schema-writer. Maya Okafor started it. Deleted at 17:42." });
  });

  it("says everything when every loop is recorded, and drops the time when none is kept", () => {
    const loops = makeRecording().loops.map((l) => ({ ...l, recorded: true }));
    expect(bandWords(makeRecording({ loops, keptUntil: null }), NOW)).toEqual({ head: "Recording everything", small: "Maya Okafor started it." });
    expect(bandWords(makeRecording({ loops, startedBy: null }), NOW)!.small).toMatch(/^Someone started it/);
  });

  it("says one loop in the singular", () => {
    const one = makeRecording({ loops: [{ loop: "@orchestrator", name: "solo", recorded: true }, { loop: "x", name: "x", recorded: false }] });
    expect(bandWords(one, NOW)!.head).toBe("Recording 1 of 2 loops");
    expect(bandWords(makeRecording({ loops: [{ loop: "x", name: "x", recorded: false }] }), NOW)!.head).toBe("Recording 0 of 1 loop");
  });

  it("says nothing is captured when the owner has not allowed it, and draws nothing for a kept recording", () => {
    expect(bandWords(makeRecording({ ownerAllows: false }), NOW)!.head).toBe("Recording chosen, nothing captured");
    expect(bandWords(makeRecording({ state: "stopped" }), NOW)).toBeNull();
    expect(bandWords(makeRecording({ state: "limit", limit: "session" }), NOW)).toBeNull();
  });
});

describe("why a kept recording stopped", () => {
  it("names who stopped it and when", () => {
    expect(stoppedWords(makeRecording({ state: "stopped", stoppedBy: "Ed", stoppedAt: at(13, 2) }), false)).toBe("Ed stopped the recording at 13:02.");
    expect(stoppedWords(makeRecording({ state: "stopped", stoppedBy: "Ed" }), false)).toBe("Ed stopped the recording.");
  });

  it("says the session ended, or that it stopped", () => {
    expect(stoppedWords(makeRecording({ state: "stopped" }), true)).toBe("The session ended.");
    expect(stoppedWords(makeRecording({ state: "stopped" }), false)).toBe("Recording stopped.");
  });

  it("names the limit that stopped it", () => {
    expect(stoppedWords(makeRecording({ state: "limit", limit: "budget" }), false)).toMatch(/disk budget/);
    expect(stoppedWords(makeRecording({ state: "limit", limit: "session" }), false)).toMatch(/limit for one session/);
  });
});

describe("the Recording cell's words", () => {
  it("says Recording while it captures, and when it goes", () => {
    expect(cellWords(makeRecording(), NOW)).toEqual({ text: "Recording", title: "Recording. Deleted at 17:42 today." });
    expect(cellWords(makeRecording({ keptUntil: null }), NOW).title).toBe("Recording.");
  });

  it("says Chosen when the owner has not allowed it", () => {
    expect(cellWords(makeRecording({ ownerAllows: false }), NOW).text).toBe("Chosen");
  });

  it("says Kept until for a recording that is only kept", () => {
    expect(cellWords(makeRecording({ state: "stopped" }), NOW)).toEqual({ text: "Kept until 17:42", title: "Capture has ended. The recording is kept until 17:42 today, then deleted." });
    expect(cellWords(makeRecording({ state: "stopped", keptUntil: null }), NOW)).toEqual({ text: "Kept", title: "Capture has ended. The recording is kept, then deleted." });
  });
});

describe("the replay's header line", () => {
  it("names who started a recording that is still running", () => {
    expect(replayLine(grant(), false, NOW)).toBe("Recorded from 11:42 by Maya Okafor. Deleted at 17:42 today.");
    expect(replayLine(grant({ startedBy: null, keptUntil: null }), false, NOW)).toBe("Recorded from 11:42.");
    expect(replayLine(grant({ startedAt: null }), false, NOW)).toMatch(/^Recorded\./);
  });

  it("says who stopped it, or that the session ended", () => {
    expect(replayLine(grant({ state: "stopped", stoppedBy: "Maya Okafor", stoppedAt: at(13, 2) }), false, NOW)).toBe("Recorded 11:42 to 13:02. Maya Okafor stopped it, so nothing after 13:02 was kept. Deleted at 17:42 today.");
    expect(replayLine(grant({ state: "stopped", stoppedAt: at(14, 18) }), true, NOW)).toMatch(/The session ended\./);
    expect(replayLine(grant({ state: "recording" }), true, NOW)).toMatch(/The session ended\./);
    expect(replayLine(grant({ state: "stopped", stoppedBy: "Ed" }), false, NOW)).toMatch(/nothing after that was kept/);
  });

  it("says which limit stopped it", () => {
    expect(replayLine(grant({ state: "limit", limit: "session", stoppedAt: at(13, 40) }), false, NOW)).toMatch(/limit for one session, so later work was not kept/);
    expect(replayLine(grant({ state: "limit", limit: "budget", stoppedAt: at(13, 40) }), false, NOW)).toMatch(/disk budget/);
  });
});

describe("what the picker says", () => {
  const s = (over = {}) => makeSession({ owner: "Ed", status: "running", ...over });
  const on = { flagOn: true, me: ME, s: s(), grant: null };

  it("walks through the states in order", () => {
    expect(pickerState({ ...on, flagOn: false })).toBe("adminoff");
    expect(pickerState({ ...on, me: OUT })).toBe("signin");
    expect(pickerState({ ...on, s: s({ owner: "Maya" }) })).toBe("other");
    expect(pickerState({ ...on, s: s({ status: "done" }) })).toBe("ended");
    expect(pickerState(on)).toBe("ok");
    expect(pickerState({ ...on, me: ADMIN })).toBe("ok");
  });

  it("says the owner has not allowed it, from the reply to Start or from the session's recording", () => {
    expect(pickerState({ ...on, grant: grant({ consent: { admin: true, chosen: true, owner: false } }) })).toBe("noown");
    expect(pickerState({ ...on, s: s({ recording: makeRecording({ ownerAllows: false }) }) })).toBe("noown");
    expect(pickerState({ ...on, s: s({ recording: makeRecording({ state: "stopped", ownerAllows: false }) }) })).toBe("ok");
  });

  it("says the owner has not allowed it before Start, from the consent the server gave, until Start's own reply says otherwise", () => {
    expect(pickerState({ ...on, ownerAllows: false })).toBe("noown");
    expect(pickerState({ ...on, ownerAllows: true })).toBe("ok");
    expect(pickerState({ ...on, ownerAllows: null })).toBe("ok");
    expect(pickerState({ ...on, ownerAllows: false, grant: grant() })).toBe("started");
    expect(pickerState({ ...on, ownerAllows: false, flagOn: false })).toBe("adminoff");
    expect(pickerState({ ...on, ownerAllows: false, s: s({ status: "done" }) })).toBe("ended");
  });

  it("says it started once Start was answered", () => {
    expect(pickerState({ ...on, grant: grant() })).toBe("started");
    expect(pickerState({ ...on, grant: grant({ state: "stopped" }) })).toBe("ok");
  });
});

describe("the replay's address", () => {
  afterEach(() => window.history.replaceState(null, "", "#/"));

  it("opens a replay with a marked entry and tells the page", () => {
    let heard = 0;
    const on = () => heard++;
    window.addEventListener("hashchange", on);
    openReplay("s 1");
    window.removeEventListener("hashchange", on);
    expect(window.location.hash).toBe("#/?open=s+1&replay");
    expect(window.history.state).toEqual({ replay: true });
    expect(heard).toBe(1);
  });

  it("goes back when the console pushed the replay", () => {
    window.history.pushState({ replay: true }, "", "#/?open=s1&replay");
    let went = 0;
    const back = window.history.back.bind(window.history);
    window.history.back = () => {
      went++;
      return back();
    };
    leaveReplay("s1", true);
    window.history.back = back;
    expect(went).toBe(1);
  });

  it("goes to the session's page, or to History's for one that ended, when it was reached by a link", () => {
    window.history.replaceState(null, "", "#/?open=s1&replay");
    leaveReplay("s1", true);
    expect(window.location.hash).toBe("#/?open=s1");
    leaveReplay("s 2", false);
    expect(window.location.hash).toBe("#/history?open=s%202");
  });
});
