// #1311: the reads that follow one chat signal land together, so the page is drawn once for them and never with the new overview beside the old thread.
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Landing, LANDING_WAIT_MS } from "./landing";
import { useChatOverview, useLanding, useThread, type Selection } from "./useChat";
import type { ChatApi, ChatOverview, ChannelMessage } from "./chatData";

const GENERAL: Selection = { kind: "channel", id: "general" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Landing", () => {
  afterEach(() => vi.useRealTimers());

  it("runs what the reads hand over together, when the last read that started has ended", async () => {
    const lane = new Landing();
    const ran: string[] = [];
    lane.start();
    lane.start();
    const a = lane.end(() => ran.push("a"));
    await Promise.resolve();
    expect(ran).toEqual([]);
    const b = lane.end(() => ran.push("b"));
    await Promise.all([a, b]);
    expect(ran).toEqual(["a", "b"]);
  });

  it("runs a read that is alone at once", async () => {
    const lane = new Landing();
    const ran: string[] = [];
    lane.start();
    await lane.end(() => ran.push("a"));
    expect(ran).toEqual(["a"]);
  });

  it("lets a read land on its own when the other has not come back after a while", async () => {
    vi.useFakeTimers();
    const lane = new Landing();
    const ran: string[] = [];
    lane.start();
    lane.start();
    const a = lane.end(() => ran.push("a"));
    await vi.advanceTimersByTimeAsync(LANDING_WAIT_MS - 1);
    expect(ran).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    await a;
    expect(ran).toEqual(["a"]);
    // The one that hung comes back later and lands by itself.
    await lane.end(() => ran.push("late"));
    expect(ran).toEqual(["a", "late"]);
  });
});

describe("the overview and the open thread after one signal", () => {
  const overview = (n: number) => ({ enabled: true, serverTime: 1000 + n, me: { id: 1, name: "Ed", admin: false, person: true }, channels: [], directs: [], agents: [], people: [], version: n }) as unknown as ChatOverview;
  const msg = (id: string): ChannelMessage => ({ id, authorKind: "person", authorName: "Ed", authorRef: "Ed", text: id, createdAt: 1, updatedAt: 1, replyTo: null, issue: null, project: null, milestone: null, mine: true, mentions: [] });

  function setup(delays: { overview: number; thread: number }) {
    let n = 0;
    const api = {
      overview: vi.fn(async () => {
        await sleep(delays.overview);
        return overview(n);
      }),
      channelMessages: vi.fn(async () => {
        await sleep(delays.thread);
        return { ok: true as const, channel: "general" as const, messages: Array.from({ length: n + 1 }, (_, i) => msg(`m${i}`)), older: null, total: n + 1 };
      }),
    } as unknown as ChatApi;
    const seen: { overview: number; thread: number }[] = [];
    const host = renderHook(
      ({ rev }) => {
        const landing = useLanding();
        const o = useChatOverview(api, true, rev, null, landing);
        const t = useThread(api, GENERAL, rev, null, landing);
        seen.push({ overview: (o.data as unknown as { version: number } | null)?.version ?? -1, thread: t.messages.length });
        return { o, t };
      },
      { initialProps: { rev: 0 } },
    );
    return { host, seen, advance: () => void n++ };
  }

  it("draws the new overview and the new thread in one render, whichever answers first", async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      for (const delays of [{ overview: 5, thread: 40 }, { overview: 40, thread: 5 }]) {
        const { host, seen, advance } = setup(delays);
        await act(async () => {
          await sleep(120);
        });
        expect(host.result.current.o.data).not.toBeNull();
        expect(host.result.current.t.loaded).toBe(true);
        const before = seen.length;
        advance();
        host.rerender({ rev: 1 });
        await sleep(160);
        const after = seen.slice(before);
        // One render for the new signal itself, and one for both answers; no render has the new overview with the old thread, or the reverse.
        expect(after.length).toBe(2);
        expect(after[after.length - 1]).toEqual({ overview: 1, thread: 2 });
        expect(after.every((s) => (s.overview === 1) === (s.thread === 2))).toBe(true);
        host.unmount();
      }
    } finally {
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    }
  });

  it("still draws the overview when the thread fails, and says why the thread failed", async () => {
    const api = {
      overview: vi.fn(async () => overview(0)),
      channelMessages: vi.fn(async () => {
        throw new Error("no");
      }),
    } as unknown as ChatApi;
    const host = renderHook(() => {
      const landing = useLanding();
      return { o: useChatOverview(api, true, 0, null, landing), t: useThread(api, GENERAL, 0, null, landing) };
    });
    await act(async () => {
      await sleep(20);
    });
    expect(host.result.current.o.data).not.toBeNull();
    expect(host.result.current.t.error).not.toBeNull();
    expect(host.result.current.t.loaded).toBe(true);
  });

  it("resolves a reload once its answer is in state", async () => {
    const api = { overview: vi.fn(async () => overview(0)) } as unknown as ChatApi;
    const host = renderHook(() => useChatOverview(api, true, 0));
    await act(async () => {
      await host.result.current.reload();
    });
    expect(host.result.current.data).not.toBeNull();
  });

  it("keeps the earlier pages the state shows when a read that found the thread cleared is replaced before it lands", async () => {
    const m = (id: string): ChannelMessage => ({ id, authorKind: "person", authorName: "Ed", authorRef: "Ed", text: id, createdAt: 1, updatedAt: 1, replyTo: null, issue: null, project: null, milestone: null, mine: true, mentions: [] });
    let newest: ChannelMessage[] = [m("m3"), m("m4")];
    let total = 4;
    const api = {
      channelMessages: vi.fn(async (_id: string, o: { before: string | null }) =>
        o.before ? { ok: true as const, channel: "general" as const, messages: [m("m1"), m("m2")], older: null, total } : { ok: true as const, channel: "general" as const, messages: newest, older: "c", total },
      ),
    } as unknown as ChatApi;
    const landing = new Landing();
    const host = renderHook(({ rev }) => useThread(api, GENERAL, rev, null, landing), { initialProps: { rev: 0 } });
    await act(async () => {
      await sleep(20);
    });
    await act(async () => void (await host.result.current.loadEarlier()));
    expect(host.result.current.messages.map((x) => x.id)).toEqual(["m1", "m2", "m3", "m4"]);
    // Another read is out, so the thread's reads wait in the landing; the first of them found the thread cleared, a second signal replaces it.
    landing.start();
    newest = [m("m5")];
    total = 1;
    host.rerender({ rev: 1 });
    await act(async () => {
      await sleep(20);
    });
    newest = [m("m5"), m("m6")];
    total = 2;
    host.rerender({ rev: 2 });
    await act(async () => {
      await sleep(20);
    });
    await act(async () => {
      await landing.end(() => undefined);
    });
    expect(host.result.current.messages.map((x) => x.id)).toEqual(["m5", "m6"]);
  });
});
