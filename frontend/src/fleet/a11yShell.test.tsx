// What every route must tell a screen reader before anything else (#636): a page title that says where the person is,
// one h1 that names the page, and the row of display controls under the top bar inside a landmark.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { HistoryView } from "./HistoryView";
import { atWall, stateFrom } from "./testState";
import { makeSession } from "./fixtures";

beforeEach(() => {
  localStorage.clear();
  atWall();
  document.title = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "#/");
});

describe("the page title follows the route", () => {
  it("says Podium on the wall", () => {
    render(<FleetView state={stateFrom()} />);
    expect(document.title).toBe("Podium");
  });

  it("names the board", () => {
    render(<FleetView board state={stateFrom()} />);
    expect(document.title).toBe("Podium board");
  });

  it("names Traffic and My reporters", () => {
    const { unmount } = render(<FleetView traffic state={stateFrom()} />);
    expect(document.title).toBe("Podium traffic");
    unmount();
    render(<FleetView myReporters state={stateFrom()} />);
    expect(document.title).toBe("Podium my reporters");
  });

  it("names the orchestrator that is open", () => {
    window.history.replaceState(null, "", "#/?open=s1");
    render(<FleetView state={stateFrom({ sessions: [makeSession({ id: "s1", name: "api-refactor" })] })} />);
    expect(document.title).toBe("api-refactor - Podium");
  });
});

describe("one h1 names the page", () => {
  it("is on the wall", () => {
    render(<FleetView state={stateFrom()} />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Fleet");
  });

  it("is on the board", () => {
    render(<FleetView board state={stateFrom()} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Board");
  });

  it("is on History", () => {
    vi.stubGlobal("EventSource", class { onerror = null; readyState = 1; addEventListener() {} close() {} });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ day: "2026-10-10", sessions: [], total: 0, page: 1, pageSize: 20 }), { status: 200 })));
    render(<HistoryView initialDay="2026-10-10" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("History");
  });

  it("stays the orchestrator's name when one is open, and is still one", () => {
    window.history.replaceState(null, "", "#/?open=s1");
    render(<FleetView state={stateFrom({ sessions: [makeSession({ id: "s1", name: "api-refactor" })] })} />);
    const h1 = screen.getAllByRole("heading", { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]).toHaveTextContent("api-refactor");
  });
});

describe("the display settings row", () => {
  it("is a labelled region holding the refresh and theme controls", () => {
    render(<FleetView state={stateFrom()} />);
    const row = screen.getByRole("region", { name: "Display settings" });
    expect(within(row).getByRole("combobox", { name: /refresh every/i })).toBeInTheDocument();
  });

  it("is one on History too", () => {
    vi.stubGlobal("EventSource", class { onerror = null; readyState = 1; addEventListener() {} close() {} });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ day: "2026-10-10", sessions: [], total: 0, page: 1, pageSize: 20 }), { status: 200 })));
    render(<HistoryView initialDay="2026-10-10" />);
    expect(screen.getByRole("region", { name: "Display settings" })).toBeInTheDocument();
  });

  it("is one on Traffic and My reporters too", () => {
    const { unmount } = render(<FleetView traffic state={stateFrom()} />);
    expect(screen.getByRole("region", { name: "Display settings" })).toBeInTheDocument();
    unmount();
    render(<FleetView myReporters state={stateFrom()} />);
    expect(screen.getByRole("region", { name: "Display settings" })).toBeInTheDocument();
  });
});

describe("the Agents tree", () => {
  it("has no table row without a table around it, and its sort buttons are a labelled group", () => {
    window.history.replaceState(null, "", "#/?open=s1");
    render(<FleetView state={stateFrom({ sessions: [makeSession({ id: "s1", name: "api-refactor" })] })} />);
    expect(screen.queryAllByRole("row")).toHaveLength(0);
    const sort = screen.getByRole("group", { name: "Sort the agents" });
    expect(within(sort).getByRole("button", { name: "Cost" })).toBeInTheDocument();
  });
});

describe("a control's name contains the words it shows (2.5.3)", () => {
  const open = () => {
    window.history.replaceState(null, "", "#/?open=s1abcdef123");
    render(<FleetView state={stateFrom({ sessions: [makeSession({ id: "s1abcdef123", name: "api-refactor", resumeCommand: "cd /x && claude --resume s1", forkCommand: "cd /x && claude --resume s1 --fork-session" })] })} />);
  };

  it.each([
    ["Resume", "Command"],
    ["Fork", "Command"],
    ["Session", "s1abcdef"],
  ])("%s: its label and its value read as two words, and its name holds both", (label, value) => {
    open();
    const btn = screen.getByText(label, { selector: ".cellbtn .k" }).closest("button") as HTMLElement;
    expect(btn.textContent).toMatch(new RegExp(`${label}\\s+${value}`));
    const name = btn.getAttribute("aria-label") ?? "";
    expect(name.toLowerCase()).toContain(`${label} ${value}`.toLowerCase());
  });
});
