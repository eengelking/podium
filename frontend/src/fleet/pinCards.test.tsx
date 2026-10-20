import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { fleetReducer } from "./store";
import { makeSession } from "./fixtures";
import { stateFrom } from "./testState";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const s = (name: string, over: Partial<ReturnType<typeof makeSession>> = {}) => makeSession({ id: name, name, status: "running", ...over });
const names = (c: HTMLElement) => [...c.querySelectorAll(".wall .card .nm")].map((e) => e.textContent?.trim());
const pinBtn = (name: string) => screen.getByRole("button", { name: `Pin ${name} to its place on the wall` });
const unpinBtn = (name: string) => screen.getByRole("button", { name: `Unpin ${name}` });
const three = () => stateFrom({ sessions: [s("alpha", { costUsd: 1 }), s("bravo", { costUsd: 2 }), s("charlie", { costUsd: 3 })] });

describe("pinning wall cards (#496)", () => {
  it("gives every card a pin button, not pressed to start", () => {
    const { container } = render(<FleetView state={three()} />);
    expect(container.querySelectorAll(".wall .card-slot .pin")).toHaveLength(3);
    expect(pinBtn("bravo").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelectorAll(".wall .card .pinslot")).toHaveLength(3);
  });

  it("keeps the second card second while statuses change and a fourth session joins, and unpinning releases it", () => {
    const st = three();
    const { container, rerender } = render(<FleetView state={st} />);
    expect(names(container)).toEqual(["alpha", "bravo", "charlie"]);
    fireEvent.click(pinBtn("bravo"));
    expect(unpinBtn("bravo").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".wall .card-slot.pinned")).not.toBeNull();

    // alpha starts waiting, which sorts it after the running ones: unpinned, bravo would now lead.
    const changed = fleetReducer(st, { type: "session", view: s("alpha", { status: "waiting", costUsd: 1 }) });
    rerender(<FleetView state={changed} />);
    expect(names(container)).toEqual(["charlie", "bravo", "alpha"]);

    const joined = fleetReducer(changed, { type: "session", view: s("delta", { costUsd: 0 }) });
    rerender(<FleetView state={joined} />);
    expect(names(container)).toEqual(["charlie", "bravo", "delta", "alpha"]);

    fireEvent.click(unpinBtn("bravo"));
    expect(names(container)).toEqual(["bravo", "charlie", "delta", "alpha"]);
    expect(container.querySelector(".wall .card-slot.pinned")).toBeNull();
  });

  it("leaves two pinned cards where they were when Sort by changes", () => {
    const { container } = render(<FleetView state={three()} />);
    fireEvent.click(pinBtn("alpha"));
    fireEvent.click(pinBtn("bravo"));
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "cost" } });
    expect(names(container)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("keeps the pins after a reload", () => {
    const first = render(<FleetView state={three()} />);
    fireEvent.click(pinBtn("charlie"));
    first.unmount();
    const { container } = render(<FleetView state={three()} />);
    expect(unpinBtn("charlie").getAttribute("aria-pressed")).toBe("true");
    expect(names(container)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("drops the pin of a session that left, so it is not pinned when it comes back", () => {
    const { rerender } = render(<FleetView state={three()} />);
    fireEvent.click(pinBtn("bravo"));
    rerender(<FleetView state={stateFrom({ sessions: [s("alpha"), s("charlie")] })} />);
    expect(JSON.parse(window.localStorage.getItem("podium.pins") ?? "[]")).toEqual([]);
    rerender(<FleetView state={three()} />);
    expect(pinBtn("bravo").getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the pin of a session the filter hides, with no gap", () => {
    const { container } = render(<FleetView state={three()} />);
    fireEvent.click(pinBtn("alpha"));
    fireEvent.change(screen.getByPlaceholderText("Filter by name, project or branch"), { target: { value: "charlie" } });
    expect(names(container)).toEqual(["charlie"]);
    fireEvent.change(screen.getByPlaceholderText("Filter by name, project or branch"), { target: { value: "" } });
    expect(unpinBtn("alpha").getAttribute("aria-pressed")).toBe("true");
  });

  it("starts with no pins when the stored value is unreadable", () => {
    window.localStorage.setItem("podium.pins", "{not json");
    render(<FleetView state={three()} />);
    expect(pinBtn("alpha").getAttribute("aria-pressed")).toBe("false");
  });

  it("places the pin over the card's gap, and again when the card or the model chip resizes", () => {
    const seen: Element[] = [];
    let fire: () => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: () => void) {
        fire = cb;
      }
      observe(el: Element) {
        seen.push(el);
      }
      disconnect = disconnect;
    });
    const { container, unmount } = render(<FleetView state={three()} />);
    const slot = container.querySelector(".wall .card-slot")!;
    expect(seen).toContain(slot);
    expect(seen.some((el) => el.classList.contains("mdl"))).toBe(true);
    const gap = slot.querySelector<HTMLElement>(".pinslot")!;
    Object.defineProperty(gap, "offsetLeft", { value: 40 });
    Object.defineProperty(gap, "offsetTop", { value: 12 });
    fire();
    const pin = slot.querySelector<HTMLElement>(".pin")!;
    expect(pin.style.left).not.toBe("");
    unmount();
    expect(disconnect).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("places the pin on a window resize where ResizeObserver is missing", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { container } = render(<FleetView state={three()} />);
    const pin = container.querySelector<HTMLElement>(".wall .card-slot .pin")!;
    pin.style.left = "";
    window.dispatchEvent(new Event("resize"));
    expect(pin.style.left).not.toBe("");
    vi.unstubAllGlobals();
  });
});
