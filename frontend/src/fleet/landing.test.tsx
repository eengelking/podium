// #1311: the reads that follow one chat signal land together, so the page is drawn once for them and never with the new overview beside the old thread.
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Landing, LANDING_WAIT_MS } from "./landing";
import { useChatOverview, useLanding, useThread, type Selection } from "./useChat";
import type { ChatApi, ChatOverview, ChannelMessage } from "./chatData";

const GENERAL: Selection = { kind: "channel", id: "general" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nothing = () => () => undefined;

/** A read that answers when told to, with what it would do when it lands. */
function held() {
  let answer!: (apply?: () => void) => void;
  const read = new Promise<(() => void) | null>((done) => (answer = (apply) => done(apply ?? null)));
  return { read: () => read, answer };
}

describe("Landing", () => {
  afterEach(() => vi.useRealTimers());

  it("runs what the reads hand over together, when the last read that started has answered", async () => {
    const lane = new Landing();
    const ran: string[] = [];
    const a = held();
    const b = held();
    const both = Promise.all([lane.run(a.read, nothing), lane.run(b.read, nothing)]);
    a.answer(() => void ran.push("a"));
    await Promise.resolve();
    expect(ran).toEqual([]);
    b.answer(() => void ran.push("b"));
    await both;
    expect(ran).toEqual(["a", "b"]);
  });

  it("runs a read that is alone at once, and what a failed read says to do", async () => {
    const lane = new Landing();
    const ran: string[] = [];
    await lane.run(async () => () => void ran.push("a"), nothing);
    await lane.run(() => Promise.reject(new Error("no")), (err) => () => void ran.push((err as Error).message));
    expect(ran).toEqual(["a", "no"]);
  });

  // #1296: an answer that throws when it lands is that read's failure and nobody else's.
  it("lands the other answers when one throws, rejects the read it belongs to, and reads again afterwards", async () => {
    const lane = new Landing();
    const ran: string[] = [];
    const a = held();
    const b = held();
    const c = held();
    const first = lane.run(a.read, nothing);
    const second = lane.run(b.read, nothing);
    const third = lane.run(c.read, nothing);
    const caught = first.catch((err: Error) => err.message);
    a.answer(() => {
      throw new Error("boom");
    });
    b.answer(() => void ran.push("b"));
    c.answer(() => void ran.push("c"));
    await Promise.all([second, third]);
    expect(await caught).toBe("boom");
    expect(ran).toEqual(["b", "c"]);
    await lane.run(async () => () => void ran.push("next"), nothing);
    expect(ran).toEqual(["b", "c", "next"]);
  });

  it("stops its wait and lands the rest when the answer that threw was held for a request that never answers", async () => {
    vi.useFakeTimers();
    const lane = new Landing();
    const ran: string[] = [];
    const hung = held();
    void lane.run(hung.read, nothing);
    const first = lane.run(async () => () => {
      throw new Error("boom");
    }, nothing);
    const second = lane.run(async () => () => void ran.push("second"), nothing);
    const caught = first.catch((err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(LANDING_WAIT_MS + 1);
    await second;
    expect(await caught).toBe("boom");
    expect(ran).toEqual(["second"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets answers land on their own when a request never answers, and loses nothing", async () => {
    vi.useFakeTimers();
    const lane = new Landing();
    const ran: string[] = [];
    const hung = held();
    const hungRun = lane.run(hung.read, nothing);
    const first = lane.run(async () => () => void ran.push("first"), nothing);
    await vi.advanceTimersByTimeAsync(LANDING_WAIT_MS - 1);
    expect(ran).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    await first;
    expect(ran).toEqual(["first"]);
    // The next answer waits the same while the request is still out, and lands too.
    const next = lane.run(async () => () => void ran.push("next"), nothing);
    await vi.advanceTimersByTimeAsync(LANDING_WAIT_MS + 1);
    await next;
    expect(ran).toEqual(["first", "next"]);
    // The request that hung answers at last, and lands by itself.
    hung.answer(() => void ran.push("late"));
    await hungRun;
    expect(ran).toEqual(["first", "next", "late"]);
  });
});

const message = (id: string, text = id): ChannelMessage => ({ id, authorKind: "person", authorName: "Ed", authorRef: "Ed", text, createdAt: 1, updatedAt: 1, replyTo: null, issue: null, project: null, milestone: null, mine: true, mentions: [] });
const overview = (n: number) => ({ enabled: true, serverTime: 1000 + n, me: { id: 1, name: "Ed", admin: false, person: true }, channels: [], directs: [], agents: [], people: [], version: n }) as unknown as ChatOverview;

describe("the overview and the open thread after one signal", () => {
  function setup(delays: { overview: number; thread: number }) {
    let n = 0;
    const api = {
      overview: vi.fn(async () => {
        await sleep(delays.overview);
        return overview(n);
      }),
      channelMessages: vi.fn(async () => {
        await sleep(delays.thread);
        return { ok: true as const, channel: "general" as const, messages: Array.from({ length: n + 1 }, (_, i) => message(`m${i}`)), older: null, total: n + 1 };
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
    const host = renderHook(() => useChatOverview(api, true, 0, null, useLanding()));
    await act(async () => {
      await host.result.current.reload();
    });
    expect(host.result.current.data).not.toBeNull();
  });
});

describe("a thread read that waits in the landing", () => {
  /** A thread of General whose newest page is `newest` and whose earlier page is m1 and m2, and a read that holds the landing until `release`. */
  function held_thread(first: ChannelMessage[], total: number) {
    const state = { newest: first, total };
    const api = {
      channelMessages: vi.fn(async (_id: string, o: { before: string | null }) =>
        o.before ? { ok: true as const, channel: "general" as const, messages: [message("m1"), message("m2")], older: null, total: state.total } : { ok: true as const, channel: "general" as const, messages: state.newest, older: "c", total: state.total },
      ),
    } as unknown as ChatApi;
    const landing = new Landing();
    const hold = held();
    const host = renderHook(({ rev }) => useThread(api, GENERAL, rev, null, landing), { initialProps: { rev: 0 } });
    const settle = () => act(async () => void (await sleep(20)));
    return { state, host, landing, settle, hold, release: () => act(async () => void (hold.answer(), await sleep(20))) };
  }

  it("keeps the earlier pages the state shows when a read that found the thread cleared is replaced before it lands", async () => {
    const t = held_thread([message("m3"), message("m4")], 4);
    await t.settle();
    await act(async () => void (await t.host.result.current.loadEarlier()));
    expect(t.host.result.current.messages.map((x) => x.id)).toEqual(["m1", "m2", "m3", "m4"]);
    // Another read is out, so the thread's reads wait; the first of them found the thread cleared, a second signal replaces it.
    void t.landing.run(t.hold.read, nothing);
    t.state.newest = [message("m5")];
    t.state.total = 1;
    t.host.rerender({ rev: 1 });
    await t.settle();
    t.state.newest = [message("m5"), message("m6")];
    t.state.total = 2;
    t.host.rerender({ rev: 2 });
    await t.settle();
    await t.release();
    expect(t.host.result.current.messages.map((x) => x.id)).toEqual(["m5", "m6"]);
  });

  it("ends on the edited text when a message is edited while a read that has the old text is out", async () => {
    let text = "old text";
    let out = false;
    const answers: (() => void)[] = [];
    const api = {
      channelMessages: vi.fn(async () => {
        const page = { ok: true as const, channel: "general" as const, messages: [message("m3", text)], older: null, total: 1 };
        // After the first read, each read answers when the test says so, with the text it was asked for under.
        return out ? new Promise<typeof page>((done) => answers.push(() => done(page))) : page;
      }),
    } as unknown as ChatApi;
    const landing = new Landing();
    const host = renderHook(({ rev }) => useThread(api, GENERAL, rev, null, landing), { initialProps: { rev: 0 } });
    const settle = () => act(async () => void (await sleep(20)));
    await settle();
    out = true;
    host.rerender({ rev: 1 });
    await settle();
    // The edit shows at once, and its own signal starts a newer read, which the older one must not overwrite when it answers last.
    act(() => host.result.current.patch(message("m3", "edited text")));
    expect(host.result.current.messages[0]!.channel!.text).toBe("edited text");
    text = "edited text";
    host.rerender({ rev: 2 });
    await settle();
    expect(answers).toHaveLength(2);
    answers[1]!();
    await settle();
    answers[0]!();
    await settle();
    expect(host.result.current.messages.map((x) => x.channel!.text)).toEqual(["edited text"]);
  });
});
