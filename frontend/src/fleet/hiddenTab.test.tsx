// A hidden tab does no redraw work (#751): the clock and the held state stop their intervals while the tab is hidden,
// and show the newest value as soon as it is shown again.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHeldState } from "./useHeldState";
import { useNow } from "./useNow";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

describe("useNow while the tab is hidden", () => {
  it("ticks while visible, stops while hidden and shows the current time on return", () => {
    const { result } = renderHook(() => useNow(1000));
    const start = result.current;
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current).toBe(start + 1000);

    setVisibility("hidden");
    const frozen = result.current;
    act(() => void vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(frozen);

    setVisibility("visible");
    expect(result.current).toBe(frozen + 10_000);
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current).toBe(frozen + 11_000);
  });
});

describe("a tab that is hidden when the console mounts", () => {
  it("starts no interval until the tab is shown", () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const now = renderHook(() => useNow(1000));
    const held = renderHook(({ v }) => useHeldState(v, 2000, () => true), { initialProps: { v: 1 } });
    const start = now.result.current;
    held.rerender({ v: 2 });
    act(() => void vi.advanceTimersByTime(30_000));
    expect(now.result.current).toBe(start);
    expect(held.result.current).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    setVisibility("visible");
    expect(now.result.current).toBe(start + 30_000);
    expect(held.result.current).toBe(2);
  });
});

describe("useHeldState while the tab is hidden", () => {
  const urgent = (_held: number, next: number) => next < 0;

  it("holds the shown value, even for an urgent change, and shows the newest on return", () => {
    const { result, rerender } = renderHook(({ v }) => useHeldState(v, 2000, urgent), { initialProps: { v: 1 } });
    rerender({ v: 2 });
    expect(result.current).toBe(1);
    act(() => void vi.advanceTimersByTime(2000));
    expect(result.current).toBe(2);

    setVisibility("hidden");
    rerender({ v: 3 });
    act(() => void vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(2);
    rerender({ v: -1 });
    expect(result.current).toBe(2);

    setVisibility("visible");
    expect(result.current).toBe(-1);
  });
});
