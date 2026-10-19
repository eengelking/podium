import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useMyPeers } from "./useMyPeers";
import type { PeersApi } from "./respondApi";
import type { PeersRead } from "./peers";

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
});
