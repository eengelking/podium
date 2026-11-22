// #1296: Earlier messages and the reads for signals, with every request they make released in a random order, still show every message once and in order, and
// leave the cursor and the total right. The seeds are fixed, so a failure repeats. Against a fake server that holds its answers back until the test releases them.
import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Landing } from "./landing";
import { useConversation } from "./useChat";
import type { ChatApi, ConversationInfo, ConversationMessage } from "./chatData";

const ID = "cnv_1";
const T0 = new Date(2026, 9, 12, 14, 30).getTime();
const INFO = { id: ID, thread: `convo:${ID}`, members: [], hasAgent: false, unread: 0, mentions: 0, messages: 6, lastAt: T0, adminReading: [] } as unknown as ConversationInfo;
const row = (id: string, text: string): ConversationMessage => ({ id, author: { kind: "person", name: "Maya", you: false }, text, createdAt: T0 + Number(id.slice(1)) * 1000, editedAt: null, deletedAt: null, replyTo: null, canChange: false, changeWhy: null, deliveries: [] }) as ConversationMessage;

function server() {
  const all = ["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => row(id, `text ${id}`));
  let hold = false;
  const pending: { before: string | null; go: () => void }[] = [];
  const conversationMessages = vi.fn((_id: string, o: { before?: string | null } = {}) => {
    const list = [...all].sort((a, b) => a.createdAt - b.createdAt);
    const end = o.before ? list.findIndex((m) => m.id === o.before) : list.length;
    const start = Math.max(0, end - 2);
    const out = { ok: true as const, conversation: structuredClone(INFO), messages: structuredClone(list.slice(start, end)), older: start > 0 ? list[start]!.id : null, total: list.length, adminReads: [] };
    if (!hold) return Promise.resolve(out);
    return new Promise((r) => pending.push({ before: o.before ?? null, go: () => r(out) }));
  });
  return { all, pending, hold: (h: boolean) => (hold = h), api: { conversationMessages } as unknown as ChatApi };
}

const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("Earlier messages and signals in a random order", () => {
  // Seeds 1 to 4, and the 17 of the first 100 that failed when Earlier messages did not wait for a read for a signal, so the interleavings that matter stay covered.
  for (const seed of [1, 2, 3, 4, 39, 42, 44, 49, 54, 59, 64, 69, 74, 76, 79, 84, 86, 89, 94, 98, 99]) {
    it(`loadEarlier + signals released in random order, seed ${seed}`, async () => {
      const s = server();
      const landing = new Landing();
      const hook = renderHook(({ rev }) => useConversation(s.api, ID, rev, landing), { initialProps: { rev: 0 } });
      await waitFor(() => expect(hook.result.current.loaded).toBe(true));
      await act(async () => void (await hook.result.current.loadEarlier()));
      s.hold(true);
      s.all.push(row("m7", "m7"));
      hook.rerender({ rev: 1 });
      await tick();
      const rand = rng(seed);
      // when (after how many releases) the click and the second signal come; 9 = never
      const clickAt = Math.floor(rand() * 4);
      const sigAt = seed % 5 === 4 ? 99 : Math.floor(rand() * 5);
      let l: Promise<void> = Promise.resolve();
      let clicked = false;
      let signalled = false;
      let last = 7;
      const maybe = async (n: number) => {
        if (!clicked && n >= clickAt) {
          clicked = true;
          act(() => {
            l = hook.result.current.loadEarlier();
          });
          await tick();
        }
        if (!signalled && n >= sigAt) {
          signalled = true;
          s.all.push(row("m8", "m8"));
          last = 8;
          hook.rerender({ rev: 2 });
          await tick();
        }
      };
      await maybe(0);
      for (let i = 0; i < 120; i++) {
        await maybe(i);
        if (s.pending.length === 0) {
          await tick();
          if (s.pending.length === 0 && clicked && (signalled || sigAt === 99)) break;
        }
        if (s.pending.length === 0) continue;
        const k = Math.floor(rand() * s.pending.length);
        const [c] = s.pending.splice(k, 1);
        await act(async () => {
          c!.go();
          await new Promise((r) => setTimeout(r, 3));
        });
      }
      await act(async () => void (await l));
      await waitFor(() => expect(hook.result.current.loadingEarlier).toBe(false), { timeout: 4000 });
      const want = Array.from({ length: last }, (_, i) => `m${i + 1}`);
      expect(hook.result.current.messages.map((m) => m.id)).toEqual(want);
      expect(hook.result.current.older).toBeNull();
      expect(hook.result.current.total).toBe(last);
    });
  }
});
