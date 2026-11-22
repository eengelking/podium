// #1296: the open conversation of people and agents reads the way a channel's thread does. It shares the page's Landing, keeps a message that did not
// change as the same object, and reads the earlier pages the person loaded again on a signal, so an edit or a delete made on another console in one of
// them shows. Against a fake server that keeps what it is told, as chatEditDelete.test.tsx's "live refresh of earlier pages" has.
import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Landing } from "./landing";
import { RespondError } from "./respondApi";
import { useChatOverview, useConversation, useLanding } from "./useChat";
import type { AdminRead, ChatApi, ChatOverview, ConversationInfo, ConversationMessage } from "./chatData";

const ID = "cnv_1";
const T0 = new Date(2026, 9, 12, 14, 30).getTime();
const MIN = 60_000;

const INFO: ConversationInfo = {
  id: ID,
  thread: `convo:${ID}`,
  members: [
    { kind: "person", name: "Ed", you: true, addedBy: null, address: "Ed@console", sessionId: null },
    { kind: "person", name: "Maya", you: false, addedBy: "Ed", address: "Maya@console", sessionId: null },
  ],
  hasAgent: false,
  unread: 0,
  mentions: 0,
  messages: 6,
  lastAt: T0,
  adminReading: [],
};

/** The higher the number, the newer. */
const row = (id: string, text: string, over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id,
  author: { kind: "person", name: "Maya", you: false },
  text,
  createdAt: T0 - (9 - Number(id.slice(1))) * MIN,
  editedAt: null,
  deletedAt: null,
  replyTo: null,
  canChange: false,
  changeWhy: null,
  deliveries: [],
  ...over,
});

/** A server with six messages, m1 the oldest, read two at a time, newest page first. Every answer is a copy, as a network answer is. */
function paged() {
  const all: ConversationMessage[] = ["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => row(id, `text ${id}`));
  const asc = () => [...all].sort((a, b) => a.createdAt - b.createdAt);
  const conversationMessages = vi.fn(async (_id: string, o: { before?: string | null; limit?: number } = {}) => {
    const list = asc();
    const end = o.before ? list.findIndex((m) => m.id === o.before) : list.length;
    const start = Math.max(0, end - 2);
    return { ok: true as const, conversation: structuredClone(INFO), messages: structuredClone(list.slice(start, end)), older: start > 0 ? list[start]!.id : null, total: list.length, adminReads: [] as AdminRead[] };
  });
  return { all, conversationMessages, api: { conversationMessages } as unknown as ChatApi };
}

const ids = (r: { current: { messages: { id: string }[] } }) => r.current.messages.map((m) => m.id);
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));

async function loaded(s: ReturnType<typeof paged>, pages: number) {
  const landing = new Landing();
  const hook = renderHook(({ rev }) => useConversation(s.api, ID, rev, landing), { initialProps: { rev: 0 } });
  await waitFor(() => expect(hook.result.current.loaded).toBe(true));
  for (let i = 0; i < pages; i++) await act(async () => void (await hook.result.current.loadEarlier()));
  return hook;
}

