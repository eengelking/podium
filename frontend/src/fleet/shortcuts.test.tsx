// The single-key shortcuts \ [ ] w are off until a person turns the Shortcuts switch on (#636, WCAG 2.1.4). The choice is per browser.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, renderHook, act } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { HistoryView } from "./HistoryView";
import { AdminView } from "./admin/AdminView";
import { fakeServer } from "./admin/fakeAdmin";
import { stateFrom } from "./testState";
import { makeState } from "./fixtures";
import { SHORTCUTS_KEY, useShortcuts } from "./useShortcuts";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "#/");
});

const left = () => screen.getByRole("button", { name: /left pane/i });
const right = () => screen.getByRole("button", { name: /right pane/i });
const sw = () => screen.getByRole("switch", { name: /^Shortcuts/ });
const press = (key: string) => fireEvent.keyDown(document, { key });
const stored = () => JSON.parse(localStorage.getItem(SHORTCUTS_KEY) ?? "null");

describe("the keys while Shortcuts is off (the default)", () => {
  it("do nothing: \\ [ ] and w leave the panes and the wall alone", () => {
    const { container } = render(<FleetView state={stateFrom()} />);
    for (const key of ["\\", "[", "]", "w", "W"]) press(key);
    expect(left()).toHaveAttribute("aria-expanded", "true");
    expect(right()).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("podium-top")).toBeVisible();
    expect(container.querySelector(".podium")).not.toHaveClass("wall-on");
    expect(localStorage.getItem("podium.collapsed")).toBeNull();
  });

  it("do nothing when the stored value is not exactly true", () => {
    localStorage.setItem(SHORTCUTS_KEY, JSON.stringify("yes"));
    render(<FleetView state={stateFrom()} />);
    press("[");
    expect(left()).toHaveAttribute("aria-expanded", "true");
  });

  it("do nothing when the stored value is not JSON", () => {
    localStorage.setItem(SHORTCUTS_KEY, "{not json");
    render(<FleetView state={stateFrom()} />);
    press("[");
    expect(left()).toHaveAttribute("aria-expanded", "true");
  });

  it("leave Esc working: it still leaves wall mode, and the buttons still work", () => {
    render(<FleetView state={stateFrom()} />);
    fireEvent.click(screen.getByRole("button", { name: "Enter wall mode" }));
    expect(left()).toHaveAttribute("aria-expanded", "false");
    press("Escape");
    expect(left()).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(left());
    expect(left()).toHaveAttribute("aria-expanded", "false");
  });

  it("are not named by the pane tips or the Wall mode button's title", () => {
    render(<FleetView state={stateFrom()} />);
    expect(left()).toHaveAttribute("data-tip", "Collapse the left pane");
    expect(right()).toHaveAttribute("data-tip", "Collapse the right pane");
    expect(screen.getByRole("button", { name: "Enter wall mode" })).toHaveAttribute("title", "Collapse everything for a wall display");
    fireEvent.click(left());
    expect(left()).toHaveAttribute("data-tip", "Expand the left pane");
  });

  it("still name Esc on the Exit wall mode button, which is not a printable key", () => {
    render(<FleetView state={stateFrom()} />);
    fireEvent.click(screen.getByRole("button", { name: "Enter wall mode" }));
    expect(screen.getByRole("button", { name: "Exit wall mode" })).toHaveAttribute("title", "Exit wall mode (Esc)");
  });
});

