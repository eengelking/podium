// Wall options (#1129, mockup/podium-wall-options.html): the banner's display controls folded into one drawer that every page renders.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { FleetApp, FleetView } from "../FleetApp";
import { HistoryView } from "../HistoryView";
import { AdminView } from "../admin/AdminView";
import { fakeServer } from "../admin/fakeAdmin";
import { makeState } from "../fixtures";
import { stateFrom } from "../testState";
import { UPDATE_KEY } from "../updateInterval";
import { SHORTCUTS_KEY } from "../useShortcuts";
import { useTheme } from "../useTheme";
import { WallOptions } from "./WallOptions";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "#/");
});

/** WallOptions on its own, with the stored settings the pages use; `every` set means a page that owns the interval. */
function Harness(props: { every?: number; onEvery?: (n: number) => void }) {
  const theme = useTheme();
  const [shortcuts, setShortcuts] = useState(false);
  return (
    <div className="podium">
      <div className="banner has-picker">
        <span>Note</span>
        <WallOptions theme={theme} shortcuts={shortcuts} onShortcuts={setShortcuts} every={props.every} onEvery={props.onEvery} />
      </div>
      <button type="button">Elsewhere</button>
    </div>
  );
}

const pill = () => screen.getByRole("button", { name: /wall options/i });
const body = () => document.getElementById(pill().getAttribute("aria-controls")!)!;
const isOpen = () => pill().getAttribute("aria-expanded") === "true";