describe("the open conversation after a signal", () => {
  it("reads the newest page when it opens and again when the signal moves, and shows what each returned", async () => {
    const s = paged();
    const { result, rerender } = await loaded(s, 0);
    expect(ids(result)).toEqual(["m5", "m6"]);
    expect(result.current.total).toBe(6);
    expect(result.current.info?.id).toBe(ID);
    s.all.push(row("m7", "newest"));
    rerender({ rev: 1 });
    await waitFor(() => expect(ids(result)).toEqual(["m6", "m7"]));
    expect(result.current.total).toBe(7);
    expect(s.conversationMessages).toHaveBeenCalledTimes(2);
  });

  it("shows an edit and a delete made in an earlier page that is already loaded, without a reload", async () => {
    const s = paged();
    const { result, rerender } = await loaded(s, 2);
    expect(ids(result)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(result.current.older).toBeNull();
    // Another console changes a message in the oldest page and deletes one in the middle one.
    s.all[0] = row("m1", "text m1, edited", { editedAt: T0 });
    s.all[2] = row("m3", "", { deletedAt: T0 });
    rerender({ rev: 1 });
    await waitFor(() => expect(result.current.messages.find((m) => m.id === "m1")?.text).toBe("text m1, edited"));
    expect(result.current.messages.find((m) => m.id === "m3")?.deletedAt).toBe(T0);
    expect(ids(result)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(result.current.total).toBe(6);
    expect(result.current.older).toBeNull();
  });

  it("reads one request more for each earlier page it kept, and none for a conversation with none", async () => {
    const s = paged();
    const { result, rerender } = await loaded(s, 0);
    s.conversationMessages.mockClear();
    rerender({ rev: 1 });
    await waitFor(() => expect(s.conversationMessages).toHaveBeenCalledTimes(1));
    await settle();
    await act(async () => void (await result.current.loadEarlier()));
    s.conversationMessages.mockClear();
    rerender({ rev: 2 });
    await waitFor(() => expect(s.conversationMessages).toHaveBeenCalledTimes(2));
    await settle();
    expect(ids(result)).toEqual(["m3", "m4", "m5", "m6"]);
  });

  it("keeps the earlier pages, and loses none off the old end, when a new message arrives", async () => {
    const s = paged();
    const { result, rerender } = await loaded(s, 1);
    expect(ids(result)).toEqual(["m3", "m4", "m5", "m6"]);
    s.all.push(row("m7", "newest"));
    rerender({ rev: 1 });
    await waitFor(() => expect(result.current.total).toBe(7));
    await waitFor(() => expect(ids(result)).toEqual(["m2", "m3", "m4", "m5", "m6", "m7"]));
    expect(result.current.older).toBe("m2");
  });

  it("drops the earlier pages when the conversation now holds fewer messages than are shown", async () => {
    const s = paged();
    const { result, rerender } = await loaded(s, 1);
    expect(ids(result)).toEqual(["m3", "m4", "m5", "m6"]);
    s.all.splice(0, s.all.length, row("m7", "after the clear"));
    rerender({ rev: 1 });
    await waitFor(() => expect(ids(result)).toEqual(["m7"]));
    expect(result.current.total).toBe(1);
    expect(result.current.older).toBeNull();
  });

  it("keeps the message objects that did not change, so a memoized row is not drawn again, and replaces the one that did", async () => {
    const s = paged();
    const { result, rerender } = await loaded(s, 1);
    const was = new Map(result.current.messages.map((m) => [m.id, m]));
    s.all[3] = row("m4", "text m4, edited", { editedAt: T0 });
    s.all.push(row("m7", "newest"));
    rerender({ rev: 1 });
    await waitFor(() => expect(result.current.total).toBe(7));
    await waitFor(() => expect(ids(result)).toEqual(["m2", "m3", "m4", "m5", "m6", "m7"]));
    for (const id of ["m3", "m5", "m6"]) expect(result.current.messages.find((m) => m.id === id)).toBe(was.get(id));
    expect(result.current.messages.find((m) => m.id === "m4")).not.toBe(was.get("m4"));
    expect(result.current.messages.find((m) => m.id === "m4")?.text).toBe("text m4, edited");
  });
});

describe("what the open conversation keeps between reads", () => {
  it("puts an edited message in place at once, in whichever page holds it, and a later read keeps it", async () => {
    const s = paged();
    const { result, rerender } = await loaded(s, 1);
    act(() => result.current.patch(row("m3", "text m3, edited here", { editedAt: T0 })));
    act(() => result.current.patch(row("m6", "text m6, edited here", { editedAt: T0 })));
    expect(result.current.messages.map((m) => m.text)).toEqual(["text m3, edited here", "text m4", "text m5", "text m6, edited here"]);
    act(() => result.current.patch(row("m9", "not loaded")));
    expect(ids(result)).toEqual(["m3", "m4", "m5", "m6"]);
    s.all[2] = row("m3", "text m3, edited here", { editedAt: T0 });
    s.all[5] = row("m6", "text m6, edited here", { editedAt: T0 });
    rerender({ rev: 1 });
    await settle();
    expect(result.current.messages.map((m) => m.text)).toEqual(["text m3, edited here", "text m4", "text m5", "text m6, edited here"]);
  });

  it("carries the Admin reads the newest page came with, and none when it came with none", async () => {
    const s = paged();
    const read = { admin: "Root", startedAt: T0, lastSeenAt: T0 };
    s.conversationMessages.mockImplementationOnce(async () => ({ ok: true as const, conversation: structuredClone(INFO), messages: [row("m6", "text m6")], older: null, total: 1, adminReads: [read] }));
    const { result, rerender } = await loaded(s, 0);
    expect(result.current.reads).toEqual([read]);
    rerender({ rev: 1 });
    await waitFor(() => expect(result.current.reads).toEqual([]));
  });

  it("says why earlier messages could not be read, and takes no second request while one is out", async () => {
    const s = paged();
    const { result } = await loaded(s, 0);
    s.conversationMessages.mockClear();
    s.conversationMessages.mockRejectedValueOnce(new RespondError(500, { ok: false, error: "the store is busy" }));
    await act(async () => void (await result.current.loadEarlier()));
    expect(result.current.error?.text).toContain("the store is busy");
    expect(result.current.loadingEarlier).toBe(false);
    expect(ids(result)).toEqual(["m5", "m6"]);
    let answer!: () => void;
    s.conversationMessages.mockImplementationOnce(() => new Promise((done) => (answer = () => done({ ok: true as const, conversation: INFO, messages: [row("m3", "text m3"), row("m4", "text m4")], older: null, total: 6, adminReads: [] }))));
    s.conversationMessages.mockClear();
    let first!: Promise<void>;
    act(() => void (first = result.current.loadEarlier()));
    await waitFor(() => expect(result.current.loadingEarlier).toBe(true));
    await act(async () => void (await result.current.loadEarlier()));
    expect(s.conversationMessages).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer();
      await first;
    });
    expect(ids(result)).toEqual(["m3", "m4", "m5", "m6"]);
    expect(result.current.error).toBeNull();
  });

  it("shows nothing of the old conversation under another one", async () => {
    const s = paged();
    const landing = new Landing();
    const hook = renderHook(({ id }) => useConversation(s.api, id, 0, landing), { initialProps: { id: ID } });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    expect(ids(hook.result)).toEqual(["m5", "m6"]);
    s.conversationMessages.mockImplementationOnce(() => new Promise(() => undefined));
    hook.rerender({ id: "cnv_2" });
    expect(hook.result.current.loaded).toBe(false);
    expect(hook.result.current.messages).toEqual([]);
    expect(hook.result.current.info).toBeNull();
    expect(hook.result.current.total).toBe(0);
  });

  it("does not put the earlier page of the old conversation under another one when it lands after the switch", async () => {
    const s = paged();
    const landing = new Landing();
    const hook = renderHook(({ id }) => useConversation(s.api, id, 0, landing), { initialProps: { id: ID } });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    let land: () => void = () => undefined;
    const held = new Promise<void>((r) => (land = r));
    const real = s.conversationMessages.getMockImplementation()!;
    s.conversationMessages.mockImplementationOnce(async (...a: Parameters<typeof real>) => {
      const out = await real(...a);
      await held;
      return out;
    });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hook.result.current.loadEarlier();
    });
    await settle();
    s.conversationMessages.mockImplementationOnce(() => new Promise(() => undefined));
    hook.rerender({ id: "cnv_2" });
    await act(async () => {
      land();
      await pending;
    });
    expect(hook.result.current.messages).toEqual([]);
    expect(hook.result.current.older).toBeNull();
    expect(hook.result.current.loadingEarlier).toBe(false);
  });

  it("keeps the page Earlier messages loaded while a read for a signal waits in the Landing, and the result of that read", async () => {
    const s = paged();
    const landing = new Landing();
    const hook = renderHook(({ rev }) => useConversation(s.api, ID, rev, landing), { initialProps: { rev: 0 } });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    await act(async () => void (await hook.result.current.loadEarlier()));
    expect(ids(hook.result)).toEqual(["m3", "m4", "m5", "m6"]);
    let release: () => void = () => undefined;
    void landing.run(() => new Promise((done) => (release = () => done(null))), () => () => undefined);
    s.all.push(row("m7", "newest"));
    s.all[3] = row("m4", "text m4, edited", { editedAt: T0 });
    hook.rerender({ rev: 1 });
    await settle();
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hook.result.current.loadEarlier();
    });
    await settle();
    await act(async () => {
      release();
      await pending;
    });
    await waitFor(() => expect(ids(hook.result)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7"]));
    expect(hook.result.current.messages.find((m) => m.id === "m4")?.text).toBe("text m4, edited");
    expect(hook.result.current.older).toBeNull();
    expect(hook.result.current.loadingEarlier).toBe(false);
  });

  it("says why a read failed, keeps what was shown, and reads again on the next signal", async () => {
    const s = paged();
    const { result, rerender } = await loaded(s, 0);
    s.conversationMessages.mockRejectedValueOnce(new RespondError(404, { ok: false, error: "There is no such conversation." }));
    rerender({ rev: 1 });
    await waitFor(() => expect(result.current.error?.status).toBe(404));
    expect(result.current.error?.text).toContain("no such conversation");
    expect(ids(result)).toEqual(["m5", "m6"]);
    rerender({ rev: 2 });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(ids(result)).toEqual(["m5", "m6"]);
  });

  it("does not let a read that a newer one replaced land after it", async () => {
    const all = [row("m5", "old text"), row("m6", "old text")];
    const answers: (() => void)[] = [];
    let wait = false;
    const conversationMessages = vi.fn(async () => {
      const page = { ok: true as const, conversation: INFO, messages: structuredClone(all), older: null, total: all.length, adminReads: [] };
      return wait ? new Promise<typeof page>((done) => answers.push(() => done(page))) : page;
    });
    const landing = new Landing();
    const api = { conversationMessages } as unknown as ChatApi;
    const hook = renderHook(({ rev }) => useConversation(api, ID, rev, landing), { initialProps: { rev: 0 } });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    wait = true;
    hook.rerender({ rev: 1 });
    await settle();
    all[1] = row("m6", "new text");
    hook.rerender({ rev: 2 });
    await settle();
    expect(answers).toHaveLength(2);
    // The first read answers with the page as it was when it was asked, and last.
    answers[1]!();
    await settle();
    answers[0]!();
    await settle();
    expect(hook.result.current.messages.map((m) => m.text)).toEqual(["old text", "new text"]);
  });
});

