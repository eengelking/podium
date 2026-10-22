import { describe, expect, it } from "vitest";
import { fleetHash, openIn, routeFor, replayHash, replayIn } from "./route";

describe("routeFor", () => {
  it("opens the history view for #/history, with or without a query", () => {
    expect(routeFor("#/history")).toBe("history");
    expect(routeFor("#/history?day=2026-10-10")).toBe("history");
  });

  it("opens the kanban board for #/board, with or without a query", () => {
    expect(routeFor("#/board")).toBe("board");
    expect(routeFor("#/board?x=1")).toBe("board");
    expect(routeFor("#/boardroom")).toBe("fleet");
  });

  it("opens My reporters for #/me/reporters only", () => {
    expect(routeFor("#/me/reporters")).toBe("my-reporters");
    expect(routeFor("#/me")).toBe("fleet");
    expect(routeFor("#/me/reporters-x")).toBe("fleet");
  });

  it("opens Traffic for #/traffic only (#417)", () => {
    expect(routeFor("#/traffic")).toBe("traffic");
    expect(routeFor("#/traffic-x")).toBe("fleet");
  });

  it("opens Admin for #/admin", () => {
    expect(routeFor("#/admin")).toBe("admin");
  });

  it("opens the fleet console for #/, an empty hash and anything unknown", () => {
    expect(routeFor("")).toBe("fleet");
    expect(routeFor("#/")).toBe("fleet");
    expect(routeFor("#/nope")).toBe("fleet");
  });

  it("lands the retired #/usage page on the fleet console", () => {
    expect(routeFor("#/usage")).toBe("fleet");
    expect(routeFor("#/usage?x=1")).toBe("fleet");
  });
});

describe("the open orchestrator in the address", () => {
  it("reads open= from the fleet console's hash", () => {
    expect(openIn("#/?open=s1")).toBe("s1");
    expect(openIn("#/?open=a%20b%2Fc")).toBe("a b/c");
  });

  it("is none on the wall, with an empty open= or on another page", () => {
    expect(openIn("")).toBeNull();
    expect(openIn("#/")).toBeNull();
    expect(openIn("#/?open=")).toBeNull();
    expect(openIn("#/board?open=s1")).toBeNull();
    expect(openIn("#/history?day=2026-10-10&open=s1")).toBeNull();
  });

  it("writes an address that reads back to the same orchestrator, and #/ for the wall", () => {
    expect(fleetHash(null)).toBe("#/");
    expect(fleetHash("s1")).toBe("#/?open=s1");
    expect(routeFor(fleetHash("a b/c&d"))).toBe("fleet");
    expect(openIn(fleetHash("a b/c&d"))).toBe("a b/c&d");
  });
});

describe("the replay in the address (#353)", () => {
  it("is #/?open=<id>&replay, still the fleet console and still the open orchestrator", () => {
    expect(replayHash("s1")).toBe("#/?open=s1&replay");
    expect(routeFor(replayHash("s1"))).toBe("fleet");
    expect(openIn(replayHash("s1"))).toBe("s1");
    expect(replayIn(replayHash("a b/c&d"))).toBe("a b/c&d");
  });

  it("is none without the flag, without a session, and on another page", () => {
    expect(replayIn("#/?open=s1")).toBeNull();
    expect(replayIn("#/?replay")).toBeNull();
    expect(replayIn("#/")).toBeNull();
    expect(replayIn("#/history?open=s1&replay")).toBeNull();
  });
});