describe("the Shortcuts switch", () => {
  it("is named Shortcuts, starts Off, has a hint that names the four keys, and is a focusable button", () => {
    render(<FleetView state={stateFrom()} />);
    const row = screen.getByRole("region", { name: "Display settings" });
    const s = within(row).getByRole("switch", { name: "Shortcuts Off" });
    expect(s).toBe(sw());
    expect(s).toHaveAttribute("aria-checked", "false");
    expect(s.tagName).toBe("BUTTON");
    expect(s).toHaveAttribute("type", "button");
    s.focus();
    expect(s).toHaveFocus();
    const hint = "Press \\ for the top bar, [ and ] for the side panes, and w for wall mode. Esc leaves wall mode.";
    expect(s).toHaveAttribute("title", hint);
    expect(s).toHaveAccessibleDescription(hint);
    expect(s.closest(".field")).not.toBeNull();
    expect(s.parentElement).toHaveClass("sw");
  });

  it("sits in the banner's controls, between Refresh every and Theme", () => {
    render(<FleetView state={stateFrom()} />);
    const ctl = screen.getByRole("region", { name: "Display settings" }).querySelector(".bannerctl")!;
    const names = [...ctl.children].map((c) => c.textContent ?? "");
    expect(names[0]).toMatch(/^Refresh every/);
    expect(names[1]).toMatch(/^Shortcuts/);
    expect(names[2]).toMatch(/^Theme/);
  });

  it("turns the four keys on, persists, and names them in the tips and the Wall mode title", () => {
    const { container } = render(<FleetView state={stateFrom()} />);
    fireEvent.click(sw());
    expect(sw()).toHaveAttribute("aria-checked", "true");
    expect(sw()).toHaveAccessibleName("Shortcuts On");
    expect(stored()).toBe(true);
    expect(left()).toHaveAttribute("data-tip", "Collapse the left pane ([)");
    expect(right()).toHaveAttribute("data-tip", "Collapse the right pane (])");
    expect(screen.getByRole("button", { name: "Enter wall mode" })).toHaveAttribute("title", "Collapse everything for a wall display (w)");
    press("[");
    expect(left()).toHaveAttribute("aria-expanded", "false");
    expect(left()).toHaveAttribute("data-tip", "Expand the left pane ([)");
    press("]");
    expect(right()).toHaveAttribute("aria-expanded", "false");
    press("\\");
    expect(document.getElementById("podium-top")).not.toBeVisible();
    press("\\");
    expect(document.getElementById("podium-top")).toBeVisible();
    press("w");
    expect(container.querySelector(".podium")).toHaveClass("wall-on");
    press("Escape");
    expect(container.querySelector(".podium")).not.toHaveClass("wall-on");
  });

  it("is still on after a remount, in a new view of the page", () => {
    const first = render(<FleetView state={stateFrom()} />);
    fireEvent.click(sw());
    first.unmount();
    render(<FleetView state={stateFrom()} />);
    expect(sw()).toHaveAttribute("aria-checked", "true");
    press("[");
    expect(left()).toHaveAttribute("aria-expanded", "false");
  });

  it("turns the keys off again", () => {
    localStorage.setItem(SHORTCUTS_KEY, "true");
    render(<FleetView state={stateFrom()} />);
    expect(sw()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw());
    expect(stored()).toBe(false);
    expect(left()).toHaveAttribute("data-tip", "Collapse the left pane");
    press("[");
    press("w");
    expect(left()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Enter wall mode" })).toHaveAttribute("title", "Collapse everything for a wall display");
  });

  it("keeps working when storage refuses a write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<FleetView state={stateFrom()} />);
    fireEvent.click(sw());
    expect(sw()).toHaveAttribute("aria-checked", "true");
    vi.restoreAllMocks();
  });

  it("is in the Board's, Traffic's and My reporters' rows too", () => {
    for (const props of [{ board: true }, { traffic: true }, { myReporters: true }]) {
      const { unmount } = render(<FleetView {...props} state={stateFrom()} />);
      expect(within(screen.getByRole("region", { name: "Display settings" })).getByRole("switch", { name: "Shortcuts Off" })).toBeInTheDocument();
      unmount();
    }
  });

  it("is in History's row, and reads and writes the same per-browser value", () => {
    vi.stubGlobal("EventSource", class { onerror = null; readyState = 1; addEventListener() {} close() {} });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ day: "2026-10-10", sessions: [], total: 0, page: 1, pageSize: 20 }), { status: 200 })));
    localStorage.setItem(SHORTCUTS_KEY, "true");
    const quiet = { onerror: null, readyState: 1, addEventListener() {}, close() {} };
    render(<HistoryView initialDay="2026-10-10" fleetOptions={{ open: () => quiet, fetchState: async () => makeState() }} />);
    const s =within(screen.getByRole("region", { name: "Display settings" })).getByRole("switch", { name: "Shortcuts On" });
    fireEvent.click(s);
    expect(stored()).toBe(false);
    expect(s).toHaveAttribute("aria-checked", "false");
  });

  it("is not on Admin, which has no shortcuts", async () => {
    vi.stubGlobal("EventSource", class { onerror = null; readyState = 1; addEventListener() {} close() {} });
    fakeServer();
    render(<AdminView />);
    await screen.findByRole("region", { name: "Display settings" });
    expect(screen.queryByRole("switch", { name: /^Shortcuts/ })).toBeNull();
  });
});

describe("useShortcuts", () => {
  it("reads the stored choice, and writes a change", () => {
    const { result } = renderHook(() => useShortcuts());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(stored()).toBe(true);
  });
});
