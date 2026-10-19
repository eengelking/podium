import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useMyPeers } from "./useMyPeers";
import type { PeersApi } from "./respondApi";
import { withRight, type PeersRead } from "./peers";

const READ = { enabled: true, owner: "Ed", reporters: [], rights: [], defaults: { trust: false, onRequest: "ask", newSend: "ask", limits: {} }, requests: [] } as unknown as PeersRead;

afterEach(cleanup);

describe("useMyPeers", () => {
  it("drops a read that lands after the sign-in it was made for has gone", async () => {
    let land: (d: PeersRead) => void = () => {};
    const api = { read: vi.fn(() => new Promise<PeersRead>((res) => (land = res))) } as unknown as PeersApi;
    const { result, rerender } = renderHook(({ on }) => useMyPeers(api, on, false), { initialProps: { on: true } });
    rerender({ on: false });
    await act(async () => land(READ));
    expect(result.current.data).toBeNull();
  });

  const levels = (d: PeersRead | null) => d!.rights.map((r) => `${r.from}>${r.to}:${r.level}`).sort();

  /** A save that waits until the test settles it. */
  function held() {
    let settle: (err?: unknown) => void = () => {};
    const run = () => new Promise<void>((res, rej) => (settle = (err) => (err ? rej(err) : res())));
    return { run, settle: (err?: unknown) => settle(err) };
  }

  it("undoes only the change that failed, and keeps a newer one that is still saving (#415)", async () => {
    const read = vi.fn(async () => READ);
    const api = { read } as unknown as PeersApi;
    const { result } = renderHook(() => useMyPeers(api, true, false));
    await act(async () => {});
    const a = held();
    const b = held();
    let doneA: Promise<string | null> = Promise.resolve(null);
    let doneB: Promise<string | null> = Promise.resolve(null);
    act(() => void (doneA = result.current.change(a.run, (d) => withRight(d, "k1", "k2", "see"))));
    act(() => void (doneB = result.current.change(b.run, (d) => withRight(d, "k2", "k1", "send"))));
    expect(levels(result.current.data)).toEqual(["k1>k2:see", "k2>k1:send"]);
    // A fails while B still saves: A goes, B stays, and the read after A (which does not have B yet) keeps it too.
    await act(async () => {
      a.settle(new TypeError("Failed to fetch"));
      expect(await doneA).toBe("the server did not answer");
    });
    expect(levels(result.current.data)).toEqual(["k2>k1:send"]);
    // B saves, and the read after it has it.
    read.mockResolvedValue(withRight(READ, "k2", "k1", "send"));
    await act(async () => {
      b.settle();
      expect(await doneB).toBeNull();
    });
    expect(levels(result.current.data)).toEqual(["k2>k1:send"]);
  });

  it("keeps an older change that saved when a newer one to the same pair fails", async () => {
    const read = vi.fn(() => new Promise<PeersRead>(() => {}));
    read.mockResolvedValueOnce(READ);
    const api = { read } as unknown as PeersApi;
    const { result } = renderHook(() => useMyPeers(api, true, false));
    await act(async () => {});
    const a = held();
    const b = held();
    act(() => void result.current.change(a.run, (d) => withRight(d, "k1", "k2", "see")));
    act(() => void result.current.change(b.run, (d) => withRight(d, "k1", "k2", "send")));
    expect(levels(result.current.data)).toEqual(["k1>k2:send"]);
    // A saves, then B fails, and no read answers: the pair shows A's level, not the one from before both.
    await act(async () => a.settle());
    await act(async () => b.settle(new TypeError("Failed to fetch")));
    expect(levels(result.current.data)).toEqual(["k1>k2:see"]);
  });
});
