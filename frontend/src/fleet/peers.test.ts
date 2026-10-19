import { describe, expect, it } from "vitest";
import { asksBack, canSend, idPart, LEVEL_LABEL, messagingOff, reporterLook, rightsModel, rightWords, systemKind, withRight, type PeersRead, type PeerReporter } from "./peers";

const rep = (key: string, machine: string, over: Partial<PeerReporter> = {}): PeerReporter => ({ key, machine, owner: "Ed", adminSecret: false, os: "macOS 26.1", peers: true, version: "1.2.0", state: "reporting", lastSeenAt: 1, live: [], ...over });

function read(over: Partial<PeersRead> = {}): PeersRead {
  return {
    enabled: true,
    owner: "Ed",
    serverTime: 2,
    serverStartedAt: 0,
    reporters: [rep("k1", "ed-mbp"), rep("k2", "ci-runner-01", { os: "Ubuntu 24.04" }), rep("k3", "win-lab", { os: "Windows 11", peers: false })],
    rights: [{ from: "k1", to: "k2", owner: "Ed", level: "send", paused: false, setAt: 1 }],
    defaults: { trust: false, onRequest: "ask", newSend: "ask", limits: {} },
    limits: { server: { roundTrips: 10, perMinute: 6, maxChars: 20000 }, effective: { roundTrips: 10, perMinute: 6, maxChars: 20000 } },
    requests: [],
    ...over,
  };
}

describe("levels", () => {
  it("has one label per level", () => {
    expect(LEVEL_LABEL).toEqual({ none: "No access", see: "Can see", ask: "Can send, with approval", send: "Can send" });
  });

  it("counts both kinds of send as sending, and seeing as not", () => {
    expect(["none", "see", "ask", "send"].map((l) => canSend(l as never))).toEqual([false, false, true, true]);
  });
});

describe("rightsModel", () => {
  it("reads a stored right, and No access where there is none", () => {
    const m = rightsModel(read());
    expect(m.level("k1", "k2")).toBe("send");
    expect(m.level("k2", "k1")).toBe("none");
    expect(m.locked("k1", "k2")).toBe(false);
  });

  it("gives No access, locked, with the reason, when either machine has messaging off or is too old", () => {
    const m = rightsModel(read({ rights: [{ from: "k1", to: "k3", owner: "Ed", level: "send", paused: false, setAt: 1 }] }));
    expect(m.level("k1", "k3")).toBe("none");
    expect(m.locked("k3", "k1")).toBe(true);
    expect(m.off("k1", "k3")).toBe("Messaging is off on win-lab");
    const old = rightsModel(read({ reporters: [rep("k1", "ed-mbp"), rep("k4", "old-box", { peers: null })] }));
    expect(old.off("k4", "k1")).toBe("old-box's reporter can't message: update it");
    expect(old.off("k1", "gone")).toBe("That reporter is no longer listed");
  });

  it("makes every pair Can send and locks them under Trust my own reporters, still not across a machine with messaging off", () => {
    const m = rightsModel(read({ defaults: { trust: true, onRequest: "ask", newSend: "ask", limits: {} } }));
    expect(m.level("k2", "k1")).toBe("send");
    expect(m.locked("k2", "k1")).toBe(true);
    expect(m.level("k1", "k3")).toBe("none");
  });

  it("knows a paused direction and an Admin's proposal, found by reporter key", () => {
    const m = rightsModel(
      read({
        rights: [{ from: "k1", to: "k1", owner: "Ed", level: "send", paused: true, setAt: 1 }],
        requests: [
          { id: "prq_1", kind: "proposal", at: 1, from: { machine: "ci-runner-01", name: null }, to: { machine: "ed-mbp", name: null }, fromKey: "k2", toKey: "k1", level: "ask", by: "Admin", reason: null, text: null, messageId: null },
          { id: "prq_2", kind: "access", at: 1, from: { machine: "ed-mbp", name: "x" }, to: { machine: "ci-runner-01", name: null }, fromKey: "k1", toKey: "k2", level: "see", by: "x", reason: null, text: null, messageId: null },
        ],
      }),
    );
    expect(m.paused("k1", "k1")).toBe(true);
    expect(m.paused("k1", "k2")).toBe(false);
    expect(m.proposed("k2", "k1")).toBe("ask");
    expect(m.proposed("k1", "k2")).toBeNull();
  });

  it("puts a proposal on the right cell when two reporters share a machine name (#415)", () => {
    const m = rightsModel(
      read({
        reporters: [rep("k1", "ed-mbp"), rep("k5", "ed-mbp"), rep("k2", "ci-runner-01")],
        requests: [{ id: "prq_1", kind: "proposal", at: 1, from: { machine: "ed-mbp", name: null }, to: { machine: "ci-runner-01", name: null }, fromKey: "k5", toKey: "k2", level: "send", by: "Admin", reason: null, text: null, messageId: null }],
      }),
    );
    expect(m.proposed("k5", "k2")).toBe("send");
    expect(m.proposed("k1", "k2")).toBeNull();
  });
});

