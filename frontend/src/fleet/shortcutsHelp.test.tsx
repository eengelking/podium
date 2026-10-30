// The word "Shortcuts" opens the list of every keyboard shortcut while the switch is On (#828, mockup/podium-shortcuts-help.html).
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { HistoryView } from "./HistoryView";
import { makeState } from "./fixtures";
import { SHORTCUTS, SHORTCUTS_HINT } from "./components/ThemePicker";
import { stateFrom } from "./testState";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "#/");
});

const sw = () => screen.getByRole("switch", { name: /^Shortcuts/ });
const link = () => screen.getByRole("button", { name: "Shortcuts" });
const dialog = () => screen.getByRole("dialog", { name: "Keyboard shortcuts" });

describe("the Shortcuts word while the switch is Off", () => {
  it("is a plain label: no button, no link, no dialog", () => {
    render(<FleetView state={stateFrom()} />);
    const row = screen.getByRole("region", { name: "Display settings" });
    expect(within(row).getByText("Shortcuts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Shortcuts" })).toBeNull();
    expect(row.querySelector(".kbd-link")).toBeNull();
  });
});

describe("the Shortcuts word while the switch is On", () => {
  it("is a button that opens Keyboard shortcuts, and is a plain label again when switched Off", () => {
    render(<FleetView state={stateFrom()} />);
    fireEvent.click(sw());
    expect(link()).toHaveClass("kbd-link");
    expect(link()).toHaveAttribute("type", "button");
    expect(link()).toHaveAttribute("aria-haspopup", "dialog");
    expect(sw()).toHaveAccessibleName("Shortcuts On");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(link());
    expect(dialog()).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(sw());
    expect(screen.queryByRole("button", { name: "Shortcuts" })).toBeNull();
  });

  it("shows every shortcut in two columns, each key in a chip, with the notes for Traffic and My reporters", () => {
    render(<FleetView state={stateFrom()} />);
    fireEvent.click(sw());
    fireEvent.click(link());
    const d = dialog();
    expect(within(d).getByText("Work anywhere outside a text field while Shortcuts is On.")).toBeInTheDocument();
    const cols = d.querySelectorAll(".kbd-cols > .kbd-col");
    expect(cols).toHaveLength(2);
    expect(d.querySelector(".kbd-cols > .pipe")).not.toBeNull();
    const chips = [...d.querySelectorAll(".kbd-col code")].map((c) => c.textContent);
    expect(chips).toEqual(["\\", "[", "]", "w", "Esc"]);
    expect(within(cols[0] as HTMLElement).getByText("Does nothing on Traffic, which has no rail.")).toBeInTheDocument();
    expect(within(cols[0] as HTMLElement).getByText("Does nothing on Traffic, which has no side panel.")).toBeInTheDocument();
    expect(within(cols[1] as HTMLElement).getByText("Does nothing on Traffic or My reporters, which draw no wall.")).toBeInTheDocument();
    expect(within(cols[1] as HTMLElement).getByText("Works with Shortcuts Off too.")).toBeInTheDocument();
  });

  it("closes with the X, with Esc and with a press on the dimmed area, and focus returns to the link", async () => {
    render(<FleetView state={stateFrom()} />);
    fireEvent.click(sw());
    for (const close of [
      () => fireEvent.click(within(dialog()).getByRole("button", { name: /^Close/ })),
      () => fireEvent.keyDown(document, { key: "Escape" }),
      () => fireEvent.mouseDown(document.querySelector(".scrim")!),
    ]) {
      fireEvent.click(link());
      expect(dialog()).toBeInTheDocument();
      close();
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(link()).toHaveFocus());
    }
  });

  it("is on History too", () => {
    vi.stubGlobal("EventSource", class { onerror = null; readyState = 1; addEventListener() {} close() {} });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ day: "2026-10-10", sessions: [], total: 0, page: 1, pageSize: 20 }), { status: 200 })));
    const quiet = { onerror: null, readyState: 1, addEventListener() {}, close() {} };
    render(<HistoryView initialDay="2026-10-10" fleetOptions={{ open: () => quiet, fetchState: async () => makeState() }} />);
    fireEvent.click(sw());
    fireEvent.click(link());
    expect(dialog()).toBeInTheDocument();
  });
});

describe("the one list of shortcuts", () => {
  it("feeds the modal and the switch's hint, so both name the same keys", () => {
    expect(SHORTCUTS.map((s) => s.keys)).toEqual(["\\", "[", "]", "w", "Esc"]);
    expect(SHORTCUTS_HINT).toBe("Press \\ for the top bar, [ and ] for the side panes, and w for wall mode. Esc leaves wall mode.");
    for (const s of SHORTCUTS) expect(SHORTCUTS_HINT).toContain(s.keys);
  });
});
