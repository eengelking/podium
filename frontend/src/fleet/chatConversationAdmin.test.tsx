// #1296: an Admin's open conversation says every 15 seconds that it is still being read, only once a read has landed, and the people in it see the reading by the
// server's clock, never the page's. The notice and its keep-alive are the guardrail for an Admin read (PROJECT.md, "An Admin never reads in silence"), so they are held here.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { ChatConversation } from "./components/ChatConversation";
import { Landing } from "./landing";
import { RespondError } from "./respondApi";
import type { ChatApi, ChatOverview, ConversationInfo, ConversationMessage } from "./chatData";

const ID = "cnv_1";
const T0 = new Date(2026, 9, 12, 14, 30).getTime();
type Reading = { admin: string; since: number; until: number };

const info = (reading: Reading[]): ConversationInfo => ({
  id: ID,
  thread: `convo:${ID}`,
  members: [
    { kind: "person", name: "Ed", you: true, addedBy: null, address: "Ed@console", sessionId: null },
    { kind: "agent", name: "api", you: false, addedBy: "Ed", address: null, sessionId: "s1" },
  ],
  hasAgent: true,
  unread: 0,
  mentions: 0,
  messages: 1,
  lastAt: T0,
  adminReading: reading,
});

const msg: ConversationMessage = { id: "m1", author: { kind: "person", name: "Ed", you: true }, text: "hi", createdAt: T0, editedAt: null, deletedAt: null, replyTo: null, canChange: false, changeWhy: null, deliveries: [] };

/** The page's props, with the conversation read as `read` answers (the usual page by default). */
function setup(readAs: string | null, reading: Reading[], now: number, serverNow: number, read?: () => Promise<unknown>) {
  const conversationMessages = vi.fn(read ?? (async () => ({ ok: true as const, conversation: info(reading), messages: [msg], older: null, total: 1, adminReads: [] })));
  const api = { conversationMessages, readingConversation: vi.fn(async () => ({ ok: true as const })), markRead: vi.fn(async () => ({})) };
  const overview = { me: { name: "Root", admin: true, person: false }, conversations: [info(reading)], channels: [], directs: [] } as unknown as ChatOverview;
  const props = { api: api as unknown as ChatApi, id: ID, overview, sessions: {}, rev: 0, now, serverNow, landing: new Landing(), readAs, members: false, onMembers: () => {}, onBack: () => {}, onGone: () => {}, onAdd: () => {}, onChanged: async () => {}, onSaid: () => {} };
  return { api, props };
}

const settle = (ms = 50) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("an Admin's open conversation", () => {
  it("says it is read as an Admin, and pings every 15 seconds from the first read that landed", async () => {
    vi.useFakeTimers();
    const { api, props } = setup("Maya", [], T0, T0);
    render(<ChatConversation {...props} />);
    await settle();
    expect(screen.getByText(/as an Admin. You cannot send here./)).toBeInTheDocument();
    expect(api.readingConversation).not.toHaveBeenCalled();
    await settle(15_000);
    expect(api.readingConversation).toHaveBeenCalledTimes(1);
    expect(api.readingConversation).toHaveBeenCalledWith(ID);
    await settle(15_000);
    expect(api.readingConversation).toHaveBeenCalledTimes(2);
  });

  it("does not ping while the first read has not landed, or when it failed", async () => {
    vi.useFakeTimers();
    const hung = setup("Maya", [], T0, T0, () => new Promise(() => undefined));
    render(<ChatConversation {...hung.props} />);
    await settle(40_000);
    expect(hung.api.readingConversation).not.toHaveBeenCalled();
    cleanup();
    const failed = setup("Maya", [], T0, T0, async () => {
      throw new RespondError(500, { ok: false, error: "the store is busy" });
    });
    render(<ChatConversation {...failed.props} />);
    await settle(40_000);
    expect(failed.api.readingConversation).not.toHaveBeenCalled();
  });

  it("shows the person the Admin reading by the server's clock: a page clock far ahead keeps it, a server clock past its end hides it", async () => {
    vi.useFakeTimers();
    const live = [{ admin: "Root", since: T0, until: T0 + 30_000 }];
    const shown = setup(null, live, T0 + 1000, T0 + 10_000);
    render(<ChatConversation {...shown.props} />);
    await settle();
    expect(screen.getByTestId("chat-tag-reading")).toBeInTheDocument();
    cleanup();
    const pageAhead = setup(null, live, T0 + 999_000, T0 + 10_000);
    render(<ChatConversation {...pageAhead.props} />);
    await settle();
    expect(screen.getByTestId("chat-tag-reading")).toBeInTheDocument();
    cleanup();
    const ended = setup(null, live, T0 + 1000, T0 + 40_000);
    render(<ChatConversation {...ended.props} />);
    await settle();
    expect(screen.queryByTestId("chat-tag-reading")).toBeNull();
  });
});