describe("asksBack", () => {
  it("asks when A newly can send to B, between two machines, and B cannot send back", () => {
    expect(asksBack("none", "send", "none", "a", "b")).toBe(true);
    expect(asksBack("see", "ask", "see", "a", "b")).toBe(true);
  });

  it("does not ask within one machine, for a right that already sent, for seeing only, or when B can already answer", () => {
    expect(asksBack("none", "send", "none", "a", "a")).toBe(false);
    expect(asksBack("ask", "send", "none", "a", "b")).toBe(false);
    expect(asksBack("none", "see", "none", "a", "b")).toBe(false);
    expect(asksBack("none", "send", "ask", "a", "b")).toBe(false);
  });
});

describe("words", () => {
  it("says a right around the second machine", () => {
    expect(rightWords("ask")).toEqual(["can send to", ", with approval"]);
    expect(rightWords("send")).toEqual(["can send to", ""]);
    expect(rightWords("see")).toEqual(["can see", ""]);
    expect(rightWords("see", true)).toEqual(["can only see", ""]);
    expect(rightWords("none")).toEqual(["has no access to", ""]);
  });

  it("says why a reporter cannot take part", () => {
    expect(messagingOff({ machine: "m", peers: true })).toBeNull();
    expect(messagingOff({ machine: "m", peers: false })).toBe("Messaging is off on m");
  });

  it("makes a key safe for an id", () => {
    expect(idPart("addr:10.0.0.1")).toBe("addr_10_0_0_1");
  });
});

describe("systemKind", () => {
  it("picks an icon family from the reported system, and none when there is none", () => {
    expect(systemKind("macOS 26.1")).toBe("mac");
    expect(systemKind("Darwin 25")).toBe("mac");
    expect(systemKind("Windows 11")).toBe("win");
    expect(systemKind("Ubuntu 24.04")).toBe("linux");
    expect(systemKind(null)).toBeNull();
  });
});

describe("reporterLook", () => {
  it("takes the newest live session's compatibility, and no state of its own: the server gives that (#415)", () => {
    const look = reporterLook({ live: [{ sessionId: "s1", name: "a", status: "running", peers: true }, { sessionId: "s2", name: "b", status: "waiting", peers: true }, { sessionId: "gone", name: "c", status: "waiting", peers: true }] }, {
      s1: { lastSeenAt: 10, compat: "ok" },
      s2: { lastSeenAt: 20, compat: "outdated" },
    });
    expect(look).toEqual({ compat: "outdated" });
  });

  it("has no compatibility when no orchestrator is live", () => {
    expect(reporterLook({ live: [] }, {})).toEqual({ compat: null });
  });
});

describe("withRight", () => {
  it("adds, changes and removes a direction, keeping a pause", () => {
    const d = read();
    expect(withRight(d, "k2", "k1", "see").rights).toContainEqual(expect.objectContaining({ from: "k2", to: "k1", level: "see" }));
    expect(withRight(d, "k1", "k2", "ask").rights).toEqual([expect.objectContaining({ from: "k1", to: "k2", level: "ask", setAt: 1 })]);
    expect(withRight(d, "k1", "k2", "none").rights).toEqual([]);
    const paused = read({ rights: [{ from: "k1", to: "k2", owner: "Ed", level: "send", paused: true, setAt: 1 }] });
    expect(withRight(paused, "k1", "k2", "none").rights).toEqual([expect.objectContaining({ level: "none", paused: true })]);
  });
});
