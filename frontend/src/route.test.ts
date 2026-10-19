import { describe, expect, it } from "vitest";
import { routeFor } from "./route";

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