describe("Wall options", () => {
  it("starts shut: one pill named and tipped Wall options, and the controls hidden", () => {
    render(<Harness />);
    expect(pill()).toHaveAccessibleName("Wall options");
    expect(pill()).toHaveAttribute("data-tip", "Wall options");
    expect(pill()).toHaveAttribute("aria-expanded", "false");
    expect(pill()).toHaveClass("edge-tab", "edge-tab-opts", "edge-tab-shut");
    expect(pill().querySelectorAll("circle")).toHaveLength(2);
    expect(body()).not.toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Theme" })).toBeNull();
  });

  it("opens with the four controls in order, and the pill becomes the collapse button at its left end", () => {
    const { container } = render(<Harness />);
    fireEvent.click(pill());
    expect(isOpen()).toBe(true);
    expect(pill()).toHaveAccessibleName("Hide wall options");
    expect(pill()).toHaveAttribute("data-tip", "Hide wall options");
    expect(pill().querySelector("circle")).toBeNull();
    expect(container.querySelector(".wallopts")).toHaveClass("open");
    expect(container.querySelector(".wallopts")!.firstElementChild).toBe(pill());
    const names = [...body().children].map((c) => c.textContent ?? "");
    expect(names[0]).toMatch(/^Refresh every/);
    expect(names[1]).toMatch(/^Shortcuts/);
    expect(names[2]).toMatch(/^Theme/);
    expect(within(body()).getByRole("radiogroup", { name: "Mode" })).toBeVisible();
  });

  it("closes with the collapse button", () => {
    render(<Harness />);
    fireEvent.click(pill());
    fireEvent.click(pill());
    expect(isOpen()).toBe(false);
    expect(body()).not.toBeVisible();
  });

  it("closes on a press outside it, and stays open on a press inside, a theme change included", () => {
    render(<Harness />);
    fireEvent.click(pill());
    const theme = screen.getByRole("combobox", { name: "Theme" });
    fireEvent.mouseDown(theme);
    fireEvent.change(theme, { target: { value: "nord" } });
    fireEvent.mouseDown(screen.getByRole("radio", { name: "Light" }));
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(isOpen()).toBe(true);
    expect(document.documentElement.dataset).toMatchObject({ themeName: "nord", theme: "light" });
    fireEvent.mouseDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(isOpen()).toBe(false);
  });

  it("closes on Escape and puts focus back on the pill", () => {
    render(<Harness />);
    fireEvent.click(pill());
    screen.getByRole("combobox", { name: "Refresh every" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(isOpen()).toBe(false);
    expect(pill()).toHaveFocus();
  });

  it("leaves focus where it is on Escape when the person has moved on to another control", () => {
    render(<Harness />);
    fireEvent.click(pill());
    screen.getByRole("button", { name: "Elsewhere" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(isOpen()).toBe(false);
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  });

  it("does nothing on other keys or on Escape while shut", () => {
    render(<Harness />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(isOpen()).toBe(false);
    fireEvent.click(pill());
    fireEvent.keyDown(document, { key: "w" });
    expect(isOpen()).toBe(true);
  });

  it("points aria-controls at the controls", () => {
    render(<Harness />);
    expect(body()).toHaveClass("wallopts-body");
  });

  it("keeps the drawer open while the Keyboard shortcuts list is open from it, and Escape closes the list first", () => {
    localStorage.setItem(SHORTCUTS_KEY, "true");
    render(<FleetView state={stateFrom()} />);
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole("button", { name: "Shortcuts" }));
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    fireEvent.mouseDown(dialog);
    expect(isOpen()).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(isOpen()).toBe(true);
  });

  it("saves Refresh every to podium.updateEvery itself on a page that does not own the interval", () => {
    render(<Harness />);
    fireEvent.click(pill());
    const every = screen.getByRole("combobox", { name: "Refresh every" }) as HTMLSelectElement;
    expect(every.value).toBe("2");
    fireEvent.change(every, { target: { value: "30" } });
    expect(JSON.parse(localStorage.getItem(UPDATE_KEY)!)).toBe(30);
    expect(every.value).toBe("30");
  });

  it("hands Refresh every to a page that owns the interval and writes nothing itself", () => {
    const onEvery = vi.fn();
    render(<Harness every={10} onEvery={onEvery} />);
    fireEvent.click(pill());
    const every = screen.getByRole("combobox", { name: "Refresh every" }) as HTMLSelectElement;
    expect(every.value).toBe("10");
    fireEvent.change(every, { target: { value: "60" } });
    expect(onEvery).toHaveBeenCalledWith(60);
    expect(localStorage.getItem(UPDATE_KEY)).toBeNull();
  });

  it("writes nothing when a page passes the interval with no handler", () => {
    render(<Harness every={5} />);
    fireEvent.click(pill());
    fireEvent.change(screen.getByRole("combobox", { name: "Refresh every" }), { target: { value: "60" } });
    expect(localStorage.getItem(UPDATE_KEY)).toBeNull();
  });
});

describe("Wall options on every page", () => {
  const quiet = { onerror: null, readyState: 1, addEventListener() {}, close() {} };
  const stubStream = () => vi.stubGlobal("EventSource", class { onerror = null; readyState = 1; addEventListener() {} close() {} });

  /** The control names in the drawer, in order, after opening it from the page's own banner. */
  function drawer(region: HTMLElement) {
    fireEvent.click(within(region).getByRole("button", { name: "Wall options" }));
    const controls = document.getElementById(within(region).getByRole("button", { name: "Hide wall options" }).getAttribute("aria-controls")!)!;
    return [...controls.children].map((c) => ORDER.find((name) => (c.textContent ?? "").startsWith(name)));
  }
  const ORDER = ["Refresh", "Shortcuts", "Theme"];

  it("is the same drawer, with all four controls, on Live fleet, the Board, My reporters, Traffic and Chat", () => {
    for (const props of [{}, { board: true }, { myReporters: true }, { traffic: true }, { chat: true }]) {
      const { unmount } = render(<FleetView {...props} state={stateFrom()} />);
      const region = screen.getByRole("region", { name: "Display settings" });
      expect(region.querySelectorAll(".wallopts")).toHaveLength(1);
      expect(drawer(region)).toEqual(ORDER);
      expect(within(region).getByRole("radiogroup", { name: "Mode" })).toBeVisible();
      unmount();
    }
  });

  it("is on History, sharing podium.updateEvery and podium.shortcuts", () => {
    stubStream();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ day: "2026-10-10", sessions: [], total: 0, page: 1, pageSize: 20 }), { status: 200 })));
    localStorage.setItem(UPDATE_KEY, "20");
    render(<HistoryView initialDay="2026-10-10" fleetOptions={{ open: () => quiet, fetchState: async () => makeState() }} />);
    const region = screen.getByRole("region", { name: "Display settings" });
    expect(drawer(region)).toEqual(ORDER);
    expect((within(region).getByRole("combobox", { name: "Refresh every" }) as HTMLSelectElement).value).toBe("20");
    fireEvent.change(within(region).getByRole("combobox", { name: "Refresh every" }), { target: { value: "5" } });
    expect(localStorage.getItem(UPDATE_KEY)).toBe("5");
  });

  it("is on Admin with Shortcuts too, and a Refresh every set there is what Live fleet starts with", async () => {
    stubStream();
    fakeServer();
    const admin = render(<AdminView />);
    const region = await screen.findByRole("region", { name: "Display settings" });
    expect(drawer(region)).toEqual(ORDER);
    fireEvent.change(within(region).getByRole("combobox", { name: "Refresh every" }), { target: { value: "10" } });
    fireEvent.click(within(region).getByRole("switch", { name: "Shortcuts Off" }));
    expect(localStorage.getItem(UPDATE_KEY)).toBe("10");
    expect(localStorage.getItem(SHORTCUTS_KEY)).toBe("true");
    admin.unmount();
    render(<FleetApp fleetOptions={{ open: () => quiet, fetchState: async () => makeState() }} />);
    const fleet = screen.getByRole("region", { name: "Display settings" });
    drawer(fleet);
    expect((within(fleet).getByRole("combobox", { name: "Refresh every" }) as HTMLSelectElement).value).toBe("10");
    expect(within(fleet).getByRole("switch", { name: "Shortcuts On" })).toBeInTheDocument();
  });
});
