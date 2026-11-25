// #1296: Earlier messages and a read for a signal land one after the other, and each waits for the other for the Landing's bound at most (LANDING_WAIT_MS), so a
// request that is slow or never answers cannot hold the page for good: not another thread, not the live update of this one, not Earlier messages itself.
// A random interleaving of the requests keeps every message once and in order. Against a fake server whose answers the test holds back.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Landing, LANDING_WAIT_MS } from "./landing";
import { useConversation } from "./useChat";
import type { ChatApi, ConversationInfo, ConversationMessage } from "./chatData";

const T0 = new Date(2026, 9, 12, 14, 30).getTime();
const info = (id: string) => ({ id, thread: `convo:${id}`, members: [], hasAgent: false, unread: 0, mentions: 0, messages: 6, lastAt: T0, adminReading: [] }) as unknown as ConversationInfo;
const row = (id: string): ConversationMessage => ({ id, author: { kind: "person", name: "Maya", you: false }, text: id, createdAt: T0 + Number(id.slice(1)) * 1000, editedAt: null, deletedAt: null, replyTo: null, canChange: false, changeWhy: null, deliveries: [] });

/** Six messages, m1 the oldest, two to a page, the same for every conversation. `hang` says which requests never answer, `delay` how long the others take. */
function serve() {
  const all = ["m1", "m2", "m3", "m4", "m5", "m6"].map(row);
  const control = { hang: (_id: string, _before: string | null) => false, delay: 0 };
  const conversationMessages = vi.fn(async (id: string, o: { before?: string | null } = {}) => {
    const end = o.before ? all.findIndex((m) => m.id === o.before) : all.length;
    const start = Math.max(0, end - 2);
    const out = { ok: true as const, conversation: info(id), messages: structuredClone(all.slice(start, end)), older: start > 0 ? all[start]!.id : null, total: all.length, adminReads: [] };
    if (control.hang(id, o.before ?? null)) return new Promise<never>(() => undefined);
    if (control.delay) await new Promise((r) => setTimeout(r, control.delay));
    return out;
  });
  return { all, control, conversationMessages, api: { conversationMessages } as unknown as ChatApi };
}

const run = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const ids = (h: { result: { current: { messages: { id: string }[] } } }) => h.result.current.messages.map((m) => m.id);

async function opened(s: ReturnType<typeof serve>, id = "A") {
  const landing = new Landing();
  const hook = renderHook(({ id: now, rev }) => useConversation(s.api, now, rev, landing), { initialProps: { id, rev: 0 } });
  await run(0);
  expect(hook.result.current.loaded).toBe(true);
  return hook;
}

describe("the waits of Earlier messages and of a read for a signal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("do not stop another conversation from loading when an earlier page of this one never answers", async () => {
    const s = serve();
    const hook = await opened(s);
    s.control.hang = (id, before) => id === "A" && before !== null;
    act(() => void hook.result.current.loadEarlier());
    await run(20);
    hook.rerender({ id: "B", rev: 0 });
    await run(20);
    expect(hook.result.current.loaded).toBe(true);
    expect(ids(hook)).toEqual(["m5", "m6"]);
  });

  it("let Earlier messages go on when a read for a signal never answered and a newer one landed", async () => {
    const s = serve();
    const hook = await opened(s);
    s.control.hang = (_id, before) => before === null;
    hook.rerender({ id: "A", rev: 1 });
    await run(20);
    act(() => void hook.result.current.loadEarlier());
    await run(20);
    s.control.hang = () => false;
    hook.rerender({ id: "A", rev: 2 });
    await run(LANDING_WAIT_MS + 100);
    expect(hook.result.current.loadingEarlier).toBe(false);
    expect(ids(hook)).toEqual(["m3", "m4", "m5", "m6"]);
  });

  it("show the live update of a conversation within the bound, though an earlier page of it is still out", async () => {
    const s = serve();
    const hook = await opened(s);
    s.control.hang = (_id, before) => before !== null;
    act(() => void hook.result.current.loadEarlier());
    await run(20);
    s.all.push(row("m7"));
    s.control.hang = () => false;
    hook.rerender({ id: "A", rev: 1 });
    await run(LANDING_WAIT_MS + 100);
    expect(ids(hook)).toContain("m7");
  });

  it("answer Earlier messages within the bound while signals keep coming faster than they are read", async () => {
    const s = serve();
    const hook = await opened(s);
    s.control.delay = 250;
    let rev = 0;
    const signal = async () => {
      await run(100);
      rev += 1;
      act(() => hook.rerender({ id: "A", rev }));
    };
    for (let i = 0; i < 4; i++) await signal();
    const t0 = Date.now();
    let answered = -1;
    act(() => void hook.result.current.loadEarlier().then(() => (answered = Date.now() - t0)));
    for (let i = 0; i < 30; i++) await signal();
    expect(answered).toBeGreaterThan(0);
    expect(answered).toBeLessThan(LANDING_WAIT_MS + 500);
  });

  it("let an old Earlier messages that waited through a switch away and back do nothing, so the page is not loaded twice", async () => {
    const s = serve();
    const landing = new Landing();
    const hook = renderHook(({ id, rev }) => useConversation(s.api, id, rev, landing), { initialProps: { id: "A", rev: 0 } });
    await run(0);
    await act(async () => void (await hook.result.current.loadEarlier()));
    let release: () => void = () => undefined;
    void landing.run(() => new Promise((done) => (release = () => done(null))), () => () => undefined);
    hook.rerender({ id: "A", rev: 1 });
    await run(20);
    act(() => void hook.result.current.loadEarlier());
    await run(20);
    hook.rerender({ id: "B", rev: 1 });
    await run(20);
    hook.rerender({ id: "A", rev: 1 });
    await run(20);
    release();
    await run(20);
    expect(ids(hook)).toEqual(["m5", "m6"]);
    s.conversationMessages.mockClear();
    await act(async () => void (await hook.result.current.loadEarlier()));
    await run(20);
    expect(ids(hook)).toEqual(["m3", "m4", "m5", "m6"]);
    expect(s.conversationMessages.mock.calls.filter(([, o]) => o?.before).length).toBe(1);
  });
});