describe("the open conversation and the overview after one signal", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const overview = (n: number) => ({ enabled: true, serverTime: 1000 + n, me: { id: 1, name: "Ed", admin: false, person: true }, channels: [], directs: [], agents: [], people: [], version: n }) as unknown as ChatOverview;

  it("draws the new overview and the new conversation in one render, whichever answers first", async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      for (const delays of [{ overview: 5, thread: 40 }, { overview: 40, thread: 5 }]) {
        let n = 0;
        const api = {
          overview: vi.fn(async () => {
            await sleep(delays.overview);
            return overview(n);
          }),
          conversationMessages: vi.fn(async () => {
            await sleep(delays.thread);
            return { ok: true as const, conversation: INFO, messages: Array.from({ length: n + 1 }, (_, i) => row(`m${i}`, `m${i}`)), older: null, total: n + 1, adminReads: [] };
          }),
        } as unknown as ChatApi;
        const seen: { overview: number; thread: number }[] = [];
        const host = renderHook(
          ({ rev }) => {
            const landing = useLanding();
            const o = useChatOverview(api, true, rev, null, landing);
            const t = useConversation(api, ID, rev, landing);
            seen.push({ overview: (o.data as unknown as { version: number } | null)?.version ?? -1, thread: t.messages.length });
          },
          { initialProps: { rev: 0 } },
        );
        await act(async () => {
          await sleep(120);
        });
        const before = seen.length;
        n++;
        host.rerender({ rev: 1 });
        await sleep(160);
        const after = seen.slice(before);
        // One render for the new signal itself, and one for both answers; no render has the new overview with the old conversation, or the reverse.
        expect(after).toHaveLength(2);
        expect(after[1]).toEqual({ overview: 1, thread: 2 });
        expect(after.every((x) => (x.overview === 1) === (x.thread === 2))).toBe(true);
        host.unmount();
      }
    } finally {
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    }
  });
});
