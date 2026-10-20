import { describe, it, expect } from "vitest";
import { addPin, parsePins, placePinned, prunePins, removePin } from "./pins";

const item = (id: string) => ({ id });
const ids = (l: { id: string }[]) => l.map((x) => x.id);

describe("placePinned (#496)", () => {
  it("returns the list unchanged with no pins", () => {
    expect(ids(placePinned([item("a"), item("b")], []))).toEqual(["a", "b"]);
  });

  it("holds a pinned card in its slot while the others re-order around it", () => {
    const pins = [{ id: "b", slot: 1 }];
    expect(ids(placePinned([item("a"), item("b"), item("c")], pins))).toEqual(["a", "b", "c"]);
    // b moved to the front of the sort and a new card joined: b still comes second.
    expect(ids(placePinned([item("b"), item("c"), item("a"), item("d")], pins))).toEqual(["c", "b", "a", "d"]);
  });

  it("keeps two pins where they were whatever the sort", () => {
    const pins = [{ id: "a", slot: 0 }, { id: "c", slot: 2 }];
    expect(ids(placePinned([item("d"), item("c"), item("b"), item("a")], pins))).toEqual(["a", "d", "c", "b"]);
  });

  it("puts a card pinned past the end last, and returns it to its slot as cards arrive", () => {
    const pins = [{ id: "z", slot: 3 }];
    expect(ids(placePinned([item("a"), item("z")], pins))).toEqual(["a", "z"]);
    expect(ids(placePinned([item("a"), item("b"), item("c"), item("z")], pins))).toEqual(["a", "b", "c", "z"]);
    expect(ids(placePinned([item("z"), item("a"), item("b"), item("c"), item("d")], pins))).toEqual(["a", "b", "c", "z", "d"]);
  });

  it("keeps a pin past the end behind a pin on the last slot", () => {
    const pins = [{ id: "x", slot: 5 }, { id: "y", slot: 2 }];
    expect(ids(placePinned([item("a"), item("x"), item("y")], pins))).toEqual(["a", "x", "y"]);
  });

  it("gives a clashing pin the next free slot", () => {
    const pins = [{ id: "a", slot: 1 }, { id: "b", slot: 1 }];
    expect(ids(placePinned([item("x"), item("a"), item("b"), item("y")], pins))).toEqual(["x", "a", "b", "y"]);
  });

  it("wraps a clash at the last slot to the first free one", () => {
    const pins = [{ id: "a", slot: 1 }, { id: "b", slot: 1 }];
    expect(ids(placePinned([item("a"), item("b")], pins))).toEqual(["b", "a"]);
  });

  it("ignores a pin whose card is not in the list (filtered out) and leaves no gap", () => {
    const pins = [{ id: "gone", slot: 1 }];
    expect(ids(placePinned([item("a"), item("b"), item("c")], pins))).toEqual(["a", "b", "c"]);
  });

  it("handles an empty list", () => {
    expect(placePinned([], [{ id: "a", slot: 0 }])).toEqual([]);
  });
});

describe("pin list helpers", () => {
  it("adds a pin at a slot and replaces an earlier one for the same card", () => {
    expect(addPin([], "a", 2)).toEqual([{ id: "a", slot: 2 }]);
    expect(addPin([{ id: "a", slot: 2 }], "a", 0)).toEqual([{ id: "a", slot: 0 }]);
  });

  it("removes a pin", () => {
    expect(removePin([{ id: "a", slot: 0 }, { id: "b", slot: 1 }], "a")).toEqual([{ id: "b", slot: 1 }]);
  });

  it("prunes pins for sessions that are gone but keeps the same array when nothing changes", () => {
    const pins = [{ id: "a", slot: 0 }, { id: "b", slot: 1 }];
    expect(prunePins(pins, new Set(["a"]))).toEqual([{ id: "a", slot: 0 }]);
    expect(prunePins(pins, new Set(["a", "b"]))).toBe(pins);
  });

  it("reads stored pins defensively", () => {
    expect(parsePins(null)).toEqual([]);
    expect(parsePins("nope")).toEqual([]);
    expect(parsePins([{ id: "a", slot: 1 }, { id: 5, slot: 1 }, { id: "b", slot: -1 }, { id: "c", slot: 1.5 }, { id: "d" }, null, { id: "a", slot: 3 }])).toEqual([{ id: "a", slot: 1 }]);
    expect(parsePins(Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, slot: i }))).length).toBe(200);
  });
});
