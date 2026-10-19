// ReadGate: a fresh read makes earlier ones stale; an interval read waits for the one out and makes nothing stale.
import { describe, expect, it } from "vitest";
import { ReadGate } from "./readGate";

describe("ReadGate", () => {
  it("skips an interval read while one is out, and lands the slow one", () => {
    const g = new ReadGate();
    const first = g.fresh();
    expect(g.poll()).toBeNull();
    expect(g.poll()).toBeNull();
    expect(g.land(first)).toBe(true);
    const next = g.poll();
    expect(next).not.toBeNull();
    expect(g.land(next!)).toBe(true);
  });

  it("lets a fresh read make an interval read out before it stale, whichever answers first", () => {
    const g = new ReadGate();
    g.land(g.fresh());
    const tick = g.poll()!;
    const after = g.fresh();
    expect(g.poll()).toBeNull();
    expect(g.land(tick)).toBe(false);
    expect(g.poll()).toBeNull();
    expect(g.land(after)).toBe(true);
    const tick2 = g.poll()!;
    const after2 = g.fresh();
    expect(g.land(after2)).toBe(true);
    expect(g.land(tick2)).toBe(false);
  });

  it("makes every read out stale on drop, and reads again after it", () => {
    const g = new ReadGate();
    const at = g.fresh();
    g.drop();
    const tick = g.poll();
    expect(tick).not.toBeNull();
    expect(g.land(at)).toBe(false);
    expect(g.land(tick!)).toBe(true);
  });
});
