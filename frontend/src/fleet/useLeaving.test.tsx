// #1311: a list that is read again with the same rows is drawn once for the read, and a row that leaves still stays for the leave animation.
import { Profiler } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLeaving } from "./useLeaving";
import { LEAVE_MS } from "./store";

const a = (id: string, v = 0) => ({ id, v });

describe("useLeaving", () => {
  afterEach(() => vi.useRealTimers());

  it("draws once for a read that returns the same rows, and shows what the read returned", () => {
    let commits = 0;
    const host = renderHook(({ items }) => useLeaving(items, (x) => x.id), {
      initialProps: { items: [a("x"), a("y")] },
      wrapper: ({ children }) => (
        <Profiler id="host" onRender={() => void commits++}>
          {children}
        </Profiler>
      ),
    });
    const before = commits;
    host.rerender({ items: [a("x", 1), a("y", 2)] });
    // One commit for the read: the rows were not put in state by an effect after it.
    expect(commits - before).toBe(1);
    expect(host.result.current.map((r) => [r.item.id, r.item.v, r.leaving])).toEqual([["x", 1, false], ["y", 2, false]]);
  });

  it("keeps a row that left, marked leaving, for the leave time, and takes it out after", () => {
    vi.useFakeTimers();
    const host = renderHook(({ items }) => useLeaving(items, (x) => x.id), { initialProps: { items: [a("x"), a("y")] } });
    host.rerender({ items: [a("y")] });
    expect(host.result.current.map((r) => [r.item.id, r.leaving])).toEqual([["x", true], ["y", false]]);
    act(() => void vi.advanceTimersByTime(LEAVE_MS + 1));
    expect(host.result.current.map((r) => r.item.id)).toEqual(["y"]);
  });

  it("makes a row that came back before its animation ended a live row, which the old timer does not remove", () => {
    vi.useFakeTimers();
    const host = renderHook(({ items }) => useLeaving(items, (x) => x.id), { initialProps: { items: [a("x"), a("y")] } });
    host.rerender({ items: [a("y")] });
    host.rerender({ items: [a("x"), a("y")] });
    act(() => void vi.advanceTimersByTime(LEAVE_MS + 1));
    expect(host.result.current.map((r) => [r.item.id, r.leaving])).toEqual([["x", false], ["y", false]]);
  });
});
