import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { makeSession } from "./fixtures";
import { atWall, stateFrom } from "./testState";

const KEY = "podium.planFiles.collapsed";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function openFocus(id = "s1") {
  const st = stateFrom({ sessions: [makeSession({ id }), makeSession({ id: "s2" })] });
  atWall();
  const utils = render(<FleetView state={st} />);
  fireEvent.click(utils.container.querySelector(`.wall .card`)!);
  return utils;
}

const hide = () => screen.getByRole("button", { name: "Hide plan and files" });
const show = () => screen.getByRole("button", { name: "Show plan and files" });

describe("folding the Plan / Files column (#604)", () => {
  it("starts open, with a button that says what it will do and what state it is in", () => {
    const { container } = openFocus();
    expect(hide()).toHaveAttribute("aria-expanded", "true");
    expect(hide()).toHaveAttribute("aria-controls");
    expect(container.querySelector(".two")).not.toHaveClass("folded");
  });

  it("hides the column on a click and brings it back on the next", () => {
    const { container } = openFocus();
    fireEvent.click(hide());
    expect(show()).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".two")).toHaveClass("folded");
    expect(container.querySelector(".fold-col")).toHaveClass("shut");
    fireEvent.click(show());
    expect(hide()).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".two")).not.toHaveClass("folded");
  });

  it("keeps the panel mounted while folded, so the selected tab comes back", () => {
    const { container } = openFocus();
    fireEvent.click(screen.getByRole("tab", { name: /Files/ }));
    expect(container.querySelector(".two")).toHaveClass("wide");
    fireEvent.click(hide());
    // Folded, the column is the rail's width, so the Files widening is not asked for.
    expect(container.querySelector(".two")).not.toHaveClass("wide");
    expect(container.querySelector(".fold-col")).toHaveClass("files");
    fireEvent.click(show());
    expect(screen.getByRole("tab", { name: /Files/ })).toHaveAttribute("aria-selected", "true");
    expect(container.querySelector(".two")).toHaveClass("wide");
  });

  it("remembers the choice in localStorage, for this and every other orchestrator's page", () => {
    openFocus();
    fireEvent.click(hide());
    expect(JSON.parse(localStorage.getItem(KEY)!)).toBe(true);
    cleanup();
    const { container } = openFocus("s2");
    expect(container.querySelector(".two")).toHaveClass("folded");
    expect(show()).toBeInTheDocument();
    fireEvent.click(show());
    expect(JSON.parse(localStorage.getItem(KEY)!)).toBe(false);
  });

  it("opens folded only for a stored true; anything else, or unreadable storage, is open", () => {
    localStorage.setItem(KEY, JSON.stringify("yes"));
    const { container } = openFocus();
    expect(container.querySelector(".two")).not.toHaveClass("folded");
    cleanup();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const again = openFocus();
    expect(again.container.querySelector(".two")).not.toHaveClass("folded");
    vi.restoreAllMocks();
  });

  it("is reachable from the keyboard: a native button takes focus and keeps it after the press", () => {
    openFocus();
    const b = hide();
    b.focus();
    expect(b).toHaveFocus();
    fireEvent.click(b);
    expect(show()).toHaveFocus();
  });

  it("clips only the panel, so the button's tip is not cut off while folded", () => {
    const { container } = openFocus();
    fireEvent.click(hide());
    expect(container.querySelector(".fold-clip")).toContainElement(container.querySelector(".sec"));
    expect(container.querySelector(".fold-clip")).not.toContainElement(show());
  });

  it("names the rail for a screen reader's sake by the button alone, and hides the rail's text", () => {
    const { container } = openFocus();
    fireEvent.click(hide());
    expect(container.querySelector(".fold-rail")).toHaveAttribute("aria-hidden", "true");
  });
});
